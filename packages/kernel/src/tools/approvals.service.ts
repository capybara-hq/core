import { randomUUID } from "node:crypto";
import {
  connectorToolKey,
  type LocalizedName,
  parseToolKey,
  type ToolDisplay,
  validateAllowHost,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type Selectable, sql } from "kysely";
import { EventLog } from "../conversations/event-log.js";
import {
  NETWORK_ASK_MAX_HOSTS,
  NETWORK_HOST_MAX_CHARS,
  type ToolView,
} from "../conversations/events.js";
import type { ApprovalsTable } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KernelEvents } from "../infra/events/kernel-events.js";
import { LockService } from "../infra/lock/lock.service.js";
import { WithLock } from "../infra/lock/with-lock.decorator.js";
import { DevicePolicyService } from "../local-devices/device-policy.service.js";
import { ORG_ROLES, type OrgRole, roleAtLeast } from "../orgs/roles.js";
import { rootConversationOf } from "../runtime/subagents/child.js";
import { readScheduleSettings } from "../schedules/effective-settings.js";
import { grantRefusalOf } from "../schedules/grant-rules.js";
import { ScheduledTaskStore } from "../schedules/store.js";
import { unattendedTaskRunOf } from "../schedules/unattended.js";
import { pluginDisplayNames } from "./display-names.js";
import { normalizeStoredDefinitionIn } from "./legacy-data.js";
import type { ApprovalPolicySource } from "./pipeline.js";
import { ToolRegistry } from "./registry.js";

export { APPROVAL_DENY_REASON_MAX_CHARS } from "../conversations/events.js";

/** `list` 一次最多返回的审批数（收件箱据此判断这个来源是否取满）。 */
export const APPROVALS_LIST_MAX = 100;

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "cancelled"
  | "skipped";
export type ApprovalScope = "once" | "session" | "always";
/** What an approval asks: a tool call, or the device owner about refused network hosts. */
export type ApprovalKind = "tool" | "network";

/**
 * A network ask's `detail` (network ask-to-allow spec §6.1, P-D2): the device, the refused hosts,
 * the command and its kept `tool_result` (written with a note when the ask settles; the command is
 * never run again), and once approved what took effect.
 */
export interface NetworkAskDetail {
  deviceId: string;
  hosts: { host: string; port: number }[];
  command: string;
  description: string | null;
  /**
   * The formatted `tool_result` of the command (≤ 16 KB; larger output already archived), and the
   * display-only fields the pipeline writes with it when the ask settles.
   */
  result: {
    content: string;
    isError: boolean;
    outputId?: string;
    contentTypes?: string[];
    display?: ToolDisplay;
    view?: ToolView;
  };
  /** The hosts the decision allowed (every approved decision writes them; none: nothing). */
  grantedHosts?: string[];
  /** What took effect: a run grant, the device's policy, or a run grant because the device did not apply it. */
  outcome?: "once" | "always" | "once_fallback";
  /** Why 「一直允许」 fell back to a run grant. */
  fallback?: "offline" | "refused" | "unsupported";
}

/** A network ask's detail as the API shows it: without the kept command result. */
export type NetworkAskView = Omit<NetworkAskDetail, "result">;

/**
 * The model-visible note written after a network ask's kept result when its run is stopped before
 * the device owner answered (spec §6.7).
 */
export const NETWORK_ASK_CANCELLED_NOTE =
  "[network] The run was stopped before the user answered; access stays blocked.";

/** 一条审批记录。 */
export interface ApprovalRecord {
  id: string;
  orgId: string;
  conversationId: string;
  runId: string;
  callId: string;
  /** 同一调用的第几次审批（从 1 起；工具定义变化后重新审批时递增）。 */
  attempt: number;
  /** `network`: a network ask (its tool key is `Bash`, its facts in {@link detail}). */
  kind: ApprovalKind;
  /** A network ask's hosts, command, kept result and outcome; null for a tool approval. */
  detail: NetworkAskDetail | null;
  toolKey: string;
  specHash: string;
  connectorId: string | null;
  input: unknown;
  requestedFor: string | null;
  approverRole: OrgRole | null;
  status: ApprovalStatus;
  scope: ApprovalScope | null;
  decidedBy: string | null;
  decidedAt: string | null;
  /** The reason given with a denial (null otherwise). */
  denyReason: string | null;
  /** The kernel-rendered summary of the call (a per-call policy's; null otherwise). */
  summary: { zh: string; en: string } | null;
  /**
   * The scopes the decider may choose: stored with the approval (a per-call policy that may not
   * be remembered stores `["once"]`), else derived: only "once" for a role escalation.
   */
  scopes: ApprovalScope[];
  expiresAt: string;
  createdAt: string;
}

/** An approval as a route answers it: a network ask's detail without the kept command result. */
export interface ApprovalPublicRecord extends Omit<ApprovalRecord, "detail"> {
  detail: NetworkAskView | null;
}

/** The record without a network ask's kept command result (what routes and cards may show). */
export function publicRecord(r: ApprovalRecord): ApprovalPublicRecord {
  if (r.detail === null) return { ...r, detail: null };
  const { result: _result, ...detail } = r.detail;
  return { ...r, detail };
}

/** 审批详情（列表与详情接口返回）。 */
export interface ApprovalView extends ApprovalPublicRecord {
  /** 来源内的工具原名（连接器工具为连接器里的名字；否则同 `toolKey`）。 */
  toolName: string;
  connector: { id: string; name: string; slug: string } | null;
  /** An extension tool's plugin (`plugin__<plugin>__<tool>`) and its display name (display only). */
  extension: { name: string; displayName: LocalizedName } | null;
  agent: { id: string; name: string };
  /**
   * 网页中该会话的路径（不含语言前缀）。A sub-agent's approval, at any depth, links to the root
   * conversation of its tree with the sub-agent open: `/chat/<root>?subagent=<child>` (agent map
   * spec §7).
   */
  conversationPath: string;
  /** Set when the approval belongs to a sub-agent: the conversation it was dispatched from. */
  parentConversationId?: string;
  /** 发起本次运行的人。 */
  initiatorAccountId: string;
}

/** 新建审批（Task 9 的 loop 在策略为 `ask` 时调用）。 */
export interface ApprovalRequestInput {
  orgId: string;
  conversationId: string;
  runId: string;
  /** 工具调用所在的步（写进 `approval_requested`）。 */
  step: number;
  callId: string;
  toolKey: string;
  specHash: string;
  connectorId: string | null;
  input: unknown;
  /** 指定处理人；与 `approverRole` 至少一个非空。 */
  requestedFor: string | null;
  approverRole: OrgRole | null;
  /** 同一调用的第几次审批，缺省 1（等待期间工具定义变化、原批准不再适用时递增）。 */
  attempt?: number;
  /** Which rule asked (written to `approval_requested.policy`; display only). */
  policy?: ApprovalPolicySource;
  /** The kernel-rendered summary of the call (per-call policies). */
  summary?: { zh: string; en: string };
  /** The scopes the decider may choose; unset: derived (see {@link ApprovalRecord.scopes}). */
  scopes?: ApprovalScope[];
}

export interface DecisionInput {
  decision: "approve" | "deny";
  /** 只对批准有意义，缺省 `once`。按角色升级的审批只能 `once`。 */
  scope?: ApprovalScope | undefined;
  note?: string | undefined;
  /** Only with `deny` (trimmed, 1–500 characters; checked by the route). */
  reason?: string | undefined;
  /**
   * A network ask's approval only: the hosts allowed, a subset of those asked (absent: all); the
   * unchecked ones count as denied (P-D5).
   */
  hosts?: string[] | undefined;
}

/** Where a decision was made (the device's local audit line and `device.network_*`). */
export type DecisionVia = "web" | "im";

/** A new network ask (network ask-to-allow spec §6.2), made by the tool pipeline. */
export interface NetworkAskInput {
  orgId: string;
  conversationId: string;
  runId: string;
  /** The call's step (written to `approval_requested`). */
  step: number;
  callId: string;
  /** The device owner: the only person who may decide. */
  requestedFor: string;
  detail: Omit<NetworkAskDetail, "grantedHosts" | "outcome" | "fallback">;
  /** `["once", "always"]`, or `["once"]` when the device takes no remote grants. */
  scopes: ("once" | "always")[];
}

/** What a network ask's decision took effect as, passed to the decision's transaction. */
interface NetworkDecision {
  /** The hosts allowed (empty when denied). */
  granted: string[];
  /** Null when denied. */
  outcome: "once" | "always" | "once_fallback" | null;
  fallback?: "offline" | "refused" | "unsupported";
  via: DecisionVia;
}

/** The tool key a network ask is recorded under (the command ran in `Bash`). */
export const NETWORK_ASK_TOOL_KEY = "Bash";
/** The spec hash of a network ask (no tool definition is approved). */
const NETWORK_ASK_SPEC_HASH = "network";

/** 「以后都允许」授权（本人可撤销）。 */
export interface ToolGrantView {
  agentId: string;
  agentName: string;
  toolKey: string;
  specHash: string;
  createdAt: string;
}

const notFound = () => new ApiError("approval.not_found", "Approval not found");
const iso = (v: Date | string): string => new Date(v).toISOString();
const isRole = (v: string | null): v is OrgRole =>
  v !== null && (ORG_ROLES as readonly string[]).includes(v);

/** The scopes of an approval without stored ones: a role escalation is approved only once. */
const derivedScopes = (requestedFor: string | null): ApprovalScope[] =>
  requestedFor === null ? ["once"] : ["once", "session", "always"];

function toRecord(r: Selectable<ApprovalsTable>): ApprovalRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    conversationId: r.conversation_id,
    runId: r.run_id,
    callId: r.call_id,
    attempt: r.attempt,
    kind: r.kind,
    detail: r.kind === "network" ? ((r.detail as NetworkAskDetail | null) ?? null) : null,
    toolKey: r.tool_key,
    specHash: r.spec_hash,
    connectorId: r.connector_id,
    input: r.input,
    requestedFor: r.requested_for,
    approverRole: isRole(r.approver_role) ? r.approver_role : null,
    status: r.status,
    scope: r.scope,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at === null ? null : iso(r.decided_at),
    denyReason: r.deny_reason,
    summary: r.summary ?? null,
    scopes: r.scopes ?? derivedScopes(r.requested_for),
    expiresAt: iso(r.expires_at),
    createdAt: iso(r.created_at),
  };
}

/**
 * 能处理该审批的人（spec 3.6 R2）：
 * - 指定了 `requested_for` → 只有那个人；
 * - 按角色升级（`approver_role`）→ 当前角色不低于它、且不是该运行发起人的成员（发起人不能批准按角色升级到别人的请求）。
 * agent / 服务令牌不能处理任何审批（路由动作 `approvals.decide` 仅限用户主体）。
 */
function canHandle(
  a: { requestedFor: string | null; approverRole: OrgRole | null },
  initiator: string,
  accountId: string,
  role: OrgRole | null,
): boolean {
  if (a.requestedFor !== null) return a.requestedFor === accountId;
  return (
    a.approverRole !== null &&
    role !== null &&
    roleAtLeast(role, a.approverRole) &&
    initiator !== accountId
  );
}

/**
 * 工具调用审批：新建（loop 调用）、列出 / 查看 / 处理（HTTP），以及「以后都允许」授权的查看与撤销。
 * 状态全部在 PG：处理决定在事务里 `SELECT … FOR UPDATE` 审批行，多副本并发处理同一审批时恰好一个生效。
 *
 * A decision is announced after the commit as the domain event `approval.decided` (exactly once:
 * only the decision that changed the row from pending), which the run's waits follow to resume it
 * (spec §3b; the wait sweep resumes a run whose resume was lost). Events are appended in the
 * context's transaction (`EventLog.appendIn`) and published after the commit.
 */
@Injectable()
export class ApprovalsService {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(KernelConfigService) private readonly config: Pick<KernelConfigService, "get">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "appendIn" | "notify">,
    @Inject(KernelEvents) private readonly events: Pick<KernelEvents, "emit">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(ScheduledTaskStore)
    private readonly schedules: Pick<ScheduledTaskStore, "addGrant">,
    /** A trial approval is kept only for a tool the task may hold as a grant (its agent's tools). */
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, "forAgent">,
    /** 「这台设备一直允许」 sends the `policy` op to the device before the decision is recorded. */
    @Inject(DevicePolicyService) private readonly policies: Pick<DevicePolicyService, "apply">,
    /** One decision of a network ask at a time, across replicas (the op is sent before the transaction). */
    @Inject(LockService) readonly lockService: LockService,
  ) {}

  /**
   * 新建 pending 审批（`expires_at` = 现在 + `tools.approvalTimeoutHours`）并写 `approval_requested`，同一事务。
   * 按 (run_id, call_id, attempt) 幂等：已存在则返回已有记录（不覆盖），事件按 `approval_requested:<approvalId>` 幂等。
   */
  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    if (input.requestedFor === null && input.approverRole === null) {
      throw new Error("approval requires requestedFor or approverRole");
    }
    const { record, toSeq } = await this.requestIn(input);
    await this.eventLog.notify(record.conversationId, toSeq);
    return record;
  }

  @Transactional()
  private async requestIn(
    input: ApprovalRequestInput,
  ): Promise<{ record: ApprovalRecord; toSeq: number }> {
    const hours = this.config.get().tools.approvalTimeoutHours;
    const t = this.db.db;
    // Lock the conversation row (the append's lock) before inserting the approval: the insert's
    // foreign key check takes FOR KEY SHARE on that row, and two requests that each held it and
    // then asked for the append's FOR UPDATE waited for each other (40P01)
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", input.conversationId)
      .forUpdate()
      .execute();
    await t
      .insertInto("approvals")
      .values({
        id: randomUUID(),
        org_id: input.orgId,
        conversation_id: input.conversationId,
        run_id: input.runId,
        call_id: input.callId,
        attempt: input.attempt ?? 1,
        tool_key: input.toolKey,
        spec_hash: input.specHash,
        connector_id: input.connectorId,
        input: JSON.stringify(input.input ?? {}),
        requested_for: input.requestedFor,
        approver_role: input.approverRole,
        summary: input.summary === undefined ? null : JSON.stringify(input.summary),
        scopes: input.scopes ?? null,
        scope: null,
        decided_by: null,
        expires_at: sql<Date>`now() + ${hours}::integer * interval '1 hour'`,
      })
      .onConflict((oc) => oc.columns(["run_id", "call_id", "attempt"]).doNothing())
      .execute();
    const row = await t
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", input.runId)
      .where("call_id", "=", input.callId)
      .where("attempt", "=", input.attempt ?? 1)
      .executeTakeFirstOrThrow();
    const rec = toRecord(row);
    const written = await this.eventLog.appendIn(rec.conversationId, [
      {
        type: "approval_requested",
        runId: rec.runId,
        idemKey: `approval_requested:${rec.id}`,
        payload: {
          step: input.step,
          callId: rec.callId,
          approvalId: rec.id,
          toolKey: rec.toolKey,
          expiresAt: rec.expiresAt,
          ...(input.policy !== undefined && { policy: input.policy }),
          requestedFor: rec.requestedFor,
          approverRole: rec.approverRole,
        },
      },
    ]);
    return { record: rec, toSeq: Math.max(...written.map((e) => e.seq)) };
  }

  /**
   * A network ask (network ask-to-allow spec §6.2): a pending approval of kind `network` for the
   * device owner, expiring like a tool approval (`tools.approvalTimeoutHours`), and its
   * `approval_requested` (tool key `Bash`, the display-only `network.hosts`), in one transaction.
   * It takes the attempt after the call's other approvals (P-D4: the command ran, so no tool
   * approval of the call follows it). One per call: a second request returns the first.
   */
  async requestNetwork(input: NetworkAskInput): Promise<ApprovalRecord> {
    const hosts = input.detail.hosts;
    if (hosts.length === 0 || hosts.length > NETWORK_ASK_MAX_HOSTS) {
      throw new Error(`a network ask lists 1 to ${NETWORK_ASK_MAX_HOSTS} hosts`);
    }
    if (hosts.some((h) => h.host.length === 0 || h.host.length > NETWORK_HOST_MAX_CHARS)) {
      throw new Error("a network ask's host is 1 to 255 characters");
    }
    if (input.scopes.length === 0 || !input.scopes.includes("once")) {
      throw new Error('a network ask offers at least "once"');
    }
    const { record, toSeq } = await this.requestNetworkIn(input);
    if (toSeq !== null) await this.eventLog.notify(record.conversationId, toSeq);
    return record;
  }

  @Transactional()
  private async requestNetworkIn(
    input: NetworkAskInput,
  ): Promise<{ record: ApprovalRecord; toSeq: number | null }> {
    const hours = this.config.get().tools.approvalTimeoutHours;
    const t = this.db.db;
    // the conversation row first (as `requestIn`): it also serializes two asks of one call
    await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", input.conversationId)
      .forUpdate()
      .execute();
    const existing = await this.networkForCall(input.runId, input.callId);
    if (existing !== null) return { record: existing, toSeq: null };
    const last = await t
      .selectFrom("approvals")
      .select(sql<number | null>`max(attempt)`.as("attempt"))
      .where("run_id", "=", input.runId)
      .where("call_id", "=", input.callId)
      .executeTakeFirst();
    const row = await t
      .insertInto("approvals")
      .values({
        id: randomUUID(),
        org_id: input.orgId,
        conversation_id: input.conversationId,
        run_id: input.runId,
        call_id: input.callId,
        attempt: Number(last?.attempt ?? 0) + 1,
        kind: "network",
        detail: JSON.stringify(input.detail),
        tool_key: NETWORK_ASK_TOOL_KEY,
        spec_hash: NETWORK_ASK_SPEC_HASH,
        connector_id: null,
        input: JSON.stringify({}),
        requested_for: input.requestedFor,
        approver_role: null,
        scopes: [...new Set(input.scopes)],
        scope: null,
        decided_by: null,
        expires_at: sql<Date>`now() + ${hours}::integer * interval '1 hour'`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    const rec = toRecord(row);
    const written = await this.eventLog.appendIn(rec.conversationId, [
      {
        type: "approval_requested",
        runId: rec.runId,
        idemKey: `approval_requested:${rec.id}`,
        payload: {
          step: input.step,
          callId: rec.callId,
          approvalId: rec.id,
          toolKey: rec.toolKey,
          expiresAt: rec.expiresAt,
          network: { hosts: input.detail.hosts.map((h) => h.host) },
          requestedFor: rec.requestedFor,
          approverRole: null,
        },
      },
    ]);
    return { record: rec, toSeq: Math.max(...written.map((e) => e.seq)) };
  }

  /** 当前用户能处理的审批（新的在前，最多 {@link APPROVALS_LIST_MAX} 条）；`status` 缺省为全部。 */
  async list(orgId: string, accountId: string, status?: ApprovalStatus): Promise<ApprovalView[]> {
    const role = await this.roleOf(orgId, accountId);
    const roles = role === null ? [] : ORG_ROLES.filter((r) => roleAtLeast(role, r));
    let q = this.db
      .selectFrom("approvals")
      .innerJoin("runs", "runs.id", "approvals.run_id")
      .selectAll("approvals")
      .where("approvals.org_id", "=", orgId)
      .where((eb) =>
        eb.or([
          eb("approvals.requested_for", "=", accountId),
          eb.and([
            eb("approvals.requested_for", "is", null),
            roles.length === 0 ? eb.lit(false) : eb("approvals.approver_role", "in", [...roles]),
            eb("runs.trigger_account_id", "!=", accountId),
          ]),
        ]),
      );
    if (status !== undefined) q = q.where("approvals.status", "=", status);
    // 已到期、超时任务尚未处理的审批不再列为待处理（处理它会得到 approval.already_decided）
    if (status === "pending") q = q.where("approvals.expires_at", ">", sql<Date>`now()`);
    const rows = await q
      .orderBy("approvals.created_at", "desc")
      .limit(APPROVALS_LIST_MAX)
      .execute();
    return this.views(rows.map(toRecord));
  }

  /** 详情；当前用户不能处理的一律 `approval.not_found`（不泄露存在）。 */
  async get(orgId: string, id: string, accountId: string): Promise<ApprovalView> {
    const row = await this.db
      .selectFrom("approvals")
      .innerJoin("runs", "runs.id", "approvals.run_id")
      .selectAll("approvals")
      .select("runs.trigger_account_id")
      .where("approvals.id", "=", id)
      .where("approvals.org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const role = await this.roleOf(orgId, accountId);
    const rec = toRecord(row);
    if (!canHandle(rec, row.trigger_account_id, accountId, role)) throw notFound();
    const [view] = await this.views([rec]);
    if (!view) throw notFound();
    return view;
  }

  /**
   * 处理审批：事务内 `SELECT … FOR UPDATE` 审批行并实时重读处理人角色（R5）；不能处理 → `approval.not_found`，
   * 非 pending 或已过期 → `approval.already_decided`。同一事务写状态、授权（`session` → 会话授权，
   * `always` → 发起人 × agent × 工具）、`approval_decided` 事件（幂等键 `approval_decided:<id>`）与审计；
   * 提交后发布事件并调用 `onDecided`。
   */
  async decide(
    orgId: string,
    id: string,
    accountId: string,
    body: DecisionInput,
    actorTokenId?: string,
    via: DecisionVia = "web",
  ): Promise<ApprovalRecord> {
    const kind = await this.db
      .selectFrom("approvals")
      .select("kind")
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!kind) throw notFound();
    if (kind.kind === "network") {
      return this.decideNetwork(orgId, id, accountId, body, actorTokenId, via);
    }
    if (body.hosts !== undefined) {
      throw new ApiError("validation_failed", "hosts are only for network asks", [
        { path: "hosts", message: "Only a network ask takes hosts" },
      ]);
    }
    const { record, toSeq } = await this.decideIn(orgId, id, accountId, body, actorTokenId);
    await this.announceDecided(record, toSeq);
    return record;
  }

  /**
   * A network ask's decision (network ask-to-allow spec §5.2), one at a time per ask across
   * replicas: only the device owner (`requested_for`) decides, in a signed-in session (a personal
   * access token is refused; the route already refuses service and embed tokens); the allowed
   * hosts are a subset of those asked. 「这台设备一直允许」 sends the `policy` op first, outside any
   * transaction; when the device does not apply it (offline, refused, a program without the
   * feature) the decision is recorded as a run grant with the reason. Then {@link decideIn}
   * records what took effect and the run resumes after the commit.
   */
  @WithLock({ key: "network-ask-#{1}", ttl: 60_000, waitTimeout: 45_000 })
  private async decideNetwork(
    orgId: string,
    id: string,
    accountId: string,
    body: DecisionInput,
    actorTokenId: string | undefined,
    via: DecisionVia,
  ): Promise<ApprovalRecord> {
    const row = await this.db
      .selectFrom("approvals")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const ask = toRecord(row);
    if (ask.requestedFor !== accountId) {
      const owner = ask.requestedFor === null ? null : await this.displayNameOf(ask.requestedFor);
      throw new ApiError(
        "approval.not_yours",
        `Only ${owner ?? "the device's owner"} can allow network access on this device.`,
      );
    }
    if (actorTokenId !== undefined) {
      throw new ApiError(
        "auth.session_required",
        "Network access is decided in a signed-in session, not with a personal access token.",
      );
    }
    if (ask.status !== "pending") {
      throw new ApiError("approval.already_decided", "Approval has already been decided");
    }
    if (row.expired) throw new ApiError("approval.already_decided", "Approval has expired");
    const detail = ask.detail;
    if (detail === null) throw new Error(`network ask ${id} has no detail`);
    const asked = [...new Set(detail.hosts.map((h) => h.host))];
    let network: NetworkDecision;
    if (body.decision === "approve") {
      const scope = body.scope ?? "once";
      if (scope === "session" || !ask.scopes.includes(scope)) {
        throw new ApiError(
          "approval.scope_not_allowed",
          `Scope "${scope}" is not allowed for this approval; allowed: ${ask.scopes.join(", ")}`,
        );
      }
      const unknown = (body.hosts ?? []).filter((h) => !asked.includes(h));
      if (unknown.length > 0) {
        throw new ApiError("validation_failed", "hosts must be among the hosts asked about", [
          { path: "hosts", message: `Not asked about: ${unknown.join(", ")}` },
        ]);
      }
      // exact hosts only: the device and the run grants never take anything else
      const granted = [...new Set(body.hosts ?? asked)].filter(
        (h) => !h.startsWith("*.") && validateAllowHost(h).length === 0,
      );
      if (granted.length === 0) {
        throw new ApiError("validation_failed", "No host to allow", [
          { path: "hosts", message: "Choose at least one host" },
        ]);
      }
      network = { granted, outcome: "once", via };
      if (scope === "always") {
        const applied = await this.applyAlways(orgId, detail.deviceId, granted, {
          approvalId: id,
          accountId,
          via,
        });
        network =
          applied === null
            ? { granted, outcome: "always", via }
            : { granted, outcome: "once_fallback", fallback: applied, via };
      }
    } else {
      if (body.hosts !== undefined) {
        throw new ApiError("validation_failed", "hosts are only given when allowing", [
          { path: "hosts", message: "Only an approval takes hosts" },
        ]);
      }
      network = { granted: [], outcome: null, via };
    }
    const { record, toSeq } = await this.decideIn(
      orgId,
      id,
      accountId,
      body,
      actorTokenId,
      network,
    );
    await this.announceDecided(record, toSeq);
    return record;
  }

  /**
   * Adds the hosts to the device's local policy (the `policy` op; never inside a transaction).
   * Null when it was applied, else why not: the decision falls back to a run grant.
   */
  private async applyAlways(
    orgId: string,
    deviceId: string,
    hosts: string[],
    source: { approvalId: string; accountId: string; via: DecisionVia },
  ): Promise<"offline" | "refused" | "unsupported" | null> {
    const accountName = (await this.displayNameOf(source.accountId)) ?? source.accountId;
    try {
      const out = await this.policies.apply({
        orgId,
        deviceId,
        change: { add: hosts },
        source: { ...source, accountName },
      });
      return out.applied ? null : out.reason;
    } catch (e) {
      // the device was deleted meanwhile: nothing to write to, the run cannot go on there either
      if (e instanceof ApiError && e.code === "device.not_found") return "offline";
      throw e;
    }
  }

  /** After the commit: the decision's events reach the page, the run's waits and IM delivery. */
  private async announceDecided(record: ApprovalRecord, toSeq: number): Promise<void> {
    await this.eventLog.notify(record.conversationId, toSeq);
    // waits resume the run and its IM delivery is enqueued (handler failures are logged)
    await this.events.emit("approval.decided", {
      id: record.id,
      orgId: record.orgId,
      conversationId: record.conversationId,
      runId: record.runId,
      status: record.status === "approved" ? "approved" : "denied",
    });
  }

  /** An account's display name (null when unknown). */
  private async displayNameOf(accountId: string): Promise<string | null> {
    const a = await this.db
      .selectFrom("accounts")
      .select("display_name")
      .where("id", "=", accountId)
      .executeTakeFirst();
    return a?.display_name ?? null;
  }

  // its own transaction (as the legacy one was): `approval.decided` is emitted only after the
  // decision committed, even when a caller has a transaction open
  @Transactional({ propagation: "requires_new" })
  private async decideIn(
    orgId: string,
    id: string,
    accountId: string,
    body: DecisionInput,
    actorTokenId: string | undefined,
    network?: NetworkDecision,
  ): Promise<{ record: ApprovalRecord; toSeq: number }> {
    const t = this.db.db;
    const locked = await t
      .selectFrom("approvals")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("id", "=", id)
      .where("org_id", "=", orgId)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) throw notFound();
    const ctx = await t
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select([
        "runs.trigger_account_id",
        "conversations.agent_id",
        "conversations.parent_conversation_id",
      ])
      .where("runs.id", "=", locked.run_id)
      .executeTakeFirstOrThrow();
    const before = toRecord(locked);
    const role = await this.roleOf(orgId, accountId);
    if (!canHandle(before, ctx.trigger_account_id, accountId, role)) throw notFound();
    if (before.status !== "pending") {
      throw new ApiError("approval.already_decided", "Approval has already been decided");
    }
    if (locked.expired) {
      throw new ApiError("approval.already_decided", "Approval has expired");
    }
    // a network ask is decided only through decideNetwork (its policy op went first)
    if ((before.kind === "network") !== (network !== undefined)) {
      throw new Error(`approval ${id} is of kind ${before.kind}`);
    }
    const approved = body.decision === "approve";
    const reason = approved ? undefined : body.reason?.trim() || undefined;
    const scope: ApprovalScope | null = !approved
      ? null
      : network === undefined
        ? (body.scope ?? "once")
        : network.outcome === "always"
          ? "always"
          : "once";
    // 按角色升级的批准只对这一次有效：授权记在发起人名下会让其以后绕过角色要求
    if (scope !== null && scope !== "once" && before.requestedFor === null) {
      throw new ApiError(
        "validation_failed",
        'Only scope "once" is allowed for role-escalated approvals',
        [{ path: "scope", message: 'Only "once" is allowed for role-escalated approvals' }],
      );
    }
    // the scopes stored with the approval (an org / platform operation: "once" only), whatever
    // the client offered
    if (scope !== null && !before.scopes.includes(scope)) {
      throw new ApiError(
        "approval.scope_not_allowed",
        `Scope "${scope}" is not allowed for this approval; allowed: ${before.scopes.join(", ")}`,
      );
    }
    const updated = await t
      .updateTable("approvals")
      .set({
        status: approved ? "approved" : "denied",
        scope,
        decided_by: accountId,
        decided_at: sql<Date>`now()`,
        deny_reason: reason ?? null,
        ...(network?.outcome != null &&
          before.detail !== null && {
            // what took effect; run grants read grantedHosts (an always grant's hosts are on
            // the device's policy already, so it carries them harmlessly)
            detail: JSON.stringify({
              ...before.detail,
              grantedHosts: network.granted,
              outcome: network.outcome,
              ...(network.fallback !== undefined && { fallback: network.fallback }),
            } satisfies NetworkAskDetail),
          }),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    // 授权绑定所批准的定义指纹与来源连接器（同 slug 重新安装的连接器 id 不同，不继承）
    const hash = before.specHash;
    const connectorId = before.connectorId;
    if (network !== undefined) {
      // a network ask grants nothing of the tool kind: its run grant is the row itself
    } else if (scope === "session") {
      // a sub-agent's grant is the root conversation's (agent map spec §7): the root and every
      // agent of its tree, at any depth, are not asked again for the same call
      await t
        .insertInto("conversation_tool_grants")
        .values({
          conversation_id:
            ctx.parent_conversation_id === null
              ? before.conversationId
              : await rootConversationOf(t, ctx.parent_conversation_id),
          tool_key: before.toolKey,
          spec_hash: hash,
          connector_id: connectorId,
        })
        .onConflict((oc) =>
          oc
            .columns(["conversation_id", "tool_key"])
            .doUpdateSet({ spec_hash: hash, connector_id: connectorId }),
        )
        .execute();
    } else if (scope === "always" && before.requestedFor !== null) {
      await t
        .insertInto("tool_grants")
        .values({
          org_id: orgId,
          account_id: before.requestedFor,
          agent_id: ctx.agent_id,
          tool_key: before.toolKey,
          spec_hash: hash,
          connector_id: connectorId,
        })
        .onConflict((oc) =>
          oc.columns(["org_id", "account_id", "agent_id", "tool_key"]).doUpdateSet({
            spec_hash: hash,
            connector_id: connectorId,
            created_at: sql<Date>`now()`,
          }),
        )
        .execute();
    }
    if (approved && scope !== null && network === undefined) {
      await this.keepTrialGrant(before, accountId);
    }
    const written = await this.eventLog.appendIn(before.conversationId, [
      {
        type: "approval_decided",
        runId: before.runId,
        idemKey: `approval_decided:${id}`,
        payload: {
          approvalId: id,
          callId: before.callId,
          decision: approved ? "approved" : "denied",
          ...(scope !== null && { scope }),
          byAccountId: accountId,
          ...(reason !== undefined && { reason }),
        },
      },
    ]);
    if (network !== undefined && before.detail !== null) {
      const asked = [...new Set(before.detail.hosts.map((h) => h.host))];
      const refused = asked.filter((h) => !network.granted.includes(h));
      await audit(t, {
        actorAccountId: accountId,
        orgId,
        action: approved ? "device.network_allowed" : "device.network_denied",
        target: before.detail.deviceId,
        detail: {
          approvalId: id,
          deviceId: before.detail.deviceId,
          hosts: approved ? network.granted : asked,
          ...(approved && refused.length > 0 && { refused }),
          scope,
          outcome: approved ? network.outcome : "denied",
          ...(network.fallback !== undefined && { fallback: network.fallback }),
          by: accountId,
          via: network.via,
          conversationId: before.conversationId,
          runId: before.runId,
          ...(reason !== undefined && { reason }),
        },
      });
      return { record: toRecord(updated), toSeq: Math.max(...written.map((e) => e.seq)) };
    }
    await audit(t, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "approval.decided",
      target: id,
      detail: {
        toolKey: before.toolKey,
        conversationId: before.conversationId,
        runId: before.runId,
        agentId: ctx.agent_id,
        initiatorAccountId: ctx.trigger_account_id,
        decision: approved ? "approved" : "denied",
        scope,
        ...(body.note !== undefined && { note: body.note }),
        ...(reason !== undefined && { reason }),
      },
    });
    return { record: toRecord(updated), toSeq: Math.max(...written.map((e) => e.seq)) };
  }

  /**
   * A trial run of a scheduled task (scheduled tasks spec §7): an approval its creator granted, in
   * any scope, is also added to the task's grants with the approved definition's hash, so its
   * unattended runs do not ask again. Kept only by the rule `addGrants` applies
   * (`grantRefusalOf`, against the task agent's tools now): never a role-escalated approval
   * (`requestedFor` null, it stays `once`), one another account decided, one whose scopes never
   * allowed remembering (an org / platform operation: "once" only), a per-call key
   * (`Platform:<operation>`, a skill change among them), a fixed ask, a tool the org forbids (its key or the
   * call's), or a tool the task's agent does not have. In the decision's transaction.
   */
  @Transactional({ propagation: "mandatory" })
  private async keepTrialGrant(a: ApprovalRecord, decidedBy: string): Promise<void> {
    if (a.requestedFor === null || a.requestedFor !== decidedBy) return;
    if (!a.scopes.includes("always")) return;
    const t = this.db.db;
    const served = await unattendedTaskRunOf(t, a.runId);
    if (served === null || !served.trial) return;
    const task = await t
      .selectFrom("scheduled_tasks as s")
      .innerJoin("agents as ag", "ag.id", "s.agent_id")
      .leftJoin("agent_versions as v", (j) =>
        j.onRef("v.agent_id", "=", "ag.id").onRef("v.version", "=", "ag.current_version"),
      )
      .select(["s.account_id", "v.definition"])
      .where("s.id", "=", served.taskId)
      .where("s.deleted_at", "is", null)
      .executeTakeFirst();
    if (task?.account_id !== decidedBy) return;
    const member = await t
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", a.orgId)
      .where("account_id", "=", decidedBy)
      .executeTakeFirst();
    if (!member) return;
    const def =
      task.definition === null
        ? undefined
        : await normalizeStoredDefinitionIn(t, a.orgId, task.definition);
    const { tools } = await this.registry.forAgent(a.orgId, {
      disabledTools: def?.disabledTools ?? [],
      subagentTools: def?.subagentTools,
      subagents: def?.subagents,
    });
    const tool = tools.find((x) => x.key === a.toolKey);
    const { forbiddenTools } = await readScheduleSettings(t, this.config, a.orgId);
    const why = grantRefusalOf(a.toolKey, tool, {
      role: member.role,
      forbiddenTools,
    });
    if (why !== null) return;
    await this.schedules.addGrant(t, served.taskId, {
      toolKey: a.toolKey,
      specHash: a.specHash,
      connectorId: a.connectorId,
    });
  }

  /**
   * 详情，不做处理人校验（内核内部用：渠道出站投递组装 IM 审批卡片）；不存在返回 null。
   * 不得直接回给请求方——HTTP 接口用 {@link get}。
   */
  async describe(id: string): Promise<ApprovalView | null> {
    const row = await this.db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const [view] = await this.views([toRecord(row)]);
    return view ?? null;
  }

  /** 某个工具调用最近一次的工具审批（attempt 最大者，网络询问除外）；没有则返回 null。 */
  async forCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    const row = await this.db
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
      .where("kind", "=", "tool")
      .orderBy("attempt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /** The network ask of a tool call (at most one per call); null when it has none. */
  async networkForCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    const row = await this.db
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
      .where("kind", "=", "network")
      .orderBy("attempt", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? toRecord(row) : null;
  }

  /**
   * 超时（等待机制的超时任务调用）：仍 pending 且已到期 → 置 expired、写 `approval_decided{expired}`（处理人为 null）。
   * 与人工决定都锁同一行，恰好一个生效。返回 `expired`（本次生效）/ `not_due`（尚未到期）/
   * `settled`（已处理、已取消或不存在）。
   */
  async expire(id: string): Promise<{
    outcome: "expired" | "not_due" | "settled";
    record?: ApprovalRecord;
  }> {
    const r = await this.expireIn(id);
    if ("toSeq" in r && r.toSeq !== undefined && r.record) {
      await this.eventLog.notify(r.record.conversationId, r.toSeq);
    }
    return r.record ? { outcome: r.outcome, record: r.record } : { outcome: r.outcome };
  }

  @Transactional()
  private async expireIn(id: string): Promise<{
    outcome: "expired" | "not_due" | "settled";
    record?: ApprovalRecord;
    toSeq?: number;
  }> {
    const t = this.db.db;
    const locked = await t
      .selectFrom("approvals")
      .selectAll()
      .select(sql<boolean>`expires_at <= now()`.as("expired"))
      .where("id", "=", id)
      .forUpdate()
      .executeTakeFirst();
    if (!locked) return { outcome: "settled" as const };
    const before = toRecord(locked);
    if (before.status !== "pending") return { outcome: "settled" as const, record: before };
    if (!locked.expired) return { outcome: "not_due" as const, record: before };
    const updated = await t
      .updateTable("approvals")
      .set({ status: "expired", decided_at: sql<Date>`now()` })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirstOrThrow();
    const toSeq = await this.decidedEvent(before, "expired");
    return { outcome: "expired" as const, record: toRecord(updated), toSeq };
  }

  /**
   * 在调用方的事务内（`mandatory`）取消运行的全部 pending 审批（运行在等待中被中止），各写
   * `approval_decided{cancelled}`（处理人为 null）。返回被取消的记录；调用方提交后发布事件。
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingIn(runId: string): Promise<ApprovalRecord[]> {
    const t = this.db.db;
    const rows = await t
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", runId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const out: ApprovalRecord[] = [];
    for (const row of rows) {
      const updated = await t
        .updateTable("approvals")
        .set({ status: "cancelled", decided_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.decidedEvent(toRecord(row), "cancelled");
      out.push(toRecord(updated));
    }
    return out;
  }

  /**
   * 在调用方的事务内（`mandatory`）取消某组织里指定由 `accountId` 处理（`requested_for`）的全部 pending 审批（成员离职），
   * 走与 {@link cancelPendingIn} 相同的取消路径：置 cancelled、写 `approval_decided{cancelled}`（处理人为 null）。
   * 返回被取消的记录与各会话写到的最大 seq；调用方提交后发布事件（并可续跑对应运行）。
   */
  @Transactional({ propagation: "mandatory" })
  async cancelPendingFor(
    orgId: string,
    accountId: string,
  ): Promise<{ records: ApprovalRecord[]; seqs: Map<string, number> }> {
    const t = this.db.db;
    const rows = await t
      .selectFrom("approvals")
      .selectAll()
      .where("org_id", "=", orgId)
      .where("requested_for", "=", accountId)
      .where("status", "=", "pending")
      .orderBy("created_at")
      .forUpdate()
      .execute();
    const records: ApprovalRecord[] = [];
    const seqs = new Map<string, number>();
    for (const row of rows) {
      const updated = await t
        .updateTable("approvals")
        .set({ status: "cancelled", decided_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const seq = await this.decidedEvent(toRecord(row), "cancelled");
      seqs.set(row.conversation_id, Math.max(seqs.get(row.conversation_id) ?? 0, seq));
      records.push(toRecord(updated));
    }
    return { records, seqs };
  }

  /**
   * In the caller's transaction (`mandatory`; it wrote `authorAccountId`'s message in
   * `conversationId` and holds that conversation's row lock): the message skips the pending
   * network asks it closes (network ask-to-allow spec §6.7), as it skips questions: the asks of
   * active runs `authorAccountId` started, in the conversation and in its sub-agents'
   * conversations at any depth (their asks are shown in the root). Each becomes `skipped` with
   * `approval_decided{skipped}` by the author; access stays blocked. Returns the skipped records and
   * the highest seq written per conversation; the caller notifies and emits
   * `approval.decided{skipped}` after the commit, so the runs resume.
   */
  @Transactional({ propagation: "mandatory" })
  async skipNetworkIn(
    conversationId: string,
    authorAccountId: string,
  ): Promise<{ records: ApprovalRecord[]; seqs: Map<string, number> }> {
    const t = this.db.db;
    const tree = await this.subtreeOf(conversationId);
    const rows = await t
      .selectFrom("approvals as a")
      .innerJoin("runs as r", "r.id", "a.run_id")
      .selectAll("a")
      .where("a.conversation_id", "in", tree)
      .where("a.kind", "=", "network")
      .where("a.status", "=", "pending")
      .where(sql<boolean>`a.expires_at > now()`)
      .where("r.status", "in", ["running", "waiting"])
      .where("r.trigger_account_id", "=", authorAccountId)
      .orderBy("a.created_at")
      .orderBy("a.id")
      .forUpdate("a")
      .execute();
    const records: ApprovalRecord[] = [];
    const seqs = new Map<string, number>();
    for (const row of rows) {
      const updated = await t
        .updateTable("approvals")
        .set({ status: "skipped", decided_by: authorAccountId, decided_at: sql<Date>`now()` })
        .where("id", "=", row.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      const seq = await this.decidedEvent(toRecord(row), "skipped", authorAccountId);
      seqs.set(row.conversation_id, Math.max(seqs.get(row.conversation_id) ?? 0, seq));
      records.push(toRecord(updated));
    }
    return { records, seqs };
  }

  /** `conversationId` and its sub-agents' conversations at any depth (at most 16 levels). */
  private async subtreeOf(conversationId: string): Promise<string[]> {
    const all = [conversationId];
    let level = [conversationId];
    for (let depth = 0; depth < 16 && level.length > 0; depth++) {
      const rows = await this.db
        .selectFrom("conversations")
        .select("id")
        .where("parent_conversation_id", "in", level)
        .execute();
      level = rows.map((r) => r.id).filter((id) => !all.includes(id));
      all.push(...level);
    }
    return all;
  }

  /**
   * 系统写的 `approval_decided`（超时 / 取消，处理人为 null；跳过，处理人为消息作者），在当前事务内；返回事件 seq。
   */
  private async decidedEvent(
    a: ApprovalRecord,
    decision: "expired" | "cancelled" | "skipped",
    byAccountId: string | null = null,
  ): Promise<number> {
    const written = await this.eventLog.appendIn(a.conversationId, [
      {
        type: "approval_decided",
        runId: a.runId,
        idemKey: `approval_decided:${a.id}`,
        payload: { approvalId: a.id, callId: a.callId, decision, byAccountId },
      },
    ]);
    return Math.max(...written.map((e) => e.seq));
  }

  /** 本人在该组织的「以后都允许」授权。 */
  async listGrants(orgId: string, accountId: string): Promise<ToolGrantView[]> {
    const rows = await this.db
      .selectFrom("tool_grants")
      .select(["agent_id", "tool_key", "spec_hash", "created_at"])
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .orderBy("created_at", "desc")
      .execute();
    const names = await this.agentNames([...new Set(rows.map((r) => r.agent_id))]);
    return rows.map((r) => ({
      agentId: r.agent_id,
      agentName: names.get(r.agent_id) ?? "",
      toolKey: r.tool_key,
      specHash: r.spec_hash,
      createdAt: iso(r.created_at),
    }));
  }

  /** 撤销本人的一条授权；不存在时什么也不做（幂等）。 */
  async revokeGrant(
    orgId: string,
    accountId: string,
    agentId: string,
    toolKey: string,
    actorTokenId?: string,
  ): Promise<void> {
    await this.revokeGrantIn(orgId, accountId, agentId, toolKey, actorTokenId);
  }

  @Transactional()
  private async revokeGrantIn(
    orgId: string,
    accountId: string,
    agentId: string,
    toolKey: string,
    actorTokenId: string | undefined,
  ): Promise<void> {
    const t = this.db.db;
    const res = await t
      .deleteFrom("tool_grants")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .where("agent_id", "=", agentId)
      .where("tool_key", "=", toolKey)
      .executeTakeFirst();
    if (Number(res.numDeletedRows) === 0) return;
    await audit(t, {
      actorAccountId: accountId,
      ...(actorTokenId !== undefined && { actorTokenId }),
      orgId,
      action: "tool_grant.revoked",
      target: agentId,
      detail: { toolKey },
    });
  }

  /** The member's current role, read in the context's transaction when there is one. */
  private async roleOf(orgId: string, accountId: string): Promise<OrgRole | null> {
    const m = await this.db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();
    return m?.role ?? null;
  }

  /** agent id → 当前版本定义里的名字。 */
  private async agentNames(ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (j) =>
        j
          .onRef("agent_versions.agent_id", "=", "agents.id")
          .onRef("agent_versions.version", "=", "agents.current_version"),
      )
      .select(["agents.id", "agent_versions.definition"])
      .where("agents.id", "in", ids)
      .execute();
    return new Map(
      rows.map((r) => {
        const name = (r.definition as { name?: unknown } | null)?.name;
        return [r.id, typeof name === "string" ? name : ""];
      }),
    );
  }

  /** 补齐详情字段（批量读会话、运行、agent 名与连接器）。 */
  private async views(recs: ApprovalRecord[]): Promise<ApprovalView[]> {
    if (recs.length === 0) return [];
    const db = this.db;
    const ctxRows = await db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select([
        "runs.id",
        "runs.trigger_account_id",
        "conversations.agent_id",
        "conversations.parent_conversation_id",
      ])
      .where("runs.id", "in", [...new Set(recs.map((r) => r.runId))])
      .execute();
    const ctx = new Map(ctxRows.map((r) => [r.id, r]));
    // a sub-agent's approval links to the root conversation of its tree (agent map spec §7)
    const roots = new Map<string, string>();
    for (const p of new Set(ctxRows.flatMap((r) => r.parent_conversation_id ?? []))) {
      roots.set(p, await rootConversationOf(db.db, p));
    }
    const names = await this.agentNames([...new Set(ctxRows.map((r) => r.agent_id))]);
    const connectorIds = [
      ...new Set(recs.flatMap((r) => (r.connectorId === null ? [] : [r.connectorId]))),
    ];
    const apps =
      connectorIds.length === 0
        ? []
        : await db
            .selectFrom("connectors")
            .select(["id", "name", "slug"])
            .where("id", "in", connectorIds)
            .execute();
    const connectorById = new Map(apps.map((a) => [a.id, a]));
    const pluginOf = (r: ApprovalRecord): string | null => {
      if (r.connectorId !== null) return null;
      const p = parseToolKey(r.toolKey);
      return p?.kind === "extension" ? p.plugin : null;
    };
    const displayNames = await pluginDisplayNames(
      db.db,
      recs.flatMap((r) => {
        const p = pluginOf(r);
        return p === null ? [] : [p];
      }),
    );
    return recs.flatMap((r) => {
      const c = ctx.get(r.runId);
      if (!c) return [];
      const app = r.connectorId === null ? undefined : connectorById.get(r.connectorId);
      const prefix = app ? connectorToolKey(app.slug, "") : undefined;
      return [
        {
          ...publicRecord(r),
          toolName:
            prefix !== undefined && r.toolKey.startsWith(prefix)
              ? r.toolKey.slice(prefix.length)
              : r.toolKey,
          connector: app ? { id: app.id, name: app.name, slug: app.slug } : null,
          extension: (() => {
            const p = pluginOf(r);
            return p === null
              ? null
              : { name: p, displayName: displayNames.get(p) ?? { zh: p, en: p } };
          })(),
          agent: { id: c.agent_id, name: names.get(c.agent_id) ?? "" },
          ...(c.parent_conversation_id !== null
            ? {
                conversationPath: `/chat/${roots.get(c.parent_conversation_id) ?? c.parent_conversation_id}?subagent=${r.conversationId}`,
                parentConversationId: c.parent_conversation_id,
              }
            : { conversationPath: `/chat/${r.conversationId}` }),
          initiatorAccountId: c.trigger_account_id,
        },
      ];
    });
  }
}
