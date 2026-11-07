import { randomUUID } from "node:crypto";
import {
  type ExecResult,
  type FileSystemHandle,
  isFileSystemGoneError,
  isSandboxGoneError,
  type SandboxActor,
  type SandboxHandle,
  type SandboxLimits,
  type SandboxProvider,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import {
  type Expression,
  type ExpressionBuilder,
  type Selectable,
  type SqlBool,
  sql,
  type UpdateObject,
} from "kysely";
import { BackgroundTaskStore } from "../background/store.js";
import {
  DEFAULT_MAX_COMMAND_SECONDS,
  DEFAULT_MAX_RUN_SECONDS,
  type KernelConfig,
} from "../config/schema.js";
import type { EnvironmentInstancesTable, KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { readSandboxLimitOverride } from "../identity/settings.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  effectiveSandboxEgress,
  effectiveSandboxLimits,
  readOrgSettings,
} from "../orgs/settings.service.js";
import { canonicalJson } from "../tools/canonical-json.js";
import {
  type SandboxLease,
  SandboxLeases,
  SandboxLockLostError,
  type SandboxPathLease,
  sandboxBusy,
} from "./leases.js";
import { type SandboxProviderEntry, SandboxProviders } from "./providers.js";

// Moved to leases.ts (phase C); re-exported for existing importers
export {
  SANDBOX_LOCK_PREFIX,
  SANDBOX_LOCK_TTL_MS,
  SandboxLockLostError,
  sandboxBusy,
} from "./leases.js";

/** Margin (ms) of a holder record's TTL beyond the longest command: by then the in-sandbox limit has ended its commands. */
const HOLDER_TTL_MARGIN_MS = 10 * 60_000;
/** How long the kernel's own read-modify-write of one file waits for another holder's (ms, spec §10.4). */
const PATH_LEASE_WAIT_MS = 30_000;
/** Time limit of one provider call in maintenance (suspend, destroy). */
const SWEEP_OP_TIMEOUT_MS = 120_000;
/** How long the suspension sweep holds the intent on a sandbox past `maxRunningMinutes` (ms). */
const SWEEP_INTENT_WAIT_MS = 1000;
/** Rows one sweep handles at most, and the provider calls it runs at once. */
const SWEEP_BATCH = 200;
const SWEEP_CONCURRENCY = 4;
/** How long `destroyEnvironment` / `resetFileSystem` wait for the exclusive lease (running commands). */
const EXCLUSIVE_WAIT_MS = 10 * 60_000;
/** The time limit of the exec that kills lost background tasks after a resume (ms). */
const PENDING_KILL_TIMEOUT_MS = 30_000;
/** A background task's session id as `echo $!` printed it; anything else is never put in a command. */
const SID_RE = /^[1-9][0-9]{0,9}$/;

/** The third argument of the `withSandbox` callback. */
export interface SandboxUseInfo {
  /** This call created the instance (first use, or a rebuild). */
  fresh: boolean;
  /**
   * The environment had an instance before that is no longer there (destroyed after inactivity,
   * gone at the provider, or rebuilt by another holder since this holder last used it): this is a
   * new instance on the kept files, so earlier processes are gone.
   */
  restarted: boolean;
}

/** Who uses the sandbox in {@link SandboxService.withSandbox}. */
export interface SandboxUseContext {
  orgId: string;
  environmentId: string;
  /** The agent conversation using it (a sub-agent's own for a child): what it last saw is tracked. */
  holderConversationId: string;
  /** Passed with every `exec` (audit and attribution). */
  actor: SandboxActor;
}

export type { SandboxProviderEntry } from "./providers.js";

type Row = Selectable<EnvironmentInstancesTable>;
type Patch = UpdateObject<KernelDatabase, "environment_instances">;
type ExecArgs = Parameters<SandboxProvider["exec"]>[1];
/** The fence read under the lease (incremented by every fenced write). */
interface Fence {
  gen: number;
}

/**
 * One instance of an environment: its handle and the row's `created_at`, which the fenced write
 * after every `create` sets. The handle alone is not enough: sandbox-docker's handle is the
 * instance name, the same after a rebuild (spec §10.10).
 */
interface Instance {
  handle: SandboxHandle;
  createdAt: number;
}

/**
 * The provider {@link SandboxService.withSandbox} passes to its callback: every `exec` carries the
 * holder's tag and the caller's actor, so the callback passes neither.
 */
export type HeldProvider = Omit<SandboxProvider, "exec"> & {
  exec(h: SandboxHandle, args: Omit<ExecArgs, "tag" | "actor">): Promise<ExecResult>;
};

/**
 * The provider {@link SandboxService.ifRunning} passes to its callback: every `exec` carries the
 * holder's tag; the caller names the actor.
 */
export type TaggedProvider = Omit<SandboxProvider, "exec"> & {
  exec(h: SandboxHandle, args: Omit<ExecArgs, "tag">): Promise<ExecResult>;
};

/** What {@link SandboxService.ifRunning} did. */
export type IfRunningResult<T> =
  | { kind: "ran"; value: T }
  /**
   * No instance, or it is not running: `status` is the instance row's (`none`, `suspended`,
   * `creating`, `destroyed`, or `running` recorded with another provider), `gone` without a row.
   */
  | { kind: "not_running"; status: Row["status"] | "gone" }
  /** The environment now records another instance (a rebuild). */
  | { kind: "other_instance" };

/** A holder ready to run `fn`: a shared lease, the running instance, the use info. */
interface Entered {
  lease: SandboxLease;
  handle: SandboxHandle;
  createdAt: number;
  /** The id of the file system the instance runs on (a reset makes a new one). */
  fsId: string;
  info: SandboxUseInfo;
}

/** The signal of one provider call in maintenance: aborted on timeout or when the lease is lost. */
const opSignal = (lease: SandboxLease): AbortSignal =>
  AbortSignal.any([lease.signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]);

/** The provider-side name of an environment's file system and instance. */
export const environmentResourceName = (environmentId: string): string =>
  `cap-env-${environmentId}`;

/** The environment is missing, deleted, or not in the caller's org (404; ids cannot be probed). */
export const environmentNotFound = (): ApiError =>
  new ApiError("environment.not_found", "This environment does not exist or was deleted.");

/** The environment's file system is gone at the provider (409); never replaced silently. */
export const environmentFilesLost = (): ApiError =>
  new ApiError(
    "environment.files_lost",
    "The environment's files are gone; reset its files from the environments page to start with an empty workspace.",
  );

/**
 * The row still records the instance `gone` (same handle and same `created_at`). Handles compare
 * canonically: a jsonb round trip reorders a multi-key handle's keys (final review m9).
 */
export const isInstance = (
  row: Pick<Row, "handle" | "created_at">,
  gone: Instance | null,
): boolean =>
  gone !== null &&
  row.handle !== null &&
  canonicalJson(row.handle) === canonicalJson(gone.handle) &&
  row.created_at.getTime() === gone.createdAt;

/**
 * `impl` with every `exec` labelled with the holder's tag (and `actor` when given); `before` runs
 * first (it refreshes the holder's record, so a callback that runs several long commands in a row
 * stays recorded).
 */
function tagged<P>(
  impl: SandboxProvider,
  tag: string,
  actor: SandboxActor | undefined,
  before: () => Promise<void>,
): P {
  const wrapped = Object.create(impl) as SandboxProvider;
  Object.defineProperty(wrapped, "exec", {
    value: async (h: SandboxHandle, args: ExecArgs) => {
      await before();
      return impl.exec(h, { ...args, tag, ...(actor !== undefined && { actor }) });
    },
  });
  return wrapped as unknown as P;
}

/**
 * Sandbox config problems to tell operators at startup (English log lines):
 * - `runtime.maxRunSeconds` below `sandbox.limits.maxCommandSeconds`: long commands are cut by the
 *   run time limit (Ruling M20);
 * - `sandbox.limits.egress` is open but the current provider plugin has no `allowOpenEgress`: every
 *   instance creation is refused.
 * With both time limits at their defaults (900 < 7200, a known trade-off) it is only info; warn
 * when an operator changed one and they still disagree.
 */
export function sandboxConfigWarnings(
  cfg: Pick<KernelConfig, "runtime" | "sandbox" | "extensionConfig">,
  providerPlugin?: string,
): { level: "info" | "warn"; message: string }[] {
  const out: { level: "info" | "warn"; message: string }[] = [];
  if (cfg.sandbox.limits.egress === "open" && providerPlugin !== undefined) {
    const pc = cfg.extensionConfig[providerPlugin] as { allowOpenEgress?: unknown } | undefined;
    if (pc?.allowOpenEgress !== true) {
      out.push({
        level: "warn",
        message: `sandbox.limits.egress is "open" but extensionConfig."${providerPlugin}".allowOpenEgress is not true: the ${providerPlugin} plugin refuses to create sandboxes with open egress; set allowOpenEgress to true (trusted environments only) or use "allowlist" or "none"`,
      });
    }
  }
  const run = cfg.runtime.maxRunSeconds;
  const cmd = cfg.sandbox.limits.maxCommandSeconds;
  if (run < cmd) {
    const defaults = run === DEFAULT_MAX_RUN_SECONDS && cmd === DEFAULT_MAX_COMMAND_SECONDS;
    out.push({
      level: defaults ? "info" : "warn",
      message: `runtime.maxRunSeconds (${run}) is less than sandbox.limits.maxCommandSeconds (${cmd}): sandbox commands are limited to the time left in the run, so commands longer than about ${run} seconds cannot finish; raise runtime.maxRunSeconds to at least ${cmd} if agents need long commands`,
    });
  }
  return out;
}

/** No sandbox provider (503). */
export const sandboxUnavailable = (): ApiError =>
  new ApiError(
    "sandbox.unavailable",
    "Sandbox is not available in this deployment; install a sandbox plugin",
  );

/**
 * The environment's files are kept by a provider that is not the current one (503); its files are
 * not migrated, so it stays unusable until that provider is back (spec §4.2 item 13).
 */
const otherProvider = (provider: string): ApiError =>
  new ApiError(
    "environment.unavailable",
    `This environment's files are kept by the sandbox provider ${provider}, which is not the current provider; it can be used again once ${provider} is the deployment's sandbox provider`,
  );

const abortReason = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("This operation was aborted", "AbortError");

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    const onAbort = () => {
      clearTimeout(t);
      reject(abortReason(signal));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Runs `fn` on `items`, `limit` at a time. */
async function inPool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const x = items[next++] as T;
      await fn(x);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * The kernel's sandbox service over the `sandbox@2` provider, keyed by **environment** (spec
 * 2026-11-07-environments-design §4.2, §5.1): one file system kept until the environment is
 * deleted, plus one instance attached to it that comes and goes; all conversations bound to the
 * environment (and their sub-agents) share both.
 *
 * - **Lazy creation**: the first {@link withSandbox} creates the file system
 *   (`createFileSystem`, name `cap-env-<environmentId>`) and then the instance on it; state lives
 *   in `environment_instances`. A file system gone at the provider is never replaced silently:
 *   `fs_status` becomes `lost` and uses fail with `environment.files_lost` until
 *   {@link resetFileSystem}.
 * - **Leases** (phase C, spec §10, {@link SandboxLeases}), keyed by environment id: using an
 *   instance recorded `running` with the current provider takes a **shared** lease, so up to
 *   `sandbox.maxConcurrentCommands` holders (all sessions of the environment) run at once. Every
 *   lifecycle change (create, resume, rebuild, suspend, destroy, reset) takes the **exclusive**
 *   lease, alone; a caller that needs one on the use path sets the intent so new shared leases wait
 *   for it, and downgrades to a shared lease to run its own command once the instance runs.
 *   Waiting is capped at `sandbox.lockWaitSeconds` (`sandbox.busy`); two replicas using it for the
 *   first time at once still build only one.
 * - **Fencing**: exclusive holders read `generation` and compare-and-increment it with every state
 *   write ({@link SandboxLockLostError}); every acquisition (shared ones too) bumps it first, so a
 *   stale exclusive holder's later writes fail. Shared holders write nothing else but
 *   `last_used_at` (monotonic). A lost lease aborts the signal passed to `fn` and to maintenance
 *   provider calls.
 * - **Suspension and destruction**: the sweeps (`SandboxSweepJobs`, crons) call
 *   {@link suspendIdle} / {@link destroyInactive}; they try the exclusive lease once and skip an
 *   environment with any holder; one past `maxRunningMinutes` gets the intent for a short window
 *   (about a second) so the suspension can get in when its commands end. Inactivity destroys only
 *   the instance (files kept); a deleted environment or org loses its files too.
 * - **Transparent recovery**: a suspended instance is resumed on next use; when `resume` returns
 *   `gone`, the instance was destroyed, or `fn` throws `SandboxGoneError` (retried once), a new
 *   instance is created on the kept files and `restarted` is true. Several holders hitting `gone`
 *   together rebuild once: the others find the new instance.
 * - **Takeover** (spec §10.5; environments spec §4.2): every holder records itself in
 *   `capk:sandbox-holders:<env>` (again before each `exec`) and its commands carry its lease token
 *   as `tag`. An acquirer that finds a record without a live lease (a crashed holder) kills only
 *   that holder's commands (`killTagged`): other conversations of the environment may be running
 *   commands. `killAll` runs only under the exclusive lease, before the downgrade, on an instance
 *   this holder just resumed from `suspended` (nobody else can hold it; a provider that keeps
 *   memory across a pause brings old commands back); it also covers crashed holders' records,
 *   which it claims. A freshly created instance has nothing to kill. Failures are only warned (the
 *   in-sandbox time limit is the backstop).
 * - **Instance identity**: a holder that hits `gone` names the instance by its handle and the
 *   row's `created_at` (set by the fenced write after each `create`); the handle alone is the same
 *   after a rebuild on providers whose handle is the instance name (sandbox-docker).
 *
 * Files kept by another provider than the current one make the environment unusable
 * (`environment.unavailable`) until that provider is back; deleting it still works while that
 * provider is loaded ({@link SandboxProviders.lookup}). Without a provider {@link available} is false and
 * uses throw `sandbox.unavailable` (503). No in-process state: replicas share it through PG and
 * Redis.
 */
@Injectable()
export class SandboxService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    /** The record of the instance each holder last used (`capk:sandbox-seen:…`). */
    @Inject(REDIS) private readonly redis: Pick<Redis, "set">,
    @Inject(SandboxLeases) private readonly leases: SandboxLeases,
    /** The `sandbox@2` provider (read at every call: providers are ready after the extension load). */
    @Inject(SandboxProviders)
    private readonly providers: Pick<SandboxProviders, "current" | "lookup">,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "info" | "warn">,
    /** Background tasks lost while their process may live on (killed after a resume). */
    @Inject(BackgroundTaskStore)
    private readonly background: Pick<BackgroundTaskStore, "pendingKills" | "clearKill">,
  ) {}

  /** Poll interval while waiting for a lease (the leases' own). */
  private get pollMs(): number {
    return this.leases.pollMs;
  }

  /** Whether there is a sandbox provider. */
  get available(): boolean {
    return this.providers.current() !== undefined;
  }

  /** Concurrent holders of one environment (`sandbox.maxConcurrentCommands`, read at every use). */
  private get cap(): number {
    return this.config.get().sandbox.maxConcurrentCommands;
  }

  /**
   * The org's effective sandbox limits (spec §8.4): the deployment's `sandbox.limits`, egress
   * narrowed by the org setting `sandboxEgress` (Ruling M19), cpu / memory per the super admin's
   * org override (C19 / Ruling M16). Instances are created with them; phase 1 environments use
   * them unchanged.
   */
  async orgLimits(orgId: string): Promise<SandboxLimits> {
    const cfg = this.config.get().sandbox;
    const egress = effectiveSandboxEgress(
      cfg.limits,
      (await readOrgSettings(this.db.db, orgId)).sandboxEgress,
    );
    const sized = effectiveSandboxLimits(
      { ...cfg.limits, ...egress },
      await readSandboxLimitOverride(this.db.db, orgId),
    );
    return {
      cpu: sized.cpu,
      memoryMb: sized.memoryMb,
      diskMb: sized.diskMb,
      egress: sized.egress,
      allowHosts: sized.allowHosts,
    };
  }

  /**
   * The environment's instance state as shown to people (read only, no lease): `running` /
   * `suspended` and the last use. No instance, a destroyed one, or one stuck in `creating` (being
   * created, or a failed create the next use retries) is null.
   */
  async status(
    orgId: string,
    environmentId: string,
  ): Promise<{ status: "running" | "suspended"; lastUsedAt: Date } | null> {
    const row = await this.db
      .selectFrom("environment_instances")
      .select(["status", "last_used_at"])
      .where("environment_id", "=", environmentId)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row || (row.status !== "running" && row.status !== "suspended")) return null;
    return { status: row.status, lastUsedAt: row.last_used_at };
  }

  /**
   * The instance the environment records now (its `created_at`), while it has one that runs or is
   * suspended; null otherwise. Read without a lease: a caller inside `withSandbox` reads the
   * instance its own lease keeps.
   */
  async currentInstance(environmentId: string): Promise<{ createdAt: Date } | null> {
    const row = await this.db
      .selectFrom("environment_instances")
      .select(["status", "handle", "created_at"])
      .where("environment_id", "=", environmentId)
      .executeTakeFirst();
    if (!row || row.handle === null) return null;
    if (row.status !== "running" && row.status !== "suspended") return null;
    return { createdAt: row.created_at };
  }

  /**
   * Runs `fn` on the environment's instance only while it runs the instance created at
   * `instance.createdAt` (background tasks, spec 2026-11-05-background-bash-design §4.3). It never
   * creates, resumes or rebuilds one: an instance that is missing, suspended, being created or
   * destroyed (or recorded with another provider) is `not_running`, one that records another
   * instance is `other_instance`. Otherwise `fn` runs under a shared lease, as a `withSandbox`
   * holder does (its tag on every exec, crashed holders' commands killed), and `last_used_at`
   * moves forward when it ends. Waits for the lease up to `sandbox.lockWaitSeconds`
   * (`sandbox.busy`); `signal` (optional) ends the wait with its abort reason. The signal passed
   * to `fn` aborts with `signal` or when the lease is lost. Errors of `fn` (`SandboxGoneError`
   * too) are thrown as they are.
   */
  async ifRunning<T>(
    environmentId: string,
    instance: { createdAt: Date },
    fn: (p: TaggedProvider, h: SandboxHandle, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<IfRunningResult<T>> {
    const p = this.require();
    const env = environmentId;
    const deadline = Date.now() + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    for (;;) {
      if (signal.aborted) throw abortReason(signal);
      const row = await this.db
        .selectFrom("environment_instances")
        .selectAll()
        .where("environment_id", "=", env)
        .executeTakeFirst();
      if (!row) return { kind: "not_running", status: "gone" };
      if (row.created_at.getTime() !== instance.createdAt.getTime()) {
        return { kind: "other_instance" };
      }
      if (!this.usable(row, p, null)) return { kind: "not_running", status: row.status };
      // the instance this check saw: its handle plus `created_at` (never `generation`, which
      // every lease bumps)
      const want: Instance = { handle: row.handle, createdAt: row.created_at.getTime() };
      const lease = await this.leases.tryShared(env, this.cap, token);
      if (lease) {
        const e = await this.asShared(
          { orgId: row.org_id, environmentId: env },
          p,
          lease,
          (r): r is Row & { handle: SandboxHandle } =>
            this.usable(r, p, null) && isInstance(r, want),
          signal,
        );
        if (e) {
          try {
            const impl = tagged<TaggedProvider>(p.impl, lease.token, undefined, () =>
              this.register(env, lease.token),
            );
            const sig = AbortSignal.any([signal, lease.signal]);
            return { kind: "ran", value: await fn(impl, e.handle, sig) };
          } finally {
            await this.leave(env, e);
          }
        }
        // the row changed between the check and the lease: classify it again
        continue;
      }
      if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
      await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
    }
  }

  /**
   * A short lease on one path of the environment around the kernel's own read-modify-write of
   * that file (spec §10.4); waits up to 30 s, then throws `SandboxPathBusyError`. Its `signal`
   * aborts when a renewal finds it lost.
   */
  pathLease(environmentId: string, path: string, signal: AbortSignal): Promise<SandboxPathLease> {
    return this.leases.pathLease(environmentId, path, signal, PATH_LEASE_WAIT_MS);
  }

  /**
   * Runs `fn` on the environment's instance: take a lease → make sure the instance runs (file
   * system, create / resume / rebuild, under the exclusive lease) → `fn` under a shared lease →
   * update `last_used_at` → release.
   * - Waiting longer than `sandbox.lockWaitSeconds` throws `sandbox.busy` (409); `signal` aborts
   *   the wait and the creation / resume.
   * - The fourth argument of `fn` combines `signal` with the lease's: use it for commands, so they
   *   stop when the lease is lost.
   * - The provider passed to `fn` labels every `exec` with this holder's tag and `ctx.actor`.
   * - When `fn` throws `SandboxGoneError` (the instance is gone) the instance is rebuilt on the
   *   kept files (or the one another holder rebuilt is taken) and `fn` runs once more with
   *   `restarted: true`; a second `gone` is thrown. Other errors are thrown as they are.
   * - Lost files throw `environment.files_lost` (409).
   * - When `ctx.holderConversationId` last used another instance (another holder rebuilt it
   *   meanwhile), `info.restarted` is true, so it learns its processes are gone (final review m5).
   */
  async withSandbox<T>(
    ctx: SandboxUseContext,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const p = this.require();
    const env = ctx.environmentId;
    const holder = ctx.holderConversationId;
    let e = await this.seenBy(env, holder, await this.enter(ctx, p, signal, null));
    try {
      try {
        return await this.runAs(e, ctx, p, fn, signal);
      } catch (err) {
        if (!isSandboxGoneError(err)) throw err;
        this.log.info("sandbox instance is gone during use; recreating", { environmentId: env });
        const gone: Instance = { handle: e.handle, createdAt: e.createdAt };
        const prev = e;
        await this.leave(env, prev);
        e = await this.seenBy(env, holder, await this.enter(ctx, p, signal, gone));
        return await this.runAs(
          { ...e, info: { fresh: true, restarted: true } },
          ctx,
          p,
          fn,
          signal,
        );
      }
    } finally {
      await this.leave(env, e);
    }
  }

  /**
   * Records that `holder` uses the instance of `e` (`capk:sandbox-seen:<env>:<holder>` =
   * `<created_at>:<file system id>`, with a TTL of the inactivity destruction plus a day). When the
   * holder last used another instance on the same file system `e` is marked restarted; on another
   * file system (the files were reset) it is not. Best effort: a Redis error only logs.
   */
  private async seenBy(environmentId: string, holder: string, e: Entered): Promise<Entered> {
    try {
      const ttl = (this.config.get().sandbox.limits.destroyAfterInactiveDays + 1) * 86_400;
      const seen = `${e.createdAt}:${e.fsId}`;
      const prev = await this.redis.set(
        `capk:sandbox-seen:${environmentId}:${holder}`,
        seen,
        "EX",
        ttl,
        "GET",
      );
      if (prev !== null && prev !== seen) {
        // `<createdAt>:<fsId>`: another file system (a reset) means a fresh start, not a restart on
        // kept files; another instance on the same file system is a restart
        const sameFiles = prev.slice(prev.indexOf(":") + 1) === e.fsId;
        if (sameFiles !== e.info.restarted) {
          return { ...e, info: { fresh: e.info.fresh, restarted: sameFiles } };
        }
      }
    } catch (err) {
      this.log.warn("cannot record the sandbox instance a holder uses", {
        environmentId,
        holder,
        err,
      });
    }
    return e;
  }

  /** Runs `fn` as the holder `e`: its tag and the caller's actor on every exec, its lease's signal. */
  private runAs<T>(
    e: Entered,
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    fn: (
      h: SandboxHandle,
      p: HeldProvider,
      info: SandboxUseInfo,
      signal: AbortSignal,
    ) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const sig = AbortSignal.any([signal, e.lease.signal]);
    const env = ctx.environmentId;
    const impl = tagged<HeldProvider>(p.impl, e.lease.token, ctx.actor, () =>
      this.register(env, e.lease.token),
    );
    return fn(e.handle, impl, e.info, sig);
  }

  /**
   * Becomes a holder: loops until it has a shared lease on a running instance, or `sandbox.busy`.
   * An instance recorded `running` (with the current provider, not the `gone` instance) is used
   * under a shared lease; otherwise the exclusive lease (with intent) makes it run and is
   * downgraded. One token serves both, so the waiter passes its own intent.
   */
  private async enter(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    gone: Instance | null,
  ): Promise<Entered> {
    const env = ctx.environmentId;
    const deadline = Date.now() + this.config.get().sandbox.lockWaitSeconds * 1000;
    const token = randomUUID();
    let intent = false;
    try {
      for (;;) {
        if (signal.aborted) throw abortReason(signal);
        const row = await this.readRow(ctx);
        if (this.usable(row, p, gone)) {
          const lease = await this.leases.tryShared(env, this.cap, token);
          if (lease) {
            if (intent) await this.clearIntent(env, token);
            intent = false;
            const e = await this.asShared(ctx, p, lease, (r) => this.usable(r, p, gone), signal);
            if (e) return e;
          }
        } else {
          const lease = await this.leases.tryExclusive(env, { token, intent: true });
          intent = lease === null;
          if (lease) return await this.asExclusive(ctx, p, lease, gone, signal);
        }
        if (Date.now() + this.pollMs > deadline) throw sandboxBusy();
        await sleep(this.pollMs + Math.floor(Math.random() * this.pollMs), signal);
      }
    } catch (err) {
      if (intent) await this.clearIntent(env, token);
      throw err;
    }
  }

  private async clearIntent(env: string, token: string): Promise<void> {
    await this.leases
      .clearIntent(env, token)
      .catch((err: unknown) =>
        this.log.warn("cannot clear sandbox intent", { environmentId: env, err }),
      );
  }

  private async readRow(ctx: { orgId: string; environmentId: string }): Promise<Row | undefined> {
    const row = await this.db
      .selectFrom("environment_instances")
      .selectAll()
      .where("environment_id", "=", ctx.environmentId)
      .executeTakeFirst();
    if (row && row.org_id !== ctx.orgId) throw this.foreign(ctx);
    return row;
  }

  /** The instance row belongs to another org: reported as not found, so ids cannot be probed. */
  private foreign(_ctx: { orgId: string; environmentId: string }): ApiError {
    return environmentNotFound();
  }

  /** Recorded running with the current provider, and not the instance found gone. */
  private usable(
    row: Row | undefined,
    p: SandboxProviderEntry,
    gone: Instance | null,
  ): row is Row & { handle: SandboxHandle } {
    return (
      row !== undefined &&
      row.status === "running" &&
      row.provider === p.plugin &&
      row.handle !== null &&
      !isInstance(row, gone)
    );
  }

  /**
   * Under a just-taken shared lease: confirms the row is still `accept`ed (else releases and
   * returns null), records the holder and kills crashed holders' commands.
   */
  private async asShared(
    ctx: { orgId: string; environmentId: string },
    p: SandboxProviderEntry,
    lease: SandboxLease,
    accept: (row: Row | undefined) => row is Row & { handle: SandboxHandle },
    signal: AbortSignal,
  ): Promise<Entered | null> {
    const env = ctx.environmentId;
    try {
      const row = await this.readRow(ctx);
      if (!accept(row)) {
        await lease.release();
        return null;
      }
      // Bump the fence as every acquisition did before phase C: an exclusive holder whose lease
      // expired unnoticed (a stalled sweep) then fails its next write instead of suspending or
      // destroying the instance under this holder. Shared holders never compare it.
      await this.db
        .updateTable("environment_instances")
        .set((eb) => ({ generation: eb("generation", "+", 1) }))
        .where("environment_id", "=", env)
        .execute();
      await this.register(env, lease.token);
      // other holders (any conversation of the environment) may be running: only the dead
      // holders' own commands are killed
      await this.killTagged(env, row.handle, p, await this.claim(env), signal, lease);
      return {
        lease,
        handle: row.handle,
        createdAt: row.created_at.getTime(),
        fsId: row.fs_handle?.id ?? "",
        info: { fresh: false, restarted: false },
      };
    } catch (err) {
      await this.unregister(env, lease.token);
      await lease.release();
      throw err;
    }
  }

  /**
   * Under a just-taken exclusive lease: makes the instance run (file system, create / resume /
   * rebuild when the recorded instance is the one found gone), kills leftovers, then downgrades to
   * a shared lease. Crashed holders' records are claimed here: on an instance just resumed from
   * `suspended` one `killAll` covers them and anything else left (nobody else holds the instance),
   * on a new instance there is nothing to kill, and on one that already ran their tags are killed.
   */
  private async asExclusive(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    lease: SandboxLease,
    gone: Instance | null,
    signal: AbortSignal,
  ): Promise<Entered> {
    const env = ctx.environmentId;
    const sig = AbortSignal.any([signal, lease.signal]);
    try {
      const s = await this.ensure(ctx, p, lease, sig, gone);
      const dead = await this.claim(env);
      if (s.resumed) await this.killLeftovers(env, s.handle, p, sig, dead);
      else if (!s.info.fresh) await this.killTagged(env, s.handle, p, dead, signal, lease);
      if (s.resumed || s.info.fresh) {
        await this.killPendingTasks(env, s.handle, s.createdAt, p, lease.token, ctx.actor, sig);
      }
      const shared = await lease.downgrade();
      await this.register(env, shared.token);
      return {
        lease: shared,
        handle: s.handle,
        createdAt: s.createdAt,
        fsId: s.fsId,
        info: s.info,
      };
    } catch (err) {
      await this.unregister(env, lease.token);
      // releases the lease in whatever kind it has now (also after a downgrade)
      await lease.release();
      throw err;
    }
  }

  /** Ends a holder: unregisters it before releasing its lease, then moves `last_used_at` forward. */
  private async leave(env: string, e: Entered): Promise<void> {
    await this.unregister(env, e.lease.token);
    await e.lease.release();
    await this.db
      .updateTable("environment_instances")
      .set({ last_used_at: sql<Date>`GREATEST(last_used_at, now())` })
      .where("environment_id", "=", env)
      .where("status", "=", "running")
      .execute()
      .catch((err: unknown) =>
        this.log.warn("cannot update sandbox last_used_at", { environmentId: env, err }),
      );
  }

  private async register(env: string, token: string): Promise<void> {
    const ttl = this.config.get().sandbox.limits.maxCommandSeconds * 1000 + HOLDER_TTL_MARGIN_MS;
    await this.leases
      .registerHolder(env, token, ttl)
      .catch((err: unknown) =>
        this.log.warn("cannot record sandbox holder", { environmentId: env, err }),
      );
  }

  private async unregister(env: string, token: string): Promise<void> {
    await this.leases
      .unregisterHolder(env, token)
      .catch((err: unknown) =>
        this.log.warn("cannot clear sandbox holder record", { environmentId: env, err }),
      );
  }

  /** Crashed holders' tags (claimed); a Redis error counts as none. */
  private async claim(env: string): Promise<string[]> {
    try {
      return await this.leases.claimDeadHolders(env);
    } catch (err) {
      this.log.warn("cannot read sandbox holder records", { environmentId: env, err });
      return [];
    }
  }

  /** Kills the commands of crashed holders by their tags (`killTagged`); nothing without tags. */
  private async killTagged(
    env: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    tags: string[],
    signal: AbortSignal,
    lease: SandboxLease,
  ): Promise<void> {
    if (tags.length === 0) return;
    const sig = AbortSignal.any([signal, lease.signal]);
    await this.kill(env, "takeover", () => p.impl.killTagged(handle, tags, sig), sig);
  }

  /** Runs one kill call: gone and abort are thrown, other failures only warned. */
  private async kill(
    environmentId: string,
    why: "takeover" | "resume",
    call: () => Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await call();
      if (why === "takeover") {
        this.log.info(
          "sandbox taken over from a holder that did not finish; leftover commands killed",
          { environmentId },
        );
      }
    } catch (err) {
      if (signal?.aborted || isSandboxGoneError(err)) throw err;
      this.log.warn("cannot kill leftover sandbox commands", { environmentId, err });
    }
  }

  /**
   * Suspends running instances idle longer than `suspendAfterIdleMinutes` or running continuously
   * longer than `maxRunningMinutes`. Skips an environment with any holder; one past
   * `maxRunningMinutes` gets the intent for one poll window (about a second) first. Returns how
   * many it suspended. Called every minute by the `sandbox-suspend-idle` cron.
   */
  async suspendIdle(now: Date): Promise<number> {
    const p = this.providers.current();
    if (!p) return 0;
    const due = this.suspendDue(now, p.plugin);
    const runningBefore = new Date(
      now.getTime() - this.config.get().sandbox.limits.maxRunningMinutes * 60_000,
    );
    const rows = await this.candidates(due);
    let n = 0;
    await inPool(rows, SWEEP_CONCURRENCY, async (c) => {
      const overdue = c.running_since !== null && c.running_since < runningBefore;
      const done = await this.tryLocked(
        c.environment_id,
        async (lease) => {
          const id = c.environment_id;
          const row = await this.db
            .selectFrom("environment_instances")
            .selectAll()
            .where("environment_id", "=", id)
            .where(due)
            .executeTakeFirst();
          if (!row?.handle) return false;
          const fence = { gen: row.generation };
          await p.impl.suspend(row.handle, opSignal(lease));
          if (!(await lease.renew())) throw new SandboxLockLostError(id);
          await this.fenced(lease, id, fence, {
            status: "suspended",
            suspended_at: sql<Date>`now()`,
            running_since: null,
            sweep_failed_at: null,
          });
          this.log.info("sandbox suspended", { environmentId: id });
          return true;
        },
        overdue,
      );
      if (done) n++;
    });
    return n;
  }

  /**
   * Destruction sweep: an instance unused for longer than `destroyAfterInactiveDays` is destroyed
   * (the instance only; the file system is kept and the next use builds a new instance on it); an
   * environment that was deleted, or whose org was deleted, loses its instance and its file system
   * and its row is deleted (as {@link destroyEnvironment} does). Environments with any holder are
   * skipped. Returns how many it destroyed. Called hourly by the `sandbox-destroy-inactive` cron.
   */
  async destroyInactive(now: Date): Promise<number> {
    const p = this.providers.current();
    if (!p) return 0;
    let n = 0;
    const gone = (eb: ExpressionBuilder<KernelDatabase, "environment_instances">) =>
      this.environmentGone(eb);
    await inPool(await this.candidates(gone), SWEEP_CONCURRENCY, async ({ environment_id: id }) => {
      const done = await this.tryLocked(id, async (lease) => {
        const row = await this.db
          .selectFrom("environment_instances")
          .selectAll()
          .where("environment_id", "=", id)
          .where(gone)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p, lease, "environment");
        return true;
      });
      if (done) n++;
    });
    const idle = this.instanceDue(now);
    await inPool(await this.candidates(idle), SWEEP_CONCURRENCY, async ({ environment_id: id }) => {
      const done = await this.tryLocked(id, async (lease) => {
        const row = await this.db
          .selectFrom("environment_instances")
          .selectAll()
          .where("environment_id", "=", id)
          .where(idle)
          .executeTakeFirst();
        if (!row) return false;
        await this.destroyRow(row, p, lease, "instance");
        return true;
      });
      if (done) n++;
    });
    return n;
  }

  /**
   * Destroys the environment's instance, then its file system, then deletes its instance row
   * (environment deletion, offboarding); nothing to do without a row. Waits for the exclusive lease
   * (with intent, so running commands finish and new ones wait) up to 10 minutes. Without a
   * provider it only warns (the destruction sweep finishes a deleted environment later). Files kept
   * by another provider that is not loaded cannot be destroyed: it throws and the row stays.
   */
  async destroyEnvironment(environmentId: string): Promise<void> {
    const row = await this.db
      .selectFrom("environment_instances")
      .select("environment_id")
      .where("environment_id", "=", environmentId)
      .executeTakeFirst();
    if (!row) return;
    const p = this.providers.current();
    if (!p) {
      this.log.warn("cannot destroy environment: no sandbox provider", { environmentId });
      return;
    }
    const lease = await this.leases.acquireExclusive(
      environmentId,
      AbortSignal.timeout(EXCLUSIVE_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      const current = await this.db
        .selectFrom("environment_instances")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .executeTakeFirst();
      if (current) await this.destroyRow(current, p, lease, "environment");
    } finally {
      await lease.release();
    }
  }

  /**
   * Starts the environment over with empty files (after `environment.files_lost`, or on request):
   * under the exclusive lease (waited for like {@link destroyEnvironment}) destroys any instance and
   * the file system (a `lost` one is only dropped), and records no file system; the next use
   * creates a new one. Nothing to do without a row. Throws `sandbox.unavailable` without a provider.
   */
  async resetFileSystem(environmentId: string): Promise<void> {
    const p = this.require();
    const lease = await this.leases.acquireExclusive(
      environmentId,
      AbortSignal.timeout(EXCLUSIVE_WAIT_MS),
      undefined,
      { intent: true },
    );
    try {
      const row = await this.db
        .selectFrom("environment_instances")
        .selectAll()
        .where("environment_id", "=", environmentId)
        .executeTakeFirst();
      if (!row) return;
      const fence = { gen: row.generation };
      const signal = opSignal(lease);
      const prev = await this.destroyInstance(row, p, signal);
      await this.destroyFiles(row, p, signal, true);
      if (!(await lease.renew())) throw new SandboxLockLostError(environmentId);
      await this.fenced(lease, environmentId, fence, {
        fs_handle: null,
        fs_status: "none",
        handle: null,
        status: "none",
        running_since: null,
        suspended_at: null,
        destroyed_at: sql<Date>`now()`,
        sweep_failed_at: null,
        ...prev,
      });
      this.log.info("environment files reset", { environmentId });
    } finally {
      await lease.release();
    }
  }

  /**
   * Under the exclusive lease (before the downgrade), on an instance just resumed from
   * `suspended`: kills every command left in it (`killAll`), crashed holders' (`dead`, already
   * claimed) included. Never on the shared path: other holders may be running commands. A gone
   * instance (`SandboxGoneError`) and an abort are thrown (`withSandbox` rebuilds / ends); other
   * failures are only warned.
   */
  private async killLeftovers(
    environmentId: string,
    handle: SandboxHandle,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    dead: string[],
  ): Promise<void> {
    await this.kill(
      environmentId,
      dead.length > 0 ? "takeover" : "resume",
      () => p.impl.killAll(handle, signal),
      signal,
    );
  }

  /**
   * Under the exclusive lease, right after a resume or a (re)build: kills the sessions of the
   * background tasks marked lost while their process may live on (`kill_pending`), in one exec of
   * `pkill -KILL -s <sid>`, then clears their flags. Tasks of another instance have no process
   * here and are only cleared. A gone instance and an abort are thrown; another failure is warned
   * and leaves the flags of this instance's tasks for the next resume.
   */
  private async killPendingTasks(
    environmentId: string,
    handle: SandboxHandle,
    createdAt: number,
    p: SandboxProviderEntry,
    tag: string,
    actor: SandboxActor,
    signal: AbortSignal,
  ): Promise<void> {
    const rows = await this.background.pendingKills(environmentId);
    if (rows.length === 0) return;
    const mine = rows.filter(
      (r): r is typeof r & { sid: string } =>
        r.sandboxCreatedAt?.getTime() === createdAt && r.sid !== null && SID_RE.test(r.sid),
    );
    let cleared = rows;
    if (mine.length > 0) {
      // pkill exits 1 when the session has no process left: only a higher status is a failure
      const command = `rc=0; for sid in ${mine.map((r) => r.sid).join(" ")}; do pkill -KILL -s "$sid"; c=$?; [ "$c" -le 1 ] || rc=$c; done; exit $rc`;
      try {
        const r = await p.impl.exec(handle, {
          command,
          timeoutMs: PENDING_KILL_TIMEOUT_MS,
          maxOutputBytes: 4096,
          signal,
          tag,
          actor,
        });
        if (r.exitCode !== 0) {
          throw new Error(
            `pkill exited with ${r.exitCode === null ? "no status" : r.exitCode}: ${r.stderr.slice(0, 500)}`,
          );
        }
        this.log.info("lost background tasks killed after a sandbox resume", {
          environmentId,
          tasks: mine.map((t) => t.id),
        });
      } catch (err) {
        if (signal.aborted || isSandboxGoneError(err)) throw err;
        this.log.warn("cannot kill lost background tasks after a sandbox resume", {
          environmentId,
          err,
        });
        const kept = new Set(mine.map((r) => r.id));
        cleared = rows.filter((r) => !kept.has(r.id));
      }
    }
    await this.background.clearKill(cleared.map((r) => r.id));
  }

  private require(): SandboxProviderEntry {
    const p = this.providers.current();
    if (!p) throw sandboxUnavailable();
    return p;
  }

  /**
   * A fenced write: only while the lease holds and the row's generation is still the one read
   * under it (and incremented); otherwise {@link SandboxLockLostError}.
   */
  private async fenced(lease: SandboxLease, id: string, fence: Fence, set: Patch): Promise<Date> {
    if (lease.signal.aborted) throw new SandboxLockLostError(id);
    const r = await this.db
      .updateTable("environment_instances")
      .set({ ...set, generation: fence.gen + 1 })
      .where("environment_id", "=", id)
      .where("generation", "=", fence.gen)
      .returning("created_at")
      .executeTakeFirst();
    if (!r) throw new SandboxLockLostError(id, "generation");
    fence.gen++;
    return r.created_at;
  }

  /** Sweep candidates: those whose last sweep failed come last, the rest least recently used first. */
  private async candidates(
    due: (eb: ExpressionBuilder<KernelDatabase, "environment_instances">) => Expression<SqlBool>,
  ): Promise<{ environment_id: string; running_since: Date | null }[]> {
    return await this.db
      .selectFrom("environment_instances")
      .select(["environment_id", "running_since"])
      .where(due)
      .orderBy(sql`sweep_failed_at ASC NULLS FIRST`)
      .orderBy("last_used_at")
      .limit(SWEEP_BATCH)
      .execute();
  }

  /**
   * One try at the exclusive lease: null → false; else runs `fn`. With `overdue` (past
   * `maxRunningMinutes`) a busy environment gets the intent for about a second, so new commands
   * wait briefly and the sweep gets in if the running ones end. Failures are warned, recorded in
   * `sweep_failed_at` (sorted last next time) and return false.
   */
  private async tryLocked(
    environmentId: string,
    fn: (lease: SandboxLease) => Promise<boolean>,
    overdue = false,
  ): Promise<boolean> {
    let lease: SandboxLease | null;
    try {
      lease = await this.leases.tryExclusive(environmentId);
      if (!lease && overdue) {
        lease = await this.leases
          .acquireExclusive(
            environmentId,
            AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS),
            Math.max(this.pollMs * 2, SWEEP_INTENT_WAIT_MS),
            { intent: true },
          )
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.code === "sandbox.busy") return null;
            throw err;
          });
      }
    } catch (err) {
      this.log.warn("cannot take sandbox lock", { environmentId, err });
      return false;
    }
    if (!lease) return false;
    try {
      return await fn(lease);
    } catch (err) {
      this.log.warn("sandbox maintenance failed; will retry", { environmentId, err });
      await this.db
        .updateTable("environment_instances")
        .set({ sweep_failed_at: sql<Date>`now()` })
        .where("environment_id", "=", environmentId)
        .execute()
        .catch(() => {});
      return false;
    } finally {
      await lease.release();
    }
  }

  /**
   * Under the exclusive lease: make the environment's instance run. `gone`: the instance a holder
   * found gone; when it is still the recorded one it is rebuilt, when another holder already
   * rebuilt it the new one is used.
   */
  private async ensure(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    held: SandboxLease,
    signal: AbortSignal,
    gone: Instance | null,
  ): Promise<{
    handle: SandboxHandle;
    createdAt: number;
    fsId: string;
    info: SandboxUseInfo;
    fence: Fence;
    resumed?: boolean;
  }> {
    const id = ctx.environmentId;
    // Only a live environment of the caller's org gets a row, with the environment's own org; a
    // row made earlier (another use) keeps its file system handle.
    await this.db
      .insertInto("environment_instances")
      .columns(["environment_id", "org_id", "provider", "status"])
      .expression((eb) =>
        eb
          .selectFrom("environments")
          .select((e) => [
            "environments.id",
            "environments.org_id",
            e.val(p.plugin).as("provider"),
            e.val("creating").as("status"),
          ])
          .where("environments.id", "=", id)
          .where("environments.org_id", "=", ctx.orgId)
          .where("environments.deleted_at", "is", null),
      )
      .onConflict((oc) => oc.column("environment_id").doNothing())
      .execute();
    // Under the lease: a use that waited behind destroyEnvironment (or raced a deletion) must not
    // bring the environment's provider resources back.
    const live = await this.db
      .selectFrom("environments")
      .select("id")
      .where("id", "=", id)
      .where("org_id", "=", ctx.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!live) throw environmentNotFound();
    const row = await this.db
      .selectFrom("environment_instances")
      .selectAll()
      .where("environment_id", "=", id)
      .executeTakeFirst();
    if (!row) throw environmentNotFound();
    if (row.org_id !== ctx.orgId) throw this.foreign(ctx);
    const fence = { gen: row.generation };
    // Every acquisition first does a fenced increment: an old holder whose lease expired while it
    // kept running (a stalled sweep) then fails its next write.
    await this.fenced(held, id, fence, {});
    if (row.fs_status === "lost") throw environmentFilesLost();
    if (
      row.provider !== null &&
      row.provider !== p.plugin &&
      (row.fs_status !== "none" || row.handle !== null)
    ) {
      throw otherProvider(row.provider);
    }
    if (
      row.provider !== null &&
      row.provider !== p.plugin &&
      row.fs_status === "none" &&
      row.status === "creating"
    ) {
      // a create by the previous provider ended before its file system was recorded: that
      // provider may have made it by name, and nothing else would ever destroy it
      await this.dropUnrecordedFiles(id, row.provider, signal);
    }
    const handle = row.handle;
    const createdAt = row.created_at.getTime();
    const fsId = row.fs_handle?.id ?? "";
    if (handle && isInstance(row, gone) && row.status === "running") {
      const created = await this.create(ctx, p, held, row, fence, signal);
      return { ...created, info: { fresh: true, restarted: true }, fence };
    }
    if (handle && row.status === "running") {
      return { handle, createdAt, fsId, info: { fresh: false, restarted: false }, fence };
    }
    if (handle && row.status === "suspended") {
      const r = await p.impl.resume(handle, signal);
      if (r === "resumed") {
        await this.fenced(held, id, fence, {
          status: "running",
          running_since: sql<Date>`now()`,
          suspended_at: null,
          sweep_failed_at: null,
        });
        return {
          handle,
          createdAt,
          fsId,
          info: { fresh: false, restarted: false },
          fence,
          resumed: true,
        };
      }
      this.log.info("sandbox instance is gone at the provider; recreating", {
        environmentId: id,
      });
    }
    const created = await this.create(ctx, p, held, row, fence, signal);
    // had_instance only ever becomes true: any earlier instance (even if a rebuild failed since)
    // makes this one a restart on the kept files
    return {
      ...created,
      info: { fresh: true, restarted: row.had_instance && row.fs_status === "ready" },
      fence,
    };
  }

  /**
   * Under the lease: fenced reset to `creating`, the file system when there is none
   * (`createFileSystem`, its handle written fenced), then the instance on it, then a fenced write
   * of the instance handle. `FileSystemGoneError` from `create` records `fs_status = 'lost'` and
   * throws `environment.files_lost`. When the instance handle cannot be written (lease lost), the
   * new instance is destroyed (best effort) before {@link SandboxLockLostError} is thrown.
   */
  private async create(
    ctx: SandboxUseContext,
    p: SandboxProviderEntry,
    held: SandboxLease,
    row: Row,
    fence: Fence,
    signal: AbortSignal,
  ): Promise<Instance & { fsId: string }> {
    const id = ctx.environmentId;
    const name = environmentResourceName(id);
    await this.fenced(held, id, fence, {
      org_id: ctx.orgId,
      provider: p.plugin,
      handle: null,
      status: "creating",
      last_used_at: sql<Date>`now()`,
      running_since: null,
      suspended_at: null,
      destroyed_at: null,
      sweep_failed_at: null,
    });
    // the org's effective limits apply at creation only, so a changed setting reaches only
    // instances created afterwards
    const limits = await this.orgLimits(ctx.orgId);
    const cfg = this.config.get().sandbox;
    let fs: FileSystemHandle | null =
      row.fs_status === "ready" && (row.provider === null || row.provider === p.plugin)
        ? row.fs_handle
        : null;
    if (fs === null) {
      fs = await p.impl.createFileSystem({ name, limits, signal });
      // A lost lease fails this write and leaves the file system alone: createFileSystem returns
      // the existing one for a name, so the new holder may already use it, files and all.
      await this.fenced(held, id, fence, {
        provider: p.plugin,
        fs_handle: JSON.stringify(fs),
        fs_status: "ready",
      });
      this.log.info("environment file system created", { environmentId: id, provider: p.plugin });
    }
    let handle: SandboxHandle;
    try {
      handle = await p.impl.create({
        name,
        ...(cfg.image !== undefined && { image: cfg.image }),
        limits,
        fileSystem: fs,
        signal,
      });
    } catch (err) {
      if (!isFileSystemGoneError(err)) throw err;
      this.log.warn("environment file system is gone at the provider; its files are lost", {
        environmentId: id,
        provider: p.plugin,
      });
      await this.fenced(held, id, fence, { fs_status: "lost", status: "none" });
      throw environmentFilesLost();
    }
    let createdAt: Date;
    try {
      createdAt = await this.fenced(held, id, fence, {
        status: "running",
        handle: JSON.stringify(handle),
        had_instance: true,
        created_at: sql<Date>`now()`,
        running_since: sql<Date>`now()`,
        last_used_at: sql<Date>`now()`,
      });
    } catch (e) {
      // Lease lost before the handle was recorded: destroy the new instance (best effort) so it
      // does not leak. A provider that reuses instances by name (Ruling M10) may then hit the one
      // the new holder just resumed or created; that heals: its next provider call throws
      // SandboxGoneError (or resume returns gone) and withSandbox rebuilds in place. The file
      // system is never touched here.
      await p.impl.destroy(handle, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)).catch((err: unknown) =>
        this.log.warn("cannot destroy sandbox created after the lock was lost", {
          environmentId: id,
          err,
        }),
      );
      throw e;
    }
    this.log.info("sandbox created", { environmentId: id, provider: p.plugin });
    return { handle, createdAt: createdAt.getTime(), fsId: fs.id };
  }

  /**
   * Destroys the file system another provider may have made under the environment's name without
   * the kernel recording it (`destroyFileSystemByName`; not there is success). That provider not
   * loaded, or a failure, is only warned (the files may leak there) so the environment stays
   * usable; an abort is thrown.
   */
  private async dropUnrecordedFiles(
    id: string,
    provider: string,
    signal: AbortSignal,
  ): Promise<void> {
    const old = this.providers.lookup(provider);
    if (!old) {
      this.log.warn(
        "environment file system may have been made by a provider that is not loaded; it may leak",
        { environmentId: id, provider },
      );
      return;
    }
    try {
      await old.destroyFileSystemByName(environmentResourceName(id), signal);
    } catch (err) {
      if (signal.aborted) throw err;
      this.log.warn("cannot destroy the file system of the previous sandbox provider", {
        environmentId: id,
        provider,
        err,
      });
    }
  }

  /**
   * Destroys an instance of another provider with that provider: still loaded and destroyed →
   * false; otherwise warns and returns true (the record must be kept).
   */
  private async retire(
    id: string,
    provider: string,
    handle: SandboxHandle,
    signal: AbortSignal,
  ): Promise<boolean> {
    const old = this.providers.lookup(provider);
    if (old) {
      try {
        await old.destroy(
          handle,
          AbortSignal.any([signal, AbortSignal.timeout(SWEEP_OP_TIMEOUT_MS)]),
        );
        return false;
      } catch (err) {
        this.log.warn("cannot destroy sandbox instance of the previous provider", {
          environmentId: id,
          provider,
          err,
        });
        return true;
      }
    }
    this.log.warn(
      "sandbox was created by another provider that is not loaded; its instance may leak",
      { environmentId: id, provider },
    );
    return true;
  }

  /**
   * Under the lease: destroys the row's instance (and a leaked one of an earlier provider). An
   * instance without a handle (a create that ended before the handle was recorded) is destroyed by
   * name. Returns the `prev_*` patch for instances that could not be destroyed.
   */
  private async destroyInstance(
    row: Row,
    p: SandboxProviderEntry,
    signal: AbortSignal,
  ): Promise<Patch> {
    const id = row.environment_id;
    const owner = row.provider ?? p.plugin;
    let prev: Patch = {};
    if (row.handle && owner === p.plugin) {
      await p.impl.destroy(row.handle, signal);
    } else if (row.handle && row.status !== "destroyed") {
      if (await this.retire(id, owner, row.handle, signal)) {
        prev = { prev_provider: owner, prev_handle: JSON.stringify(row.handle) };
      }
    } else if (!row.handle && row.status === "creating") {
      // the provider may have built it already: only the name finds it
      const impl = owner === p.plugin ? p.impl : this.providers.lookup(owner);
      await impl?.destroyByName(environmentResourceName(id), signal);
    }
    if (row.prev_handle && row.prev_provider && !("prev_handle" in prev)) {
      if (!(await this.retire(id, row.prev_provider, row.prev_handle, signal))) {
        prev = { prev_provider: null, prev_handle: null };
      }
    }
    return prev;
  }

  /**
   * Under the lease: destroys the row's file system with the provider that made it (by name when
   * no handle was recorded: `createFileSystem` may have finished before the kernel stopped). With
   * that provider not loaded it throws (the row must stay for a retry), or with `lenient` only
   * warns (the files leak at that provider).
   */
  private async destroyFiles(
    row: Row,
    p: SandboxProviderEntry,
    signal: AbortSignal,
    lenient = false,
  ): Promise<void> {
    const id = row.environment_id;
    const owner = row.provider ?? p.plugin;
    const impl = owner === p.plugin ? p.impl : this.providers.lookup(owner);
    if (!impl) {
      if (row.fs_handle === null) return;
      if (!lenient) {
        throw new Error(
          `cannot destroy the file system of environment ${id}: its sandbox provider ${owner} is not loaded`,
        );
      }
      this.log.warn("environment file system of a provider that is not loaded is leaked", {
        environmentId: id,
        provider: owner,
      });
      return;
    }
    if (row.fs_handle !== null) await impl.destroyFileSystem(row.fs_handle, signal);
    else await impl.destroyFileSystemByName(environmentResourceName(id), signal);
  }

  /**
   * Under the lease: `instance` destroys the instance and marks the row `destroyed` (the file
   * system stays); `environment` also destroys the file system and deletes the row.
   */
  private async destroyRow(
    row: Row,
    p: SandboxProviderEntry,
    held: SandboxLease,
    mode: "instance" | "environment",
  ): Promise<void> {
    const id = row.environment_id;
    const fence = { gen: row.generation };
    const signal = opSignal(held);
    const prev = await this.destroyInstance(row, p, signal);
    if (mode === "environment") await this.destroyFiles(row, p, signal);
    if (!(await held.renew())) throw new SandboxLockLostError(id);
    if (mode === "instance") {
      await this.fenced(held, id, fence, {
        status: "destroyed",
        destroyed_at: sql<Date>`now()`,
        running_since: null,
        sweep_failed_at: null,
        ...prev,
      });
      this.log.info("sandbox instance destroyed", { environmentId: id });
      return;
    }
    const r = await this.db
      .deleteFrom("environment_instances")
      .where("environment_id", "=", id)
      .where("generation", "=", fence.gen)
      .executeTakeFirst();
    if (Number(r.numDeletedRows) !== 1) throw new SandboxLockLostError(id, "generation");
    this.log.info("environment destroyed", { environmentId: id });
  }

  /** Due for suspension: made by this provider, running, and idle or running for too long. */
  private suspendDue(now: Date, plugin: string) {
    const lim = this.config.get().sandbox.limits;
    const idleBefore = new Date(now.getTime() - lim.suspendAfterIdleMinutes * 60_000);
    const runningBefore = new Date(now.getTime() - lim.maxRunningMinutes * 60_000);
    return (eb: ExpressionBuilder<KernelDatabase, "environment_instances">) =>
      eb.and([
        eb("status", "=", "running"),
        eb("provider", "=", plugin),
        eb.or([eb("last_used_at", "<", idleBefore), eb("running_since", "<", runningBefore)]),
      ]);
  }

  /** The environment was deleted, or its org was: the instance and the files go. */
  private environmentGone(
    eb: ExpressionBuilder<KernelDatabase, "environment_instances">,
  ): Expression<SqlBool> {
    return eb.or([
      eb.exists(
        eb
          .selectFrom("environments")
          .select("environments.id")
          .whereRef("environments.id", "=", "environment_instances.environment_id")
          .where("environments.deleted_at", "is not", null),
      ),
      eb.exists(
        eb
          .selectFrom("orgs")
          .select("orgs.id")
          .whereRef("orgs.id", "=", "environment_instances.org_id")
          .where("orgs.deleted_at", "is not", null),
      ),
    ]);
  }

  /** Due for instance destruction: an instance (or a create in progress) unused for too long. */
  private instanceDue(now: Date) {
    const days = this.config.get().sandbox.limits.destroyAfterInactiveDays;
    const before = new Date(now.getTime() - days * 24 * 3_600_000);
    return (eb: ExpressionBuilder<KernelDatabase, "environment_instances">) =>
      eb.and([
        eb("status", "in", ["creating", "running", "suspended"]),
        eb("last_used_at", "<", before),
      ]);
  }
}
