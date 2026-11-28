import { randomBytes } from "node:crypto";
import {
  DEVICE_SERVICE_ROLL_CHECK,
  DeviceAccessError,
  type DeviceAccessScope,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
  deviceServiceFilesDigest,
  deviceServiceId,
  isLoopbackGrantHost,
  type Logger,
  type LoopbackGrantView,
  type NetworkBlockLayer,
  parseRollCheck,
  parseToolKey,
  type ServiceBlockedHost,
  type ToolCallContext,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { unattendedRunOf } from "../automations/unattended.js";
import type { ReviewRecord } from "../conversations/events.js";
import { DeviceAccess } from "../devices/access.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { DevicesService } from "../devices/devices.service.js";
import { ApiError } from "../errors.js";
import { isExtensionEnabled } from "../extensions/enabled.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { currentExecutionClaim } from "../runtime/run-execution.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { assertServiceSpec, DeviceServices } from "../sandbox/device-services.js";
import {
  isDatabasePort,
  type LoopbackGrantKey,
  type LoopbackGrantRow,
  LoopbackGrants,
} from "../sandbox/loopback-grants.js";
import { DeviceProviders } from "../sandbox/providers.js";
import { CommandReviewService, LOOPBACK_UNATTENDED_WHY } from "../sandbox/review/review.service.js";
import type { SandboxUseContext } from "../sandbox/use-context.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import { mapSandboxError } from "../tools/builtins/sandbox/common.js";
import {
  attachCallScope,
  type CallScope,
  callScopeOf,
  serviceHostKey,
  strongerLayer,
  whileDeviceStarting,
} from "../tools/call-scope.js";
import { QuestionsService } from "../tools/questions.service.js";

/** The layers a service may report a refused host with (`ServiceBlockedHost.layer`). */
const BLOCK_LAYERS: readonly NetworkBlockLayer[] = ["device", "org", "address", "unknown"];

/** What every `ctx.deviceAccess` call refuses a run another member triggered with. */
export const DEVICE_ACCESS_NOT_OWNER_TEXT =
  "Browser tools only run for the conversation's owner on their own device.";

/** A viewer ticket's key prefix (`capk:device-stream-ticket:<id>`, single use, GETDEL). */
export const DEVICE_STREAM_TICKET_PREFIX = "capk:device-stream-ticket:";

/** How long a viewer ticket lives, in seconds. */
export const DEVICE_STREAM_TICKET_TTL_SECONDS = 60;

/** What a viewer ticket records: the viewer opens exactly this service of exactly this device. */
export interface DeviceStreamTicket {
  orgId: string;
  accountId: string;
  conversationId: string;
  /**
   * The root of `conversationId`'s tree at mint (itself outside sub-agents): the viewer context
   * the kernel writes first on the service stream names it.
   */
  rootConversationId: string;
  deviceId: string;
  providerName: string;
  service: string;
  extension: string;
}

/** The calling extension and the services its approved manifest declares. */
export interface DeviceAccessCaller {
  extension: string;
  services: readonly string[];
  /** The package the calling instance was loaded from (null or absent: not an install record). */
  sha256?: string | null;
  /** True once the calling instance is being replaced or unloaded (it drains its calls). */
  superseded?: () => boolean;
  /**
   * The approved manifest declares `permissions.deviceAccess.loopbackPorts: true`: its services may
   * be granted local ports of the device (browser loopback port grants design).
   */
  loopbackPorts: boolean;
}

/**
 * The longest a service's busy answer holds a roll onto the same files, counted from the first
 * busy answer (`capk:device-service-roll-held:<device>:<service>:<digest>`, the first answer's
 * time, a TTL of twice this).
 */
const ROLL_HOLD_CAP_MS = 60 * 60_000;
const ROLL_HOLD_PREFIX = "capk:device-service-roll-held:";

/** How long the roll check waits for a running service's answer ({@link DEVICE_SERVICE_ROLL_CHECK}). */
const ROLL_CHECK_TIMEOUT_MS = 5_000;

/** The device a scope-based call works on, after the owner checks. */
interface ScopedDevice {
  orgId: string;
  conversationId: string;
  rootConversationId: string;
  deviceId: string;
  provider: string;
}

/** Maps the device resolution's API errors to the extension's refusal codes. */
function refusal(e: unknown, log: Pick<Logger, "warn">): unknown {
  if (e instanceof ApiError) {
    if (e.code === "device.not_found" || e.code === "sandbox.unavailable")
      return new DeviceAccessError("no_device", e.message, { cause: e });
    if (e.code === "device.unavailable")
      return new DeviceAccessError("provider_unavailable", e.message, { cause: e });
  }
  // every other device or provider failure as the sandbox tools say it (the provider cannot be
  // reached, the machine is offline or outdated, the outcome is unknown, ...): an actionable
  // ToolError the extension passes on, never its own guess
  return mapSandboxError(e, log);
}

/** How long the refresh of one service after an allowlist change may take. */
const REFRESH_TIMEOUT_MS = 30_000;

/**
 * The launch as it runs: `env K=V … node <codeDir ?? stateDir>/<entry> <args…>` (no `env` without
 * env): the entry runs from the service's code directory when the provider keeps code apart.
 */
function launchArgv(spec: DeviceServiceSpec, status: DeviceServiceStatus): string[] {
  const env = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);
  return [
    ...(env.length > 0 ? ["env", ...env] : []),
    "node",
    launchEntry(spec, status),
    ...spec.args,
  ];
}

/** The absolute entry a launch runs: `<codeDir ?? stateDir>/<entry>`. */
function launchEntry(spec: DeviceServiceSpec, status: DeviceServiceStatus): string {
  const dir = status.codeDir ?? status.stateDir;
  return `${dir.replace(/\/+$/, "")}/${spec.entry}`;
}

/** A POSIX shell word for the review's command text (bare when it needs no quoting). */
const shellWord = (s: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `ctx.deviceAccess` (browser use spec §7): an extension's device services in the conversation's
 * device, limited to the conversation's owner on their own personal device and to the service
 * names the extension's approved manifest declares. The provider sees each service by its id
 * (`<extension>.<name>`, `deviceServiceId`), so two extensions declaring the same name never
 * reach each other's process; the extension sees only its own names. A service launch passes the command review
 * (fail closed: only `allow` starts it), once per start; requests ride the provider's request
 * path; refused hosts land in the call scope for the pipeline's network ask; viewer tickets are
 * single-use Redis records; the allowlist write and the handoff answer go through the device page's
 * and the questions' own services (their checks and audits apply).
 */
@Injectable()
export class DeviceAccessService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(DeviceServices) private readonly services: DeviceServices,
    @Inject(CommandReviewService) private readonly review: Pick<CommandReviewService, "review">,
    @Inject(ConversationDevices)
    private readonly devices: Pick<ConversationDevices, "forTool" | "reviewFacts">,
    @Inject(DeviceAccess) private readonly access: Pick<DeviceAccess, "usable">,
    @Inject(DevicesService)
    private readonly deviceWrites: Pick<DevicesService, "addNetworkHostsIn">,
    @Inject(QuestionsService) private readonly questions: Pick<QuestionsService, "answer">,
    @Inject(DeviceProviders) private readonly providers: Pick<DeviceProviders, "forDevice">,
    @Inject(KERNEL_LOGGER) private readonly log: Logger,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "current">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LoopbackGrants)
    private readonly loopback: Pick<
      LoopbackGrants,
      "grantIn" | "revoke" | "liveForRoot" | "refusalNow"
    >,
    /** A panel grant settles the agent's pending ask for the same port. */
    @Inject(ApprovalsService)
    private readonly approvals: Pick<ApprovalsService, "settleLoopbackAsks">,
  ) {}

  private get db() {
    return this.kdb.db;
  }

  /**
   * Starts the service in the call's device, or finds it running. An `ifRunning` ensure first
   * (never starts anything): a running service is kept with no review. A stopped one is
   * launched only after the command review saw the command as it runs
   * (`env K=V … node <codeDir ?? stateDir>/<entry> <args…>`, the state directory as its working
   * directory) and allowed it; anything else refuses it (fail closed). The verdict is recorded
   * on the call (the call scope) and a start is audited `device.service_started`.
   */
  async ensureService(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    spec: DeviceServiceSpec,
  ): Promise<DeviceServiceStatus> {
    // a timeout while this runs says the device was still starting (the tool pipeline's text)
    return whileDeviceStarting(call, () => this.ensureServiceNow(caller, call, spec));
  }

  private async ensureServiceNow(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    spec: DeviceServiceSpec,
  ): Promise<DeviceServiceStatus> {
    assertDeclared(caller, spec.name);
    assertCallOwner(call);
    // a watcher only looks: it never starts or resumes anything (browser long waits spec §5.3)
    if (callScopeOf(call)?.watch === true)
      throw new Error(
        `plugin ${caller.extension}: ctx.deviceAccess.ensureService is not allowed in a tool watcher; a watcher's requests only reach a running service`,
      );
    const name = spec.name;
    // the provider gets the service by its id: the extension's name, namespaced
    const providerSpec: DeviceServiceSpec = {
      ...spec,
      name: deviceServiceId(caller.extension, name),
    };
    assertServiceSpec(providerSpec);
    const scope = callScopeOf(call);
    const facts = scope?.facts;
    if (scope === null || facts === undefined)
      throw new Error(
        `plugin ${caller.extension}: ctx.deviceAccess.ensureService needs the tool call context the kernel passed to the handler`,
      );
    const use = await this.callUse(call, facts.rootConversationId, scope);
    const ensure = async (ifRunning: boolean): Promise<DeviceServiceStatus> => {
      try {
        return asNamed(
          await this.services.ensure(use, providerSpec, call.signal, { ifRunning }),
          name,
        );
      } catch (e) {
        throw refusal(e, this.log);
      }
    };
    // race-free: the provider keeps a running service and never starts a stopped one here
    // a service running other files (the extension was upgraded since it started) gets a start
    // like a stopped one, reviewed below; the provider then restarts it on the spec's files (a
    // roll). The digest is cached per files object (a browser's files are megabytes).
    const digest = deviceServiceFilesDigest(providerSpec.files);
    const runsSpec = (st: DeviceServiceStatus) =>
      st.filesDigest === undefined || st.filesDigest === digest;
    const found = await ensure(true);
    if (found.state === "running") {
      if (runsSpec(found)) return found;
      // never a roll back to older files, nor one under a person at work: kept, rolled later
      if (await this.holdRoll(caller, use, providerSpec.name, name, digest, call.signal))
        return found;
    }
    // A stopped service is started on the caller's files even when the caller is draining (its
    // call still needs the service): the next call of the current instance rolls it forward, one
    // restart more during an upgrade.
    const reviewFacts = await this.devices.reviewFacts(
      call.orgId,
      facts.rootConversationId,
      call.conversationId,
    );
    if (reviewFacts === null || reviewFacts.deviceId !== use.deviceId)
      throw new DeviceAccessError("no_device", "The conversation has no device to run in.");
    const argv = launchArgv(spec, found);
    const verdict = await this.review.review({
      orgId: call.orgId,
      conversationId: facts.rootConversationId,
      runId: facts.runId,
      accountId: call.accountId,
      toolKey: "Bash",
      input: { command: argv.map(shellWord).join(" ") },
      // the kernel's own fact: this command is the extension's declared service (`allow.service`)
      serviceEntry: launchEntry(spec, found),
      mode: reviewFacts.mode,
      // the command runs in the service's state directory
      workspace: found.stateDir,
      home: reviewFacts.home,
      deviceHome: reviewFacts.deviceHome,
      attended: !facts.unattended && call.accountId === reviewFacts.ownerAccountId,
      step: facts.step,
      callId: call.callId,
      signal: call.signal,
      agentId: call.agentId,
      agentVersion: facts.agentVersion,
      ...(facts.conversationKind !== undefined && { conversationKind: facts.conversationKind }),
      ...(facts.parent !== undefined && {
        parentRunId: facts.parent.runId,
        ...(facts.parent.budgetRunId !== undefined && { budgetRunId: facts.parent.budgetRunId }),
        parent: {
          conversationId: facts.parent.conversationId,
          runId: facts.parent.runId,
          callId: facts.parent.callId,
        },
      }),
    });
    const allowed = verdict.decision === "allow";
    const record: ReviewRecord = {
      decision: allowed ? "allow" : "deny",
      by: verdict.by,
      rule: verdict.rule,
      reason: verdict.reason,
    };
    scope.review = record;
    // fail closed: an ask has nobody to answer it here, and a deny is a deny
    if (!allowed)
      throw new ToolError(
        `The device service ${name} was not started: the command review did not allow its launch (${verdict.reason}). Ask the user to check the device's settings.`,
      );
    // another call may have started it since the first look (that call audits its own start):
    // found running now, this call started nothing and audits nothing
    const raced = await ensure(true);
    if (raced.state === "running" && runsSpec(raced)) return raced;
    // another call started it on other files meanwhile, or the review took long enough for a
    // person to take over: the same holds as at the first look
    if (
      raced.state === "running" &&
      (await this.holdRoll(caller, use, providerSpec.name, name, digest, call.signal))
    )
      return raced;
    const started = await ensure(false);
    // a provider that reports the digest but kept the old files would have every later call
    // reviewed again for nothing: a broken provider, said as such
    if (started.state === "running" && !runsSpec(started)) {
      this.log.error("device provider kept a service on other files after a start", {
        extension: caller.extension,
        service: name,
        deviceId: use.deviceId,
        running: started.filesDigest,
        wanted: digest,
      });
      throw new ToolError(
        `The device service ${name} still runs its earlier files after a restart was asked for; the device's provider did not restart it. Ask the user to update the device's provider plugin, then retry.`,
      );
    }
    // audited only when this ensure started it: the service was stopped (no startedAt) or ran
    // other files just before, and runs with a new startedAt now; one row per start, also when
    // two replicas' calls both got here (the second finds the first one's process)
    if (started.state !== "running" || started.startedAt === raced.startedAt) return started;
    // the start's own row, written by whichever call saw it first (a check, then the insert: two
    // replicas reaching it in the same milliseconds may still both write)
    const seen = await this.db
      .selectFrom("audit_events")
      .select("id")
      .where("org_id", "=", call.orgId)
      .where("action", "=", "device.service_started")
      .where("target", "=", use.deviceId)
      .where(sql<string>`detail->>'serviceId'`, "=", providerSpec.name)
      .where(sql<string>`detail->>'startedAt'`, "=", started.startedAt)
      // the start just happened: the (org_id, at) index keeps the range tiny
      .where("at", ">=", sql<Date>`now() - interval '10 minutes'`)
      .executeTakeFirst();
    if (seen !== undefined) return started;
    const rolled = raced.state === "running";
    await audit(this.db, {
      actorAccountId: call.accountId,
      orgId: call.orgId,
      action: "device.service_started",
      target: use.deviceId,
      detail: {
        extension: caller.extension,
        service: name,
        serviceId: providerSpec.name,
        deviceId: use.deviceId,
        argv,
        decision: record.decision,
        rule: record.rule,
        // a roll replaces a process running other files; a start follows a stopped service
        reason: rolled ? "files_changed" : "start",
        startedAt: started.startedAt,
        filesDigest: started.filesDigest ?? digest,
        ...(rolled && {
          replacedStartedAt: raced.startedAt,
          ...(raced.filesDigest !== undefined && { replacedFilesDigest: raced.filesDigest }),
        }),
      },
    });
    return started;
  }

  /**
   * Whether a roll of a running service onto `digest` is held now ({@link rollHeld}), logged
   * with the reason when it is.
   */
  private async holdRoll(
    caller: DeviceAccessCaller,
    use: SandboxUseContext,
    serviceId: string,
    name: string,
    digest: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const held = await this.rollHeld(caller, use, serviceId, digest, signal);
    if (held === null) return false;
    this.log.info("device service roll deferred", {
      extension: caller.extension,
      service: name,
      deviceId: use.deviceId,
      reason: held,
    });
    return true;
  }

  /**
   * Why a running service on other files is kept for now, or null to roll it:
   * - the calling instance is being replaced or is not the one this replica runs now (it drains),
   *   or not the version the deployment has enabled (a replica that has not reloaded yet): its
   *   files are older, and rolling to them would flip the service back and forth;
   * - the service answers the roll check busy (a person controls it or a handoff waits), for at
   *   most {@link ROLL_HOLD_CAP_MS} after the first busy answer for these files (a Redis record
   *   with a TTL: a service that stays busy, a handoff nobody ends, never holds an upgrade for
   *   good).
   * A failed check (an older service, no answer) lets the roll go ahead.
   */
  private async rollHeld(
    caller: DeviceAccessCaller,
    use: SandboxUseContext,
    serviceId: string,
    digest: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (caller.superseded?.() === true) return "superseded: the calling instance is draining";
    const sha = caller.sha256 ?? null;
    if (sha !== null) {
      const loaded = this.registry.current(caller.extension);
      if (loaded === undefined || (loaded.sha256 ?? null) !== sha)
        return "superseded: this replica runs another package of the extension";
      // deployment-wide: the extension's install record, not an org's data
      const row = await this.db
        .selectFrom("extension_installs")
        .select("sha256")
        .where("name", "=", caller.extension)
        .where("desired_state", "=", "enabled")
        .executeTakeFirst();
      if (row !== undefined && row.sha256 !== sha)
        return "stale: the deployment enabled another package of the extension";
    }
    try {
      const answer = await this.services.request(
        use,
        serviceId,
        new TextEncoder().encode(DEVICE_SERVICE_ROLL_CHECK),
        ROLL_CHECK_TIMEOUT_MS,
        AbortSignal.any([signal, AbortSignal.timeout(ROLL_CHECK_TIMEOUT_MS)]),
      );
      const check = parseRollCheck(answer);
      if (check.busy) {
        const key = `${ROLL_HOLD_PREFIX}${use.deviceId}:${serviceId}:${digest}`;
        const now = Date.now();
        // the first busy answer's time, kept by whichever replica wrote it first (HSETNX)
        if ((await this.redis.hsetnx(key, "first", String(now))) === 1)
          await this.redis.pexpire(key, ROLL_HOLD_CAP_MS * 2);
        const first = Number(await this.redis.hget(key, "first"));
        if (Number.isFinite(first) && now - first >= ROLL_HOLD_CAP_MS) {
          this.log.warn("device service roll no longer held by its busy answer", {
            extension: caller.extension,
            serviceId,
            deviceId: use.deviceId,
            heldMs: now - first,
            reason: check.reason,
          });
          return null;
        }
        return `busy: ${check.reason ?? "the service is in use"}`;
      }
    } catch (e) {
      if (signal.aborted) throw e;
      // an older service, a slow one: the roll goes ahead
    }
    return null;
  }

  /**
   * One request to the service's socket in the call's device. `ifRunning` (forced in a watcher's
   * call scope): only a running instance with the service running answers, else
   * `DeviceAccessError("not_running")`; nothing is resumed or started.
   */
  async request(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    req: { service: string; body: Uint8Array; timeoutMs: number; ifRunning?: boolean },
  ): Promise<Uint8Array> {
    assertDeclared(caller, req.service);
    assertCallOwner(call);
    const scope = callScopeOf(call) ?? attachCallScope(call);
    const ifRunning = req.ifRunning === true || scope.watch === true;
    const root = scope.facts?.rootConversationId ?? (await this.rootOf(call.conversationId));
    const use = await this.callUse(call, root, scope);
    // from here the service may act: a timeout of this call never says nothing was sent
    scope.reached = true;
    try {
      return await this.services.request(
        use,
        deviceServiceId(caller.extension, req.service),
        req.body,
        req.timeoutMs,
        call.signal,
        { ifRunning },
      );
    } catch (e) {
      throw refusal(e, this.log);
    }
  }

  /**
   * Records refused hosts with their layers in the call scope (synchronous: the pipeline reads it
   * once the handler returns) on the device this call's own `ctx.deviceAccess` calls resolved, if
   * any. A malformed entry (not a non-empty host with a known layer) is dropped; a host reported
   * again keeps its most restrictive layer, so a later report never makes it grantable.
   *
   * A loopback refusal (layer `address`, class `loopback`, a loopback grant host, an integer port
   * in 1–65535) of an extension declaring `permissions.deviceAccess.loopbackPorts` also lands as
   * the scope's `loopback` entry (the first such entry of the call wins), naming the service it
   * came from: `opts.service` when declared, else the extension's only declared service; with no
   * such service it does not. Every other port and class is dropped: the entry is an address host
   * like any other.
   */
  reportBlockedHosts(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    hosts: ServiceBlockedHost[],
    opts?: { url?: string; service?: string },
  ): void {
    assertCallOwner(call);
    const scope = callScopeOf(call) ?? attachCallScope(call);
    // a watcher's reports reach no call result: the resumed handler reports what it sees
    if (scope.watch === true) return;
    const valid = (Array.isArray(hosts) ? hosts : []).filter(
      (h): h is ServiceBlockedHost =>
        typeof h === "object" &&
        h !== null &&
        typeof h.host === "string" &&
        h.host.length > 0 &&
        BLOCK_LAYERS.includes(h.layer),
    );
    if (valid.length === 0) return;
    const url = typeof opts?.url === "string" && opts.url.length > 0 ? opts.url : null;
    if (scope.blocked === null)
      scope.blocked = { deviceId: scope.device, hosts: new Map(), url, loopback: null };
    else if (url !== null) scope.blocked.url = url;
    const seen = scope.blocked.hosts;
    for (const h of valid) {
      const key = serviceHostKey(h.host);
      const had = seen.get(key);
      seen.set(key, had === undefined ? h.layer : strongerLayer(had, h.layer));
    }
    if (scope.blocked.loopback !== null || !caller.loopbackPorts) return;
    const service = reportedService(caller, opts?.service);
    if (service === null) return;
    const entry = valid.find(
      (h) =>
        h.layer === "address" &&
        h.class === "loopback" &&
        isLoopbackGrantHost(h.host) &&
        Number.isInteger(h.port) &&
        (h.port as number) >= 1 &&
        (h.port as number) <= 65535,
    );
    if (entry === undefined) return;
    scope.blocked.loopback = {
      serviceId: deviceServiceId(caller.extension, service),
      host: entry.host,
      port: entry.port as number,
    };
  }

  /**
   * Grants the scope conversation's root a local port of its device for one service (the owner's
   * click in the panel, source `owner-panel`): owner only, refused with `loopback_unavailable`
   * when the device's outside-sandbox ceilings or its provider do not allow it now
   * (`loopbackRefusal`). The record is written in its own transaction
   * (`LoopbackGrants.grantIn`, which owes the refresh); the running service then gets the live set
   * at once, best effort (the owed refresh job is the backstop).
   */
  async grantLoopbackPort(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { service: string; port: number },
  ): Promise<LoopbackGrantView> {
    const { d, key } = await this.loopbackKey(caller, scope, scope.port);
    const unavailable = (why: string) =>
      new DeviceAccessError(
        "loopback_unavailable",
        `Port ${scope.port} on the device cannot be opened to the device service ${scope.service}: ${why}.`,
      );
    // a panel click never happens inside a run's execution: a tool step granting itself a port
    // as the owner's panel is refused (its refusal reported with reportBlockedHosts asks instead)
    if (currentExecutionClaim() !== undefined)
      throw unavailable(
        "a tool call cannot grant a local port as the owner's panel; report the refused port with ctx.deviceAccess.reportBlockedHosts so the conversation's permission profile decides",
      );
    // the kernel's own record of the tree's origin: an automation's conversation, or a run of an
    // automation active in it now, has no one to grant a port (the ask's unattended refusal)
    if (await this.unattendedTree(d)) throw unavailable(LOOPBACK_UNATTENDED_WHY);
    // the ceilings previewCall gives an attended call, read before the grant's transaction
    // (`LoopbackGrants.refusalNow`: a ceiling switched off meanwhile is revoked by the refresh)
    const why = await this.loopback.refusalNow(d.orgId, d.deviceId);
    if (why !== null) throw unavailable(why);
    let row: LoopbackGrantRow;
    try {
      row = await this.grantInTx(key, scope.accountId);
    } catch (e) {
      // the conversation was deleted meanwhile
      if (e instanceof ApiError && e.code === "conversation.not_found")
        throw new DeviceAccessError("no_device", "The conversation does not exist.", { cause: e });
      throw e;
    }
    await this.refreshLoopback(d, key.serviceId);
    // the agent's pending ask for the same port is the owner's decision now: its call runs again
    try {
      const { failed } = await this.approvals.settleLoopbackAsks(d.orgId, scope.accountId, key);
      for (const f of failed)
        this.log.warn("a pending loopback ask not settled after a panel grant", {
          deviceId: d.deviceId,
          serviceId: key.serviceId,
          approvalId: f.approvalId,
          err: f.err,
        });
    } catch (err) {
      this.log.warn("pending loopback asks not settled after a panel grant", {
        deviceId: d.deviceId,
        serviceId: key.serviceId,
        err,
      });
    }
    return viewOf(row);
  }

  /**
   * Revokes the scope conversation root's grant of the port to the service (owner only); nothing
   * to revoke succeeds. The running service then gets the live set at once, best effort (the
   * owed refresh job is the backstop).
   */
  async revokeLoopbackPort(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { service: string; port: number },
  ): Promise<void> {
    const { d, key } = await this.loopbackKey(caller, scope, scope.port);
    if (await this.loopback.revoke(key, scope.accountId))
      await this.refreshLoopback(d, key.serviceId);
  }

  /** The live grants of the service held by the scope conversation's root (owner only), by port. */
  async loopbackPorts(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { service: string },
  ): Promise<LoopbackGrantView[]> {
    const { d, key } = await this.loopbackKey(caller, scope, null);
    const rows = await this.loopback.liveForRoot(
      d.orgId,
      d.deviceId,
      key.serviceId,
      d.rootConversationId,
    );
    return rows.map(viewOf);
  }

  /**
   * The checks every loopback call makes (the extension declares loopback ports and the service,
   * the port is one, the account owns the conversation and its personal device) and the grant key
   * under the conversation's root (`port` 0 for a listing).
   */
  private async loopbackKey(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { service: string },
    port: number | null,
  ): Promise<{ d: ScopedDevice; key: LoopbackGrantKey }> {
    if (!caller.loopbackPorts)
      throw new DeviceAccessError(
        "loopback_not_declared",
        "This extension does not declare permissions.deviceAccess.loopbackPorts.",
      );
    assertDeclared(caller, scope.service);
    if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65535))
      throw new DeviceAccessError(
        "invalid_request",
        `${String(port)} is not a port: a loopback port is an integer from 1 to 65535.`,
      );
    const d = await this.scopedDevice(caller, scope);
    return {
      d,
      key: {
        orgId: d.orgId,
        deviceId: d.deviceId,
        serviceId: deviceServiceId(caller.extension, scope.service),
        rootConversationId: d.rootConversationId,
        port: port ?? 0,
      },
    };
  }

  /**
   * Whether the scope's tree is unattended now, by the kernel's own records: its root is an
   * automation's conversation (`automation_id`), or a run of the scope conversation or its root
   * that has not ended serves an automation run with no person joined (`unattendedRunOf`; a trial
   * run is attended).
   */
  private async unattendedTree(d: ScopedDevice): Promise<boolean> {
    const root = await this.db
      .selectFrom("conversations")
      .select("automation_id")
      .where("id", "=", d.rootConversationId)
      .where("org_id", "=", d.orgId)
      .executeTakeFirst();
    if (root?.automation_id != null) return true;
    const runs = await this.db
      .selectFrom("runs as r")
      .innerJoin("conversations as c", "c.id", "r.conversation_id")
      .select("r.id")
      .where("c.org_id", "=", d.orgId)
      .where("r.conversation_id", "in", [d.conversationId, d.rootConversationId])
      .where("r.status", "in", ["queued", "running", "waiting"])
      .where("r.automation_run_id", "is not", null)
      .execute();
    for (const r of runs) {
      const run = await unattendedRunOf(this.db, this.config, d.orgId, r.id);
      if (run !== null && !run.trial) return true;
    }
    return false;
  }

  /**
   * The grant in a transaction of its own. `grantIn` locks the root conversation first, so nothing
   * here locks rows the conversation deletion path locks after the conversation.
   */
  @Transactional()
  private grantInTx(key: LoopbackGrantKey, accountId: string): Promise<LoopbackGrantRow> {
    return this.loopback.grantIn(key, { source: "owner-panel", actorAccountId: accountId });
  }

  /** Sends the service's live set now when it runs (best effort, logged on failure). */
  private async refreshLoopback(d: ScopedDevice, serviceId: string): Promise<void> {
    try {
      await this.services.refreshLoopback(
        d.orgId,
        d.deviceId,
        serviceId,
        AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      );
    } catch (err) {
      this.log.warn("device service not refreshed after a loopback grant change", {
        deviceId: d.deviceId,
        serviceId,
        err,
      });
    }
  }

  /** A single-use viewer ticket for the service (the person's panel opens `url`). */
  async streamTicket(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { service: string },
  ): Promise<{ url: string; expiresAt: string }> {
    const { url, expiresAt } = await this.mintTicket(scope, scope.service, caller);
    return { url, expiresAt };
  }

  /**
   * Mints a viewer ticket: `capk:device-stream-ticket:<id>` for
   * {@link DEVICE_STREAM_TICKET_TTL_SECONDS} seconds, taken once ({@link takeTicket}). Refused
   * unless the account owns the conversation and its personal device, and the device's provider
   * can open streams.
   */
  async mintTicket(
    scope: DeviceAccessScope,
    service: string,
    caller: DeviceAccessCaller,
  ): Promise<{ id: string; url: string; expiresAt: string }> {
    assertDeclared(caller, service);
    const d = await this.scopedDevice(caller, scope);
    if (!this.providers.forDevice(d.provider)?.impl.openStream)
      throw new DeviceAccessError(
        "capability_missing",
        "This device's provider cannot open streams to device services; choose a device on a provider that supports them.",
      );
    const id = randomBytes(24).toString("base64url");
    const record: DeviceStreamTicket = {
      orgId: d.orgId,
      accountId: scope.accountId,
      conversationId: d.conversationId,
      rootConversationId: d.rootConversationId,
      deviceId: d.deviceId,
      providerName: d.provider,
      service,
      extension: caller.extension,
    };
    await this.redis.set(
      `${DEVICE_STREAM_TICKET_PREFIX}${id}`,
      JSON.stringify(record),
      "EX",
      DEVICE_STREAM_TICKET_TTL_SECONDS,
    );
    const base = (this.config.get().http.publicUrl ?? "").replace(/\/+$/, "");
    return {
      id,
      url: `${base}/device/stream?ticket=${id}`,
      expiresAt: new Date(Date.now() + DEVICE_STREAM_TICKET_TTL_SECONDS * 1000).toISOString(),
    };
  }

  /** Takes a viewer ticket (GETDEL: a second take finds nothing); null when unknown or used. */
  async takeTicket(id: string): Promise<DeviceStreamTicket | null> {
    const raw = await this.redis.getdel(`${DEVICE_STREAM_TICKET_PREFIX}${id}`);
    return raw === null ? null : (JSON.parse(raw) as DeviceStreamTicket);
  }

  /**
   * Whether a taken viewer ticket's record still stands when its viewer opens (the checks of
   * {@link mintTicket} again, binding nothing): the conversation live and owned by the record's
   * account, its current tree root the record's root, its device still the record's device on the record's provider and the account's
   * own, the record's extension still enabled in the org and its approved manifest as loaded now
   * (not the record's copy) still declaring the service in `permissions.deviceAccess.services`.
   * False when any of that no longer holds; other failures (the database) are thrown.
   */
  async ticketStands(t: DeviceStreamTicket): Promise<boolean> {
    return (await this.ticketCheck(t)) === "stands";
  }

  /**
   * {@link ticketStands} with the reason when it does not: `provider_off` when the device's
   * provider is no longer usable in the org (switched off, or no provider), `revoked` for
   * everything else (the conversation, its owner or device, the extension or its declared
   * services). An open viewer re-checks with it while it lives. Other failures are thrown.
   */
  async ticketCheck(t: DeviceStreamTicket): Promise<"stands" | "revoked" | "provider_off"> {
    const declared =
      this.registry.current(t.extension)?.permissions.permissions.deviceAccess?.services ?? [];
    if (!declared.includes(t.service)) return "revoked";
    try {
      const d = await this.scopedDevice(
        { extension: t.extension, services: [t.service], loopbackPorts: false },
        { orgId: t.orgId, accountId: t.accountId, conversationId: t.conversationId },
      );
      return d.orgId === t.orgId &&
        d.rootConversationId === t.rootConversationId &&
        d.deviceId === t.deviceId &&
        d.provider === t.providerName
        ? "stands"
        : "revoked";
    } catch (e) {
      if (e instanceof DeviceAccessError)
        return e.code === "provider_unavailable" ? "provider_off" : "revoked";
      throw e;
    }
  }

  /**
   * Adds hosts to the conversation's device allowlist through the device page's own write
   * (ceilings, validation, the `device.network_changed` audit), owner only. Exact host names
   * only, as an approved network ask grants: a wildcard is refused before anything is read.
   */
  async addNetworkHosts(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { hosts: string[] },
  ): Promise<void> {
    const wildcard = scope.hosts.find((h) => typeof h !== "string" || h.includes("*"));
    if (wildcard !== undefined)
      throw new TypeError(
        `${String(wildcard)} is not an exact host name: ctx.deviceAccess.addNetworkHosts takes exact host names only (no "*." wildcard), as an approved network ask grants.`,
      );
    const d = await this.scopedDevice(caller, scope);
    await this.deviceWrites.addNetworkHostsIn(
      d.orgId,
      scope.accountId,
      d.deviceId,
      scope.hosts,
      "web",
    );
    // the extension's running services get the device's new limits (an ifRunning ensure: it
    // never starts or resumes anything); the allowlist is written either way
    const use: SandboxUseContext = {
      orgId: d.orgId,
      deviceId: d.deviceId,
      holderConversationId: d.conversationId,
      actor: { accountId: scope.accountId, conversationId: d.conversationId },
    };
    for (const name of caller.services) {
      try {
        await this.services.refresh(
          use,
          deviceServiceId(caller.extension, name),
          AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        );
      } catch (err) {
        this.log.warn("device service not refreshed after an allowlist change", {
          deviceId: d.deviceId,
          service: name,
          err,
        });
      }
    }
  }

  /**
   * Answers the pending question of tool call `callId` in conversation `handoffConversationId`
   * with `{ done }`, under the questions' own rules (only the run's starter answers, the form
   * validates the answer); only a question one of this extension's tools raised, and only in the
   * scope conversation or one of its sub-agent descendants (the root's panel answers a
   * sub-agent's handoff; a call id is unique only within a run). Anything else is
   * `question.not_found`, without telling whether such a question exists elsewhere.
   */
  async answerHandoff(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { callId: string; handoffConversationId: string; done: boolean },
  ): Promise<void> {
    const d = await this.scopedDevice(caller, scope);
    const notFound = () =>
      new ApiError(
        "question.not_found",
        `No pending question of tool call ${scope.callId} in this conversation`,
      );
    if (!(await this.isSelfOrDescendant(d.orgId, d.conversationId, scope.handoffConversationId)))
      throw notFound();
    const q = await this.db
      .selectFrom("questions")
      .select(["id", "spec"])
      .where("org_id", "=", d.orgId)
      .where("conversation_id", "=", scope.handoffConversationId)
      .where("call_id", "=", scope.callId)
      .where("status", "=", "pending")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (q === undefined) throw notFound();
    const key = (q.spec as { toolKey?: unknown } | null)?.toolKey;
    const parsed = typeof key === "string" ? parseToolKey(key) : null;
    if (parsed?.kind !== "extension" || parsed.plugin !== caller.extension)
      throw new ApiError(
        "question.not_found",
        `No pending question of tool call ${scope.callId} of ${caller.extension} in this conversation`,
      );
    await this.questions.answer(q.id, scope.accountId, { done: scope.done }, d.orgId);
  }

  /**
   * Whether `id` is `ancestorId` itself or a live conversation below it: walks `id`'s parent links
   * up, every row in org `orgId` and not deleted, at most 16 levels (far above
   * `subagents.maxDepth`'s bound of 5, so a corrupt parent chain cannot loop forever).
   */
  private async isSelfOrDescendant(
    orgId: string,
    ancestorId: string,
    id: string,
  ): Promise<boolean> {
    let current = id;
    for (let i = 0; i <= 16; i++) {
      if (current === ancestorId) return true;
      const row = await this.db
        .selectFrom("conversations")
        .select("parent_conversation_id")
        .where("id", "=", current)
        .where("org_id", "=", orgId)
        .where("deleted_at", "is", null)
        .executeTakeFirst();
      if (!row?.parent_conversation_id) return false;
      current = row.parent_conversation_id;
    }
    return false;
  }

  /** The use of the call's device (bound now when the conversation has none yet, as tools do). */
  private async callUse(
    call: ToolCallContext,
    rootConversationId: string,
    scope: CallScope,
  ): Promise<SandboxUseContext> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["account_id", "device_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", call.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (conv === undefined)
      throw new DeviceAccessError("no_device", "The conversation has no device to run in.");
    // the trigger account must own the conversation itself, not only by the call's word
    if (conv.account_id !== call.accountId)
      throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
    // a watcher binds nothing: an unbound conversation has nothing running (browser long waits
    // spec §5.3)
    if (scope.watch === true && conv.device_id === null)
      throw new DeviceAccessError(
        "not_running",
        "The conversation has no device; nothing was bound, resumed or started.",
      );
    let deviceId: string;
    try {
      deviceId = await this.devices.forTool(call.orgId, rootConversationId);
    } catch (e) {
      throw refusal(e, this.log);
    }
    scope.device = deviceId;
    return {
      orgId: call.orgId,
      deviceId,
      holderConversationId: call.conversationId,
      actor: { accountId: call.accountId, conversationId: call.conversationId },
    };
  }

  /**
   * The device of a scope-based call: the conversation live, the account its owner, the
   * extension enabled in its org, its (root) conversation bound to a personal device the account
   * may use now. Binds nothing.
   */
  private async scopedDevice(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope,
  ): Promise<ScopedDevice> {
    const conv = await this.db
      .selectFrom("conversations")
      .select(["org_id", "account_id"])
      .where("id", "=", scope.conversationId)
      .where("org_id", "=", scope.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    // another org's conversation reads as missing (no probing across orgs)
    if (conv === undefined)
      throw new DeviceAccessError("no_device", "The conversation does not exist.");
    if (conv.account_id !== scope.accountId)
      throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
    if (!(await isExtensionEnabled(this.db, conv.org_id, caller.extension)))
      throw new DeviceAccessError(
        "capability_missing",
        `The extension ${caller.extension} is not enabled in the conversation's organization.`,
      );
    const rootConversationId = await this.rootOf(scope.conversationId);
    const root = await this.db
      .selectFrom("conversations")
      .select(["account_id", "device_id"])
      .where("id", "=", rootConversationId)
      .where("org_id", "=", conv.org_id)
      .executeTakeFirst();
    if (root === undefined || root.account_id !== scope.accountId)
      throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
    if (root.device_id === null)
      throw new DeviceAccessError("no_device", "The conversation has no device yet.");
    let usable: { id: string; provider: string };
    try {
      usable = await this.access.usable(conv.org_id, scope.accountId, root.device_id);
    } catch (e) {
      // the device bound to the owner's conversation is not theirs to use: someone else's
      if (e instanceof ApiError && e.code === "device.not_found")
        throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT, { cause: e });
      throw refusal(e, this.log);
    }
    return {
      orgId: conv.org_id,
      conversationId: scope.conversationId,
      rootConversationId,
      deviceId: usable.id,
      provider: usable.provider,
    };
  }

  private rootOf(conversationId: string): Promise<string> {
    return rootConversationOf(this.db, conversationId);
  }
}

/** A grant record as the extension sees it. */
function viewOf(row: LoopbackGrantRow): LoopbackGrantView {
  return {
    port: row.port,
    source: row.source,
    expiresAt: row.expiresAt,
    database: isDatabasePort(row.port),
  };
}

/**
 * The declared service a report came from: `named` when the caller declares it, the caller's only
 * service when it names none, else null.
 */
function reportedService(caller: DeviceAccessCaller, named: string | undefined): string | null {
  if (named !== undefined) return caller.services.includes(named) ? named : null;
  return caller.services.length === 1 ? (caller.services[0] as string) : null;
}

/** A provider's status under the extension's own service name (the provider names the id). */
function asNamed(status: DeviceServiceStatus, name: string): DeviceServiceStatus {
  return { ...status, name };
}

function assertDeclared(caller: DeviceAccessCaller, service: string): void {
  if (!caller.services.includes(service))
    throw new DeviceAccessError(
      "service_not_declared",
      `The device service ${JSON.stringify(service)} is not declared in permissions.deviceAccess.services of ${caller.extension}.`,
    );
}

function assertCallOwner(call: ToolCallContext): void {
  if (call.ownerAccountId === undefined || call.accountId !== call.ownerAccountId)
    throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
}
