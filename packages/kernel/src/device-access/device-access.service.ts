import { randomBytes } from "node:crypto";
import {
  DeviceAccessError,
  type DeviceAccessScope,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
  deviceServiceFilesDigest,
  deviceServiceId,
  type Logger,
  type NetworkBlockLayer,
  parseToolKey,
  type ServiceBlockedHost,
  type ToolCallContext,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
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
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { assertServiceSpec, DeviceServices } from "../sandbox/device-services.js";
import { DeviceProviders } from "../sandbox/providers.js";
import { CommandReviewService } from "../sandbox/review/review.service.js";
import type { SandboxUseContext } from "../sandbox/use-context.js";
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
}

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
    // like a stopped one, reviewed below; the provider then restarts it on the spec's files
    const digest = deviceServiceFilesDigest(providerSpec.files);
    const current = (st: DeviceServiceStatus) =>
      st.state === "running" && (st.filesDigest === undefined || st.filesDigest === digest);
    const found = await ensure(true);
    if (current(found)) return found;
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
    if (current(raced)) return raced;
    const started = await ensure(false);
    // audited only when this ensure started it: the service was stopped (no startedAt) or ran
    // other files just before, and runs with a new startedAt now
    if (started.state !== "running" || started.startedAt === raced.startedAt) return started;
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
      },
    });
    return started;
  }

  /** One request to the service's socket in the call's device. */
  async request(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    req: { service: string; body: Uint8Array; timeoutMs: number },
  ): Promise<Uint8Array> {
    assertDeclared(caller, req.service);
    assertCallOwner(call);
    const scope = callScopeOf(call) ?? attachCallScope(call);
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
   */
  reportBlockedHosts(
    call: ToolCallContext,
    hosts: ServiceBlockedHost[],
    opts?: { url?: string },
  ): void {
    assertCallOwner(call);
    const scope = callScopeOf(call) ?? attachCallScope(call);
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
    if (scope.blocked === null) scope.blocked = { deviceId: scope.device, hosts: new Map(), url };
    else if (url !== null) scope.blocked.url = url;
    const seen = scope.blocked.hosts;
    for (const h of valid) {
      const key = serviceHostKey(h.host);
      const had = seen.get(key);
      seen.set(key, had === undefined ? h.layer : strongerLayer(had, h.layer));
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
        { extension: t.extension, services: [t.service] },
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
      .select("account_id")
      .where("id", "=", rootConversationId)
      .where("org_id", "=", call.orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (conv === undefined)
      throw new DeviceAccessError("no_device", "The conversation has no device to run in.");
    // the trigger account must own the conversation itself, not only by the call's word
    if (conv.account_id !== call.accountId)
      throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
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
