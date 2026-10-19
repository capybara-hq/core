import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { type Selectable, sql, type Transaction } from "kysely";
import type { KernelConfig } from "../config/schema.js";
import type { EventLog } from "../conversations/event-log.js";
import type { ApprovalsTable, KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { ORG_ROLES, type OrgRole, roleAtLeast } from "../orgs/roles.js";

type Trx = Transaction<KernelDatabase>;

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "cancelled";
export type ApprovalScope = "once" | "session" | "always";

/** 一条审批记录。 */
export interface ApprovalRecord {
  id: string;
  orgId: string;
  conversationId: string;
  runId: string;
  callId: string;
  /** 同一调用的第几次审批（从 1 起；工具定义变化后重新审批时递增）。 */
  attempt: number;
  toolKey: string;
  specHash: string;
  appId: string | null;
  input: unknown;
  requestedFor: string | null;
  approverRole: OrgRole | null;
  status: ApprovalStatus;
  scope: ApprovalScope | null;
  decidedBy: string | null;
  decidedAt: string | null;
  expiresAt: string;
  createdAt: string;
}

/** 审批详情（列表与详情接口返回）。 */
export interface ApprovalView extends ApprovalRecord {
  /** 来源内的工具原名（应用工具为应用里的名字；否则同 `toolKey`）。 */
  toolName: string;
  app: { id: string; name: string; slug: string } | null;
  agent: { id: string; name: string };
  /** 网页中该会话的路径（不含语言前缀）。 */
  conversationPath: string;
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
  appId: string | null;
  input: unknown;
  /** 指定处理人；与 `approverRole` 至少一个非空。 */
  requestedFor: string | null;
  approverRole: OrgRole | null;
  /** 同一调用的第几次审批，缺省 1（等待期间工具定义变化、原批准不再适用时递增）。 */
  attempt?: number;
}

export interface DecisionInput {
  decision: "approve" | "deny";
  /** 只对批准有意义，缺省 `once`。按角色升级的审批只能 `once`。 */
  scope?: ApprovalScope | undefined;
  note?: string | undefined;
}

/** 「以后都允许」授权（本人可撤销）。 */
export interface ToolGrantView {
  agentId: string;
  agentName: string;
  toolKey: string;
  specHash: string;
  createdAt: string;
}

export interface ApprovalsServiceDeps {
  db: KernelDb;
  eventLog: EventLog;
  config: () => KernelConfig;
  log: Pick<Logger, "warn">;
  /**
   * 决定提交之后调用（恰好一次：只有赢得行锁、把 pending 改掉的那次决定会调用），内核接入续跑。
   * 默认空操作；失败只记日志（决定已生效，超时任务到点时会再尝试续跑）。
   */
  onDecided?: (approval: ApprovalRecord) => Promise<void>;
}

const notFound = () => new ApiError("approval.not_found", "Approval not found");
const iso = (v: Date | string): string => new Date(v).toISOString();
const isRole = (v: string | null): v is OrgRole =>
  v !== null && (ORG_ROLES as readonly string[]).includes(v);

function toRecord(r: Selectable<ApprovalsTable>): ApprovalRecord {
  return {
    id: r.id,
    orgId: r.org_id,
    conversationId: r.conversation_id,
    runId: r.run_id,
    callId: r.call_id,
    attempt: r.attempt,
    toolKey: r.tool_key,
    specHash: r.spec_hash,
    appId: r.app_id,
    input: r.input,
    requestedFor: r.requested_for,
    approverRole: isRole(r.approver_role) ? r.approver_role : null,
    status: r.status,
    scope: r.scope,
    decidedBy: r.decided_by,
    decidedAt: r.decided_at === null ? null : iso(r.decided_at),
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
 */
export class ApprovalsService {
  constructor(private readonly deps: ApprovalsServiceDeps) {}

  /**
   * 新建 pending 审批（`expires_at` = 现在 + `tools.approvalTimeoutHours`）并写 `approval_requested`，同一事务。
   * 按 (run_id, call_id, attempt) 幂等：已存在则返回已有记录（不覆盖），事件按 `approval_requested:<approvalId>` 幂等。
   */
  async request(input: ApprovalRequestInput): Promise<ApprovalRecord> {
    if (input.requestedFor === null && input.approverRole === null) {
      throw new Error("approval requires requestedFor or approverRole");
    }
    const { db, eventLog, config } = this.deps;
    const hours = config().tools.approvalTimeoutHours;
    const { record, toSeq } = await db.transaction().execute(async (t) => {
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
          app_id: input.appId,
          input: JSON.stringify(input.input ?? {}),
          requested_for: input.requestedFor,
          approver_role: input.approverRole,
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
      const written = await eventLog.append(
        rec.conversationId,
        [
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
            },
          },
        ],
        t,
      );
      return { record: rec, toSeq: Math.max(...written.map((e) => e.seq)) };
    });
    await eventLog.notify(record.conversationId, toSeq);
    return record;
  }

  /** 当前用户能处理的审批（新的在前，最多 100 条）；`status` 缺省为全部。 */
  async list(orgId: string, accountId: string, status?: ApprovalStatus): Promise<ApprovalView[]> {
    const role = await this.roleOf(this.deps.db, orgId, accountId);
    const roles = role === null ? [] : ORG_ROLES.filter((r) => roleAtLeast(role, r));
    let q = this.deps.db
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
    const rows = await q.orderBy("approvals.created_at", "desc").limit(100).execute();
    return this.views(rows.map(toRecord));
  }

  /** 详情；当前用户不能处理的一律 `approval.not_found`（不泄露存在）。 */
  async get(orgId: string, id: string, accountId: string): Promise<ApprovalView> {
    const row = await this.deps.db
      .selectFrom("approvals")
      .innerJoin("runs", "runs.id", "approvals.run_id")
      .selectAll("approvals")
      .select("runs.trigger_account_id")
      .where("approvals.id", "=", id)
      .where("approvals.org_id", "=", orgId)
      .executeTakeFirst();
    if (!row) throw notFound();
    const role = await this.roleOf(this.deps.db, orgId, accountId);
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
  ): Promise<ApprovalRecord> {
    const { db, eventLog } = this.deps;
    const { record, toSeq } = await db.transaction().execute(async (t) => {
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
        .select(["runs.trigger_account_id", "conversations.agent_id"])
        .where("runs.id", "=", locked.run_id)
        .executeTakeFirstOrThrow();
      const before = toRecord(locked);
      const role = await this.roleOf(t, orgId, accountId);
      if (!canHandle(before, ctx.trigger_account_id, accountId, role)) throw notFound();
      if (before.status !== "pending") {
        throw new ApiError("approval.already_decided", "Approval has already been decided");
      }
      if (locked.expired) {
        throw new ApiError("approval.already_decided", "Approval has expired");
      }
      const approved = body.decision === "approve";
      const scope: ApprovalScope | null = approved ? (body.scope ?? "once") : null;
      // 按角色升级的批准只对这一次有效：授权记在发起人名下会让其以后绕过角色要求
      if (scope !== null && scope !== "once" && before.requestedFor === null) {
        throw new ApiError(
          "validation_failed",
          'Only scope "once" is allowed for role-escalated approvals',
          [{ path: "scope", message: 'Only "once" is allowed for role-escalated approvals' }],
        );
      }
      const updated = await t
        .updateTable("approvals")
        .set({
          status: approved ? "approved" : "denied",
          scope,
          decided_by: accountId,
          decided_at: sql<Date>`now()`,
        })
        .where("id", "=", id)
        .returningAll()
        .executeTakeFirstOrThrow();
      // 授权绑定所批准的定义指纹与来源应用（同 slug 重新安装的应用 id 不同，不继承）
      const hash = before.specHash;
      const appId = before.appId;
      if (scope === "session") {
        await t
          .insertInto("conversation_tool_grants")
          .values({
            conversation_id: before.conversationId,
            tool_key: before.toolKey,
            spec_hash: hash,
            app_id: appId,
          })
          .onConflict((oc) =>
            oc
              .columns(["conversation_id", "tool_key"])
              .doUpdateSet({ spec_hash: hash, app_id: appId }),
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
            app_id: appId,
          })
          .onConflict((oc) =>
            oc
              .columns(["org_id", "account_id", "agent_id", "tool_key"])
              .doUpdateSet({ spec_hash: hash, app_id: appId, created_at: sql<Date>`now()` }),
          )
          .execute();
      }
      const written = await eventLog.append(
        before.conversationId,
        [
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
            },
          },
        ],
        t,
      );
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
        },
      });
      return { record: toRecord(updated), toSeq: Math.max(...written.map((e) => e.seq)) };
    });
    await eventLog.notify(record.conversationId, toSeq);
    if (this.deps.onDecided) {
      try {
        await this.deps.onDecided(record);
      } catch (err) {
        this.deps.log.warn("approval onDecided hook failed", { approvalId: record.id, err });
      }
    }
    return record;
  }

  /**
   * 详情，不做处理人校验（内核内部用：渠道出站投递组装 IM 审批卡片）；不存在返回 null。
   * 不得直接回给请求方——HTTP 接口用 {@link get}。
   */
  async describe(id: string): Promise<ApprovalView | null> {
    const row = await this.deps.db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!row) return null;
    const [view] = await this.views([toRecord(row)]);
    return view ?? null;
  }

  /** 某个工具调用最近一次的审批（attempt 最大者）；没有则返回 null。 */
  async forCall(runId: string, callId: string): Promise<ApprovalRecord | null> {
    const row = await this.deps.db
      .selectFrom("approvals")
      .selectAll()
      .where("run_id", "=", runId)
      .where("call_id", "=", callId)
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
    const { db, eventLog } = this.deps;
    const r = await db.transaction().execute(async (t) => {
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
      const toSeq = await this.decidedEvent(t, before, "expired");
      return { outcome: "expired" as const, record: toRecord(updated), toSeq };
    });
    if ("toSeq" in r && r.toSeq !== undefined && r.record) {
      await eventLog.notify(r.record.conversationId, r.toSeq);
    }
    return r.record ? { outcome: r.outcome, record: r.record } : { outcome: r.outcome };
  }

  /**
   * 在事务 `t` 内取消运行的全部 pending 审批（运行在等待中被中止），各写 `approval_decided{cancelled}`
   * （处理人为 null）。返回被取消的记录；调用方提交后发布事件。
   */
  async cancelPendingIn(t: Trx, runId: string): Promise<ApprovalRecord[]> {
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
      await this.decidedEvent(t, toRecord(row), "cancelled");
      out.push(toRecord(updated));
    }
    return out;
  }

  /**
   * 在事务 `t` 内取消某组织里指定由 `accountId` 处理（`requested_for`）的全部 pending 审批（成员离职），
   * 走与 {@link cancelPendingIn} 相同的取消路径：置 cancelled、写 `approval_decided{cancelled}`（处理人为 null）。
   * 返回被取消的记录与各会话写到的最大 seq；调用方提交后发布事件（并可续跑对应运行）。
   */
  async cancelPendingFor(
    t: Trx,
    orgId: string,
    accountId: string,
  ): Promise<{ records: ApprovalRecord[]; seqs: Map<string, number> }> {
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
      const seq = await this.decidedEvent(t, toRecord(row), "cancelled");
      seqs.set(row.conversation_id, Math.max(seqs.get(row.conversation_id) ?? 0, seq));
      records.push(toRecord(updated));
    }
    return { records, seqs };
  }

  /** 系统写的 `approval_decided`（超时 / 取消，处理人为 null），返回事件 seq。 */
  private async decidedEvent(
    t: Trx,
    a: ApprovalRecord,
    decision: "expired" | "cancelled",
  ): Promise<number> {
    const written = await this.deps.eventLog.append(
      a.conversationId,
      [
        {
          type: "approval_decided",
          runId: a.runId,
          idemKey: `approval_decided:${a.id}`,
          payload: { approvalId: a.id, callId: a.callId, decision, byAccountId: null },
        },
      ],
      t,
    );
    return Math.max(...written.map((e) => e.seq));
  }

  /** 本人在该组织的「以后都允许」授权。 */
  async listGrants(orgId: string, accountId: string): Promise<ToolGrantView[]> {
    const rows = await this.deps.db
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
    await this.deps.db.transaction().execute(async (t) => {
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
    });
  }

  private async roleOf(
    db: KernelDb | Trx,
    orgId: string,
    accountId: string,
  ): Promise<OrgRole | null> {
    const m = await db
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
    const rows = await this.deps.db
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

  /** 补齐详情字段（批量读会话、运行、agent 名与应用）。 */
  private async views(recs: ApprovalRecord[]): Promise<ApprovalView[]> {
    if (recs.length === 0) return [];
    const { db } = this.deps;
    const ctxRows = await db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.id", "runs.trigger_account_id", "conversations.agent_id"])
      .where("runs.id", "in", [...new Set(recs.map((r) => r.runId))])
      .execute();
    const ctx = new Map(ctxRows.map((r) => [r.id, r]));
    const names = await this.agentNames([...new Set(ctxRows.map((r) => r.agent_id))]);
    const appIds = [...new Set(recs.flatMap((r) => (r.appId === null ? [] : [r.appId])))];
    const apps =
      appIds.length === 0
        ? []
        : await db
            .selectFrom("apps")
            .select(["id", "name", "slug"])
            .where("id", "in", appIds)
            .execute();
    const appById = new Map(apps.map((a) => [a.id, a]));
    return recs.flatMap((r) => {
      const c = ctx.get(r.runId);
      if (!c) return [];
      const app = r.appId === null ? undefined : appById.get(r.appId);
      const prefix = app ? `${app.slug}__` : undefined;
      return [
        {
          ...r,
          toolName:
            prefix !== undefined && r.toolKey.startsWith(prefix)
              ? r.toolKey.slice(prefix.length)
              : r.toolKey,
          app: app ? { id: app.id, name: app.name, slug: app.slug } : null,
          agent: { id: c.agent_id, name: names.get(c.agent_id) ?? "" },
          conversationPath: `/chat/${r.conversationId}`,
          initiatorAccountId: c.trigger_account_id,
        },
      ];
    });
  }
}
