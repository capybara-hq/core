import { createHmac, randomUUID } from "node:crypto";
import {
  type Channel,
  SETUP_CHECK_LIMITS,
  type SetupCheckArgs,
  type SetupCheckResult,
  type SetupCheckTarget,
  type SetupCheckText,
  validateSetupCheckResult,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ChannelConnections } from "../channels/connections.service.js";
import { secretValues } from "../config/fields.js";
import type { Keyring } from "../ctx/secrets.js";
import { ApiError } from "../errors.js";
import { EffectiveConfigs } from "../extensions/effective-config.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { deepFreeze } from "../extensions/hooks.js";
import { OrgExtensionConfigs } from "../extensions/org-config.js";
import { PluginGuides } from "../extensions/plugin-guides.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER, KEYRING, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import type { OrgRole } from "../orgs/roles.js";
import { readOrgSettings } from "../orgs/settings.service.js";
import type { ConnectorAuth } from "../tools/credentials.js";
import { Credentials } from "../tools/credentials.js";
import { checkRedactor, describeCheckError, redactCheckResult } from "./redact-check.js";
import {
  type KernelCheckArgs,
  type KernelCheckTarget,
  type ResolvedSetupCheck,
  SetupCheckRegistry,
  type SetupCheckState,
} from "./setup-check-registry.js";

/** Optional provider: the per-run time limit (ms) instead of `SETUP_CHECK_LIMITS.timeoutMs` (tests). */
export const SETUP_CHECK_TIMEOUT = Symbol("SETUP_CHECK_TIMEOUT");

/** The single-flight lock outlives the run's time limit, so it never expires under a live run. */
const LOCK_TTL_MS = 15_000;
/** A slot of the org's concurrency semaphore frees itself after this (a crashed replica's). */
const SLOT_TTL_MS = 15_000;
/** Runs per account and window, the HTTP route and the `Platform` tool together (spec §10.3). */
const RUN_LIMIT = 30;
const RUN_WINDOW_MS = 60_000;

/**
 * One atomic step of the per-account run counter: at the limit the attempt is refused and not
 * counted (the window ends on schedule); otherwise the counter is incremented and always carries
 * a TTL. KEYS[1] the counter; ARGV: window ms, limit. Returns 1 when allowed.
 */
const RUN_RATE_LUA = `local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n >= tonumber(ARGV[2]) then
  if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
  return 0
end
redis.call('INCR', KEYS[1])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return 1`;

/** Who asks: the org, their role in it and their account. */
export interface CheckCaller {
  orgId: string;
  role: OrgRole;
  accountId: string;
}

/** The guide the checks belong to: mode, audience and target, as the guide route takes them. */
export interface CheckSelection {
  mode?: string | undefined;
  audience?: "admin" | "member" | undefined;
  connectionId?: string | undefined;
  connectorId?: string | undefined;
}

const text = (en: string, zh: string): SetupCheckText => ({ en, zh });

/** The kernel's own reasons (results the kernel answers instead of a check; never extension text). */
const REASONS = {
  unavailable: text(
    "Checks are temporarily unavailable; retry later.",
    "检查暂时不可用，请稍后重试。",
  ),
  notRunning: (plugin: string) =>
    text(
      `The ${plugin} plugin is not running on this server right now; retry later.`,
      `插件 ${plugin} 此刻没有在这台服务器上运行，请稍后重试。`,
    ),
  disabled: (plugin: string) =>
    text(
      `The ${plugin} plugin is not enabled in this organization; an org admin enables it under Plugins.`,
      `插件 ${plugin} 没有在本组织启用；组织管理员可以在「插件」里启用。`,
    ),
  needsConfig: (plugin: string) =>
    text(
      `The ${plugin} plugin needs configuration in this organization; an org admin configures it under Plugins.`,
      `插件 ${plugin} 需要在本组织完成配置；组织管理员可以在「插件」里配置。`,
    ),
  unregistered: text(
    "This check needs a newer version of the plugin.",
    "这项检查需要更新版本的插件。",
  ),
  otherPlace: text("This check does not apply on this page.", "这项检查不适用于本页面。"),
  failed: text("The check failed to run; retry later.", "检查运行失败，请稍后重试。"),
  timedOut: text("The check timed out.", "检查超时。"),
  invalid: text(
    "The check returned an invalid result; retry later or update the plugin.",
    "检查返回的结果无效；请稍后重试或更新插件。",
  ),
  targetGone: text(
    "The connection's stored settings could not be read; save them again.",
    "无法读取这个连接已保存的设置，请重新保存。",
  ),
} as const;

const unknownState = (reason: SetupCheckText): SetupCheckState => ({ status: "unknown", reason });

/** A cached result as stored in Redis. */
interface CachedResult {
  result: SetupCheckResult;
  fingerprint: string;
  checkedAt: string;
}

/** The Redis keys of one check of one target (spec §10.7); every one is written with a TTL. */
interface CheckKeys {
  result: string;
  cooldown: string;
  lock: string;
}

/** What a prepared request knows: the rendered guide and its target. */
interface Prepared {
  caller: CheckCaller;
  plugin: string;
  itemId: string;
  version: string;
  place: "channel-connection" | "connector-template";
  mode: string | null;
  audience: "admin" | "member";
  target: { kind: "channel-connection" | "connector"; id: string };
  checks: string[];
  /** Cache keys carry the account (member audience: every member's own answer). */
  perAccount: boolean;
}

/**
 * Whether a check's cache keys and fingerprint carry the caller's account: every check of the
 * member audience, and every kernel check (it gets the caller's account whatever the audience,
 * so one admin's answer is never another admin's).
 */
const accountScoped = (p: Prepared, checkId: string): boolean =>
  p.perAccount || checkId.startsWith("capybara:");

/** Target material loaded for one run (after authorization and the lock). */
interface Material {
  secrets: string[];
  /** The connector's manual OAuth client id (connector targets). */
  clientId?: string | null;
  templateId?: string;
}

/** The fixed fields of a state: nothing else leaves the kernel. */
function stateOf(r: SetupCheckResult, checkedAt?: string, cooldownUntil?: string): SetupCheckState {
  return {
    status: r.status,
    ...(r.reason !== undefined && { reason: copyText(r.reason) }),
    ...(r.fix !== undefined && { fix: copyText(r.fix) }),
    ...(checkedAt !== undefined && { checkedAt }),
    ...(cooldownUntil !== undefined && { cooldownUntil }),
  };
}

const copyText = (t: SetupCheckText): SetupCheckText => ({
  en: t.en,
  ...(t.zh !== undefined && { zh: t.zh }),
});

const isValid = (r: SetupCheckResult | { problem: string }): r is SetupCheckResult =>
  !("problem" in r);

/**
 * Setup checks (spec 2026-11-09-setup-guides-v2-design.md §10): reads the cached state of a
 * guide's checks and runs one on request. Authorization is the guide route's (catalog visibility,
 * then the place and audience action, then the target, all through `PluginGuides.render`) before
 * any target is loaded; the check must be in the guide rendered for that mode and audience.
 *
 * Multi-replica (§10.7): results, cooldowns, the single-flight lock and the org's concurrency
 * semaphore live in Redis, every key with a TTL, none touched inside a transaction; nothing is in
 * process memory. A run takes `capk:setup-check-run:<key>` (`LockService.lease`, 15 s, longer than
 * the 10 s time limit) and a slot of `capk:setup-check-org:<orgId>` (8, self-expiring), and frees
 * both on every path. Runs are limited per account (`capk:setup-check-rate:<accountId>`, 30 a
 * minute, 429 `rate_limited`) here, so the HTTP route and the `Platform` tool share one budget.
 * A check runs on the replica that took the lock, in the extension loaded
 * there, raced against `AbortSignal.any([timeout, ctx.signal])` so one that ignores its signal
 * still answers `unknown` at the limit (its late settle is dropped).
 *
 * Results never leak secrets (§10.8): a result is validated, redacted by every secret value the
 * kernel knows for the target and the extension's config (the plugin's own, the connector's
 * stored credentials it never got, the platform and the org's effective deployment config) and
 * validated again; only that output is cached and returned. A throw, a timeout or an invalid
 * result is `unknown` with a kernel reason; only the redacted problem or error message is logged.
 */
@Injectable()
export class SetupChecksService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(REDIS)
    private readonly redis: Pick<Redis, "get" | "set" | "pttl" | "mget" | "exists" | "eval">,
    @Inject(LockService)
    private readonly locks: Pick<LockService, "lease" | "releaseIf" | "takeSlot" | "releaseSlot">,
    @Inject(KEYRING) private readonly keyring: Keyring,
    @Inject(PluginGuides) private readonly guides: Pick<PluginGuides, "render">,
    @Inject(SetupCheckRegistry) private readonly registry: SetupCheckRegistry,
    @Inject(ExtensionRegistry) private readonly extensions: Pick<ExtensionRegistry, "current">,
    @Inject(EffectiveConfigs) private readonly effective: Pick<EffectiveConfigs, "get">,
    @Inject(OrgExtensionConfigs) private readonly orgConfigs: Pick<OrgExtensionConfigs, "get">,
    @Inject(ChannelConnections)
    private readonly channels: Pick<
      ChannelConnections,
      "checkRevision" | "checkSecrets" | "runtime"
    >,
    @Inject(Credentials)
    private readonly credentials: Pick<Credentials, "checkRevision" | "checkMaterial">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "warn">,
    @Optional()
    @Inject(SETUP_CHECK_TIMEOUT)
    private readonly timeoutMs: number = SETUP_CHECK_LIMITS.timeoutMs,
  ) {}

  /**
   * The cached state of every check of the rendered guide (`GET …/checks`), by check id; nothing
   * runs. `not_run` without a fresh result for the current input fingerprint; `running` while a
   * run holds the lock. Redis down: every row `unknown` ("temporarily unavailable").
   */
  async states(
    caller: CheckCaller,
    itemId: string,
    guideId: string,
    q: CheckSelection,
  ): Promise<Record<string, SetupCheckState>> {
    const p = await this.prepare(caller, itemId, guideId, q);
    const ids = [...new Set(p.checks)];
    const out: Record<string, SetupCheckState> = {};
    if (ids.length === 0) return out;
    // at most two fingerprints: the shared one and the caller's own (account-scoped checks)
    const prints = new Map<boolean, string>();
    const fingerprints: string[] = [];
    for (const id of ids) {
      const scoped = accountScoped(p, id);
      let fp = prints.get(scoped);
      if (fp === undefined) {
        fp = this.fingerprint(p, await this.revision(p, scoped));
        prints.set(scoped, fp);
      }
      fingerprints.push(fp);
    }
    const keys = ids.map((id) => this.keys(p, id));
    let cached: (string | null)[];
    let locked: number[];
    let cooldowns: number[];
    try {
      cached = await this.redis.mget(...keys.map((k) => k.result));
      locked = await Promise.all(keys.map((k) => this.redis.exists(k.lock)));
      cooldowns = await Promise.all(keys.map((k) => this.redis.pttl(k.cooldown)));
    } catch (err) {
      this.log.warn("setup checks: Redis unavailable", { err: describeCheckError(err, (s) => s) });
      for (const id of ids) out[id] = unknownState(REASONS.unavailable);
      return out;
    }
    ids.forEach((id, i) => {
      const c = parseCached(cached[i] ?? null);
      const cooldown = cooldowns[i] ?? -2;
      const until = cooldown > 0 ? new Date(Date.now() + cooldown).toISOString() : undefined;
      if (locked[i] === 1) out[id] = { status: "running" };
      else if (c && c.fingerprint === fingerprints[i]) {
        out[id] = stateOf(c.result, c.checkedAt, until);
      } else out[id] = { status: "not_run" };
    });
    return out;
  }

  /**
   * Runs one check (`POST …/checks/:checkId/run`) unless a fresh result for the current input
   * fingerprint is cached (or `force`, refused within 10 s of the last run: the cached state with
   * `cooldownUntil`). Another run in progress (any replica) or the org's 8 concurrent runs taken:
   * `running`. Kernel reasons (`unknown`) when the check cannot run here.
   */
  async run(
    caller: CheckCaller,
    itemId: string,
    guideId: string,
    checkId: string,
    body: CheckSelection & { force?: boolean | undefined },
  ): Promise<SetupCheckState> {
    const p = await this.prepare(caller, itemId, guideId, body, checkId);
    // the per-account budget, for the HTTP route and the Platform tool alike (an answer from the
    // cache counts too); Redis down: nothing runs
    let allowed: boolean;
    try {
      allowed = await this.allowRun(caller.accountId);
    } catch (err) {
      this.log.warn("setup checks: Redis unavailable", { err: describeCheckError(err, (s) => s) });
      return unknownState(REASONS.unavailable);
    }
    if (!allowed) {
      throw new ApiError("rate_limited", "Too many setup check runs; try again in a minute");
    }
    // a plugin check: the extension must run here, be on in the org and have a valid effective
    // config before its registration is even looked at (nothing is called otherwise)
    let config: unknown;
    if (!checkId.startsWith("capybara:")) {
      const gate = await this.pluginGate(caller.orgId, p.plugin);
      if ("state" in gate) return gate.state;
      config = gate.config;
    }
    const check = this.registry.resolve(p.plugin, checkId);
    if (!check) return unknownState(REASONS.unregistered);
    if (check.place !== "any" && check.place !== p.place) return unknownState(REASONS.otherPlace);
    const keys = this.keys(p, checkId);
    const revision = await this.revision(p, accountScoped(p, checkId));
    const fingerprint = this.fingerprint(p, revision);
    let cached: CachedResult | null;
    let cooldownMs: number;
    try {
      cached = parseCached(await this.redis.get(keys.result));
      cooldownMs = body.force ? await this.redis.pttl(keys.cooldown) : -2;
    } catch (err) {
      this.log.warn("setup checks: Redis unavailable", { err: describeCheckError(err, (s) => s) });
      return unknownState(REASONS.unavailable);
    }
    const fresh = cached !== null && cached.fingerprint === fingerprint ? cached : null;
    if (fresh && !body.force) return stateOf(fresh.result, fresh.checkedAt);
    if (fresh && cooldownMs > 0) {
      return stateOf(
        fresh.result,
        fresh.checkedAt,
        new Date(Date.now() + cooldownMs).toISOString(),
      );
    }
    const token = randomUUID();
    const orgSlots = `capk:setup-check-org:${caller.orgId}`;
    let locked = false;
    let slot = false;
    try {
      locked = await this.locks.lease(keys.lock, token, LOCK_TTL_MS);
      if (!locked) return { status: "running" };
      slot = await this.locks.takeSlot(
        orgSlots,
        token,
        SETUP_CHECK_LIMITS.orgConcurrency,
        SLOT_TTL_MS,
      );
      if (!slot) return { status: "running" };
      const result = await this.execute(p, check, config);
      const checkedAt = new Date().toISOString();
      const cooldownUntil = new Date(Date.now() + SETUP_CHECK_LIMITS.cooldownMs).toISOString();
      await this.store(keys, { result, fingerprint, checkedAt });
      return stateOf(result, checkedAt, cooldownUntil);
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // Redis, or reading the target's stored material; never the check itself (execute catches)
      this.log.warn("setup check could not run", { err: describeCheckError(err, (s) => s) });
      return unknownState(REASONS.unavailable);
    } finally {
      if (slot) await this.locks.releaseSlot(orgSlots, token).catch(() => {});
      if (locked) await this.locks.releaseIf(keys.lock, token).catch(() => {});
    }
  }

  /**
   * Authorization and the guide (the guide route's rules, `PluginGuides.render`: catalog
   * visibility, then the place and audience action, then the target), then the check's presence
   * in the guide rendered for that mode and audience (404 `catalog.check_not_found`), then the
   * target (400: checks need a saved connection or connector).
   */
  private async prepare(
    caller: CheckCaller,
    itemId: string,
    guideId: string,
    q: CheckSelection,
    checkId?: string,
  ): Promise<Prepared> {
    const guide = await this.guides.render(
      { orgId: caller.orgId, role: caller.role },
      itemId,
      guideId,
      {
        mode: q.mode,
        audience: q.audience,
        connectionId: q.connectionId,
        connectorId: q.connectorId,
        locale: "en",
      },
    );
    const checks = guide.checks.map((c) => c.id);
    if (checkId !== undefined && !checks.includes(checkId)) {
      throw new ApiError(
        "catalog.check_not_found",
        "The check is not in this setup guide for that mode and audience",
      );
    }
    if (guide.target === null) {
      const path = guide.place === "channel-connection" ? "connectionId" : "connectorId";
      throw new ApiError("validation_failed", "Request validation failed", [
        {
          path,
          message:
            guide.place === "channel-connection"
              ? "checks need a saved connection"
              : "checks need a connector made from the template",
        },
      ]);
    }
    return {
      caller,
      plugin: guide.plugin,
      itemId: guide.itemId,
      version: guide.version,
      place: guide.place,
      mode: guide.mode,
      audience: guide.audience,
      target: { kind: guide.target.kind, id: guide.target.id },
      checks,
      perAccount: guide.audience === "member",
    };
  }

  /**
   * A plugin check runs only where its extension runs on this replica, is enabled in the org and
   * has a valid effective config there (nothing is called otherwise): the effective config, or the
   * kernel's answer.
   */
  private async pluginGate(
    orgId: string,
    plugin: string,
  ): Promise<{ config: unknown } | { state: SetupCheckState }> {
    if (!this.extensions.current(plugin))
      return { state: unknownState(REASONS.notRunning(plugin)) };
    if (!(await isExtensionEnabled(this.db.db, orgId, plugin))) {
      return { state: unknownState(REASONS.disabled(plugin)) };
    }
    const eff = await this.effective.get(orgId, plugin);
    if (!eff.ok) {
      return {
        state: unknownState(
          eff.notRunning ? REASONS.notRunning(plugin) : REASONS.needsConfig(plugin),
        ),
      };
    }
    return { config: eff.config };
  }

  /** The Redis keys of a check of the prepared target (spec §10.7). */
  private keys(p: Prepared, checkId: string): CheckKeys {
    const base = [
      p.caller.orgId,
      p.target.kind,
      p.target.id,
      p.plugin,
      checkId,
      p.mode ?? "-",
      ...(accountScoped(p, checkId) ? [p.caller.accountId] : []),
    ].join(":");
    return {
      result: `capk:setup-check:${base}`,
      cooldown: `capk:setup-check:${base}:cooldown`,
      lock: `capk:setup-check-run:${base}`,
    };
  }

  /**
   * The input revision of a prepared target (spec §10.4): the target's and its credentials'
   * `updated_at`, the org's extension config and copy revisions; never a value.
   */
  private async revision(p: Prepared, scoped: boolean): Promise<string> {
    const target =
      p.target.kind === "channel-connection"
        ? await this.channelRevision(p)
        : await this.connectorRevision(p, scoped);
    const org = await this.db
      .selectFrom("extension_org_configs")
      .select("updated_at")
      .where("org_id", "=", p.caller.orgId)
      .where("plugin", "=", p.plugin)
      .executeTakeFirst();
    const copy = await this.db
      .selectFrom("extension_org_overrides")
      .select("updated_at")
      .where("org_id", "=", p.caller.orgId)
      .where("plugin", "=", p.plugin)
      .executeTakeFirst();
    const iso = (d: Date | string | undefined) =>
      d === undefined ? "-" : new Date(d).toISOString();
    return [target, iso(org?.updated_at), iso(copy?.updated_at)].join("|");
  }

  private channelRevision(p: Prepared): Promise<string> {
    return this.channels.checkRevision(p.caller.orgId, p.plugin, p.target.id);
  }

  private async connectorRevision(p: Prepared, scoped: boolean): Promise<string> {
    const row = await this.db
      .selectFrom("connectors")
      .select("updated_at")
      .where("id", "=", p.target.id)
      .where("org_id", "=", p.caller.orgId)
      .executeTakeFirst();
    // the client and org credential rows, and the caller's own row for account-scoped checks
    const creds = await this.credentials.checkRevision(
      p.caller.orgId,
      p.target.id,
      scoped ? p.caller.accountId : null,
    );
    return `${row ? new Date(row.updated_at).toISOString() : "-"}|${creds}`;
  }

  /**
   * The input fingerprint (spec §10.4): an HMAC with a key derived from the kernel's master key
   * over revisions only (the target and credentials revision, the org config revisions, the
   * plugin version, the loaded extension version and the mode), never a value, so it cannot be
   * reversed to a secret.
   */
  private fingerprint(p: Prepared, revision: string): string {
    const inst = this.extensions.current(p.plugin);
    // the loaded deployment config's digest: a platform config change (PG, env, hot reload) is a
    // new input like the org's copy is
    const loaded = inst === undefined ? ["-", "-"] : [inst.version, inst.configHash];
    return createHmac("sha256", this.keyring.deriveKey("setup-check-fingerprint").current)
      .update(JSON.stringify([revision, p.version, ...loaded, p.mode ?? "-"]))
      .digest("hex");
  }

  /** Counts one run of the account in its window; false at the limit (nothing counted). */
  private async allowRun(accountId: string): Promise<boolean> {
    const r = await this.redis.eval(
      RUN_RATE_LUA,
      1,
      `capk:setup-check-rate:${accountId}`,
      String(RUN_WINDOW_MS),
      String(RUN_LIMIT),
    );
    return Number(r) === 1;
  }

  /** Writes a result (TTL 5 min) and the force cooldown (10 s), outside any transaction. */
  private async store(keys: CheckKeys, value: CachedResult): Promise<void> {
    await this.redis.set(keys.result, JSON.stringify(value), "PX", SETUP_CHECK_LIMITS.freshMs);
    await this.redis.set(keys.cooldown, "1", "PX", SETUP_CHECK_LIMITS.cooldownMs);
  }

  /**
   * Loads the target (built field by field), runs the check against the time limit and turns what
   * it answers into a validated, redacted, re-validated result. Never throws for anything the
   * check does: a throw, a timeout or an invalid result is an `unknown` result.
   */
  private async execute(
    p: Prepared,
    check: ResolvedSetupCheck,
    config: unknown,
  ): Promise<SetupCheckResult> {
    const material = await this.material(p, check);
    if ("result" in material) return material.result;
    const secrets = [
      ...material.secrets,
      ...this.configSecrets(p.plugin, config),
      ...(await this.orgConfigSecrets(p.caller.orgId, p.plugin)),
    ];
    const redact = checkRedactor(secrets);
    const fields = { plugin: p.plugin, checkId: check.id, orgId: p.caller.orgId };
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let answer: { value: unknown } | { error: unknown } | "timeout" | "unloaded";
    if (check.source === "plugin") {
      const signal = AbortSignal.any([timeout, check.signal]);
      // the org's language: a result is cached for every viewer of the org
      const { locale } = await readOrgSettings(this.db.db, p.caller.orgId);
      answer = await raceSignal(
        signal,
        // the in-flight tracker merges the instance's abort into the signal the check gets
        () =>
          check.inflight.run(signal, (s) =>
            check.run(this.pluginArgs(p, material, config, locale, s)),
          ),
        () => (check.signal.aborted ? "unloaded" : "timeout"),
      );
    } else {
      const signal = timeout;
      const args: KernelCheckArgs = Object.freeze({
        orgId: p.caller.orgId,
        accountId: p.caller.accountId,
        mode: p.mode,
        target: kernelTarget(p, material),
        signal,
        secrets: Object.freeze([...material.secrets]) as string[],
      });
      answer = await raceSignal(
        signal,
        () => check.run(args),
        () => "timeout",
      );
    }
    if (answer === "timeout") {
      this.log.warn("setup check timed out", { ...fields, timeoutMs: this.timeoutMs });
      return { status: "unknown", reason: REASONS.timedOut };
    }
    if (answer === "unloaded") return { status: "unknown", reason: REASONS.notRunning(p.plugin) };
    if ("error" in answer) {
      this.log.warn("setup check failed", {
        ...fields,
        error: describeCheckError(answer.error, redact),
      });
      return { status: "unknown", reason: REASONS.failed };
    }
    const first = validateSetupCheckResult(answer.value);
    if (!isValid(first)) {
      this.log.warn("setup check result invalid", { ...fields, problem: redact(first.problem) });
      return { status: "unknown", reason: REASONS.invalid };
    }
    const second = validateSetupCheckResult(redactCheckResult(first, redact));
    if (!isValid(second)) {
      this.log.warn("setup check result invalid after redaction", {
        ...fields,
        problem: redact(second.problem),
      });
      return { status: "unknown", reason: REASONS.invalid };
    }
    return second;
  }

  /**
   * The target material: for a channel connection its revision and stored secret values (and, for
   * a plugin check, the connection config decrypted exactly as `channel@1` verify gets it); for a
   * connector its credentials' values (redaction only), the manual OAuth client id and the
   * template id. A `result` when the material cannot be read (the check is not called).
   */
  private async material(
    p: Prepared,
    check: ResolvedSetupCheck,
  ): Promise<(Material & { connectionConfig?: unknown }) | { result: SetupCheckResult }> {
    if (p.target.kind === "channel-connection") {
      const stored = await this.channels.checkSecrets(p.caller.orgId, p.plugin, p.target.id);
      if (check.source === "kernel") return { secrets: stored };
      let rt: Awaited<ReturnType<ChannelConnections["runtime"]>>;
      try {
        rt = await this.channels.runtime(p.target.id);
      } catch (err) {
        if (err instanceof ApiError && err.code === "extension.config_invalid") {
          return { result: { status: "unknown", reason: REASONS.targetGone } };
        }
        if (err instanceof ApiError && err.code === "extension.not_enabled") {
          return { result: { status: "unknown", reason: REASONS.disabled(p.plugin) } };
        }
        if (err instanceof ApiError && err.code === "extension.not_found") {
          return { result: { status: "unknown", reason: REASONS.notRunning(p.plugin) } };
        }
        throw err;
      }
      // the connection of this org on the check's plugin only (render checked it; checked again)
      if (rt.row.orgId !== p.caller.orgId || rt.row.plugin !== p.plugin) {
        throw new ApiError("channel.not_found", "Channel connection not found");
      }
      return {
        secrets: [...stored, ...secretValues((rt.channel as Channel).connectionSchema, rt.config)],
        // a frozen copy: what the check gets cannot change the kernel's object or another call's
        connectionConfig: deepFreeze(structuredClone(rt.config)),
      };
    }
    const row = await this.db
      .selectFrom("connectors as c")
      .innerJoin("platform_connector_templates as t", "t.id", "c.platform_template_id")
      .select(["c.auth", "t.template_id"])
      .where("c.id", "=", p.target.id)
      .where("c.org_id", "=", p.caller.orgId)
      .where("c.deleted_at", "is", null)
      .where("t.catalog_item_id", "=", p.itemId)
      .executeTakeFirst();
    if (!row) throw new ApiError("connector.not_found", "Connector not found");
    const auth = row.auth as unknown as ConnectorAuth;
    const m = await this.credentials.checkMaterial(p.caller.orgId, p.target.id);
    const manual = auth.type === "oauth_code" && auth.client === "manual";
    return {
      secrets: m.secrets,
      clientId: manual ? m.clientId : null,
      templateId: row.template_id,
    };
  }

  /** The secret values of the extension's platform and effective deployment config. */
  private configSecrets(plugin: string, effective: unknown): string[] {
    const inst = this.extensions.current(plugin);
    const schema = inst?.manifest.config?.deployment;
    if (!inst || !schema) return [];
    return [
      ...secretValues(schema, inst.config),
      ...(effective === undefined ? [] : secretValues(schema, effective)),
    ];
  }

  /**
   * The secret values of the extension's org-level config (`config.org`) in the org: the check
   * never gets them, but the extension holds them, so a result is redacted by them too. Nothing
   * when the plugin has no org config; a read that fails throws (the check is not run: a result
   * is never redacted by fewer secrets than the extension holds).
   */
  private async orgConfigSecrets(orgId: string, plugin: string): Promise<string[]> {
    const schema = this.extensions.current(plugin)?.manifest.config?.org;
    if (!schema) return [];
    const c = await this.orgConfigs.get(orgId, plugin);
    return c?.config == null ? [] : secretValues(schema, c.config);
  }

  /** The frozen arguments of a plugin check (the target built field by field). */
  private pluginArgs(
    p: Prepared,
    m: Material & { connectionConfig?: unknown },
    config: unknown,
    locale: "en" | "zh",
    signal: AbortSignal,
  ): SetupCheckArgs {
    const target: SetupCheckTarget =
      p.target.kind === "channel-connection"
        ? Object.freeze({
            kind: "channel-connection" as const,
            connectionId: p.target.id,
            config: m.connectionConfig,
          })
        : Object.freeze({
            kind: "connector" as const,
            connectorId: p.target.id,
            templateId: m.templateId ?? "",
            clientId: m.clientId ?? null,
            accountId: p.perAccount ? p.caller.accountId : null,
          });
    return Object.freeze({
      orgId: p.caller.orgId,
      config,
      locale,
      mode: p.mode,
      target,
      signal,
    });
  }
}

/** The kernel check's target: ids and the plugin only. */
function kernelTarget(p: Prepared, m: Material): KernelCheckTarget {
  return p.target.kind === "channel-connection"
    ? Object.freeze({ kind: "channel-connection", connectionId: p.target.id, plugin: p.plugin })
    : Object.freeze({
        kind: "connector",
        connectorId: p.target.id,
        templateId: m.templateId ?? "",
        plugin: p.plugin,
      });
}

/**
 * Runs `fn` raced against `signal`: its value or error, or `onAbort()` when the signal aborts
 * first (a late settle of `fn` is swallowed). `fn` throwing synchronously counts as an error.
 */
async function raceSignal<T extends string>(
  signal: AbortSignal,
  fn: () => Promise<unknown>,
  onAbort: () => T,
): Promise<{ value: unknown } | { error: unknown } | T> {
  let settle: (() => void) | undefined;
  const aborted = new Promise<T>((resolve) => {
    if (signal.aborted) {
      resolve(onAbort());
      return;
    }
    settle = () => resolve(onAbort());
    signal.addEventListener("abort", settle, { once: true });
  });
  const call = Promise.resolve()
    .then(fn)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  try {
    return await Promise.race([call, aborted]);
  } finally {
    if (settle) signal.removeEventListener("abort", settle);
  }
}

/** A cached value, or null when absent or not of the stored shape (re-validated). */
function parseCached(raw: string | null): CachedResult | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as Partial<CachedResult>;
    if (typeof v.fingerprint !== "string" || typeof v.checkedAt !== "string") return null;
    const r = validateSetupCheckResult(v.result);
    return isValid(r) ? { result: r, fingerprint: v.fingerprint, checkedAt: v.checkedAt } : null;
  } catch {
    return null;
  }
}
