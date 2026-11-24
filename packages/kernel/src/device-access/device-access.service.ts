import { randomBytes } from "node:crypto";
import {
  DeviceAccessError,
  type DeviceAccessScope,
  type DeviceServiceSpec,
  type DeviceServiceStatus,
  type ToolCallContext,
  ToolError,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { DeviceAccess } from "../devices/access.js";
import { ConversationDevices } from "../devices/conversation-devices.js";
import { DevicesService } from "../devices/devices.service.js";
import { ApiError } from "../errors.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { REDIS } from "../infra/tokens.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { DeviceServices } from "../sandbox/device-services.js";
import { DeviceProviders } from "../sandbox/providers.js";
import { CommandReviewService } from "../sandbox/review/review.service.js";
import type { SandboxUseContext } from "../sandbox/use-context.js";
import { attachCallScope, type CallScope, callScopeOf } from "../tools/call-scope.js";
import { QuestionsService } from "../tools/questions.service.js";

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
function refusal(e: unknown): unknown {
  if (!(e instanceof ApiError)) return e;
  if (e.code === "device.not_found" || e.code === "sandbox.unavailable")
    return new DeviceAccessError("no_device", e.message, { cause: e });
  if (e.code === "device.unavailable")
    return new DeviceAccessError("provider_unavailable", e.message, { cause: e });
  return e;
}

/** A POSIX shell word for the review's command text (bare when it needs no quoting). */
const shellWord = (s: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * `ctx.deviceAccess` (browser use spec §7): an extension's device services in the conversation's
 * device, limited to the conversation's owner on their own personal device and to the service
 * names the extension's approved manifest declares. A service launch passes the command review
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
  ) {}

  private get db() {
    return this.kdb.db;
  }

  /**
   * Starts the service in the call's device, or finds it running. The command review sees the
   * launch (`node <entry> <args…>`) only when the service is not running (or the provider cannot
   * tell); anything but `allow` refuses it.
   */
  async ensureService(
    caller: DeviceAccessCaller,
    call: ToolCallContext,
    spec: DeviceServiceSpec,
  ): Promise<DeviceServiceStatus> {
    assertDeclared(caller, spec.name);
    assertCallOwner(call);
    const scope = callScopeOf(call);
    const facts = scope?.facts;
    if (facts === undefined)
      throw new Error(
        `plugin ${caller.extension}: ctx.deviceAccess.ensureService needs the tool call context the kernel passed to the handler`,
      );
    const use = await this.callUse(call, facts.rootConversationId, scope as CallScope);
    const status = await this.services.status(use, spec.name, call.signal);
    if (status === null || status.state === "stopped") {
      const reviewFacts = await this.devices.reviewFacts(
        call.orgId,
        facts.rootConversationId,
        call.conversationId,
      );
      if (reviewFacts === null || reviewFacts.deviceId !== use.deviceId)
        throw new DeviceAccessError("no_device", "The conversation has no device to run in.");
      const command = ["node", spec.entry, ...spec.args].map(shellWord).join(" ");
      const verdict = await this.review.review({
        orgId: call.orgId,
        conversationId: facts.rootConversationId,
        runId: facts.runId,
        accountId: call.accountId,
        toolKey: "Bash",
        input: { command },
        mode: reviewFacts.mode,
        workspace: reviewFacts.workingRoot,
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
      // fail closed: an ask has nobody to answer it here, and a deny is a deny
      if (verdict.decision !== "allow")
        throw new ToolError(
          `The device service ${spec.name} was not started: the command review did not allow its launch (${verdict.reason}). Ask the user to check the device's settings.`,
        );
    }
    try {
      return await this.services.ensure(use, spec, call.signal);
    } catch (e) {
      throw refusal(e);
    }
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
    try {
      return await this.services.request(use, req.service, req.body, req.timeoutMs, call.signal);
    } catch (e) {
      throw refusal(e);
    }
  }

  /**
   * Records refused hosts in the call scope (synchronous: the pipeline reads it once the handler
   * returns) on the device this call's own `ctx.deviceAccess` calls resolved, if any.
   */
  reportBlockedHosts(call: ToolCallContext, hosts: string[], opts?: { url?: string }): void {
    assertCallOwner(call);
    const scope = callScopeOf(call) ?? attachCallScope(call);
    const valid = hosts.filter((h): h is string => typeof h === "string" && h.length > 0);
    if (valid.length === 0) return;
    const url = typeof opts?.url === "string" && opts.url.length > 0 ? opts.url : null;
    if (scope.blocked === null) {
      scope.blocked = { deviceId: scope.device, hosts: new Set(valid), url };
      return;
    }
    for (const h of valid) scope.blocked.hosts.add(h);
    if (url !== null) scope.blocked.url = url;
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
   * Adds hosts to the conversation's device allowlist through the device page's own write
   * (ceilings, validation, the `device.network_changed` audit), owner only.
   */
  async addNetworkHosts(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { hosts: string[] },
  ): Promise<void> {
    const d = await this.scopedDevice(caller, scope);
    await this.deviceWrites.addNetworkHostsIn(
      d.orgId,
      scope.accountId,
      d.deviceId,
      scope.hosts,
      "web",
    );
  }

  /**
   * Answers the pending question of tool call `callId` in the conversation with `{ done }`, under
   * the questions' own rules (only the run's starter answers, the form validates the answer).
   */
  async answerHandoff(
    caller: DeviceAccessCaller,
    scope: DeviceAccessScope & { callId: string; done: boolean },
  ): Promise<void> {
    const d = await this.scopedDevice(caller, scope);
    const q = await this.db
      .selectFrom("questions")
      .select("id")
      .where("org_id", "=", d.orgId)
      .where("conversation_id", "=", d.conversationId)
      .where("call_id", "=", scope.callId)
      .where("status", "=", "pending")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
    if (q === undefined)
      throw new ApiError(
        "question.not_found",
        `No pending question of tool call ${scope.callId} in this conversation`,
      );
    await this.questions.answer(q.id, scope.accountId, { done: scope.done }, d.orgId);
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
      throw refusal(e);
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
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (conv === undefined)
      throw new DeviceAccessError("no_device", "The conversation does not exist.");
    if (conv.account_id !== scope.accountId)
      throw new DeviceAccessError("not_owner", DEVICE_ACCESS_NOT_OWNER_TEXT);
    const enabled = await enabledExtensionsQuery(this.db, conv.org_id)
      .execute()
      .then((rows) => rows.some((r) => r.plugin === caller.extension));
    if (!enabled)
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
      throw refusal(e);
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
