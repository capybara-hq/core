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
  toolKey: string;
  specHash: string | null;
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
   * 决定提交之后调用（恰好一次：只有赢得行锁、把 pending 改掉的那次决定会调用）。默认空操作；
   * Task 9 接入续跑。失败只记日志（决定已生效）。
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
   * 按 (run_id, call_id) 幂等：已存在则返回已有记录（不覆盖），事件按 `approval_requested:<approvalId>` 幂等。
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
        .onConflict((oc) => oc.columns(["run_id", "call_id"]).doNothing())
        .execute();
      const row = await t
        .selectFrom("approvals")
        .selectAll()
        .where("run_id", "=", input.runId)
        .where("call_id", "=", input.callId)
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
      const hash = before.specHash;
      if (scope === "session" && hash !== null) {
        await t
          .insertInto("conversation_tool_grants")
          .values({
            conversation_id: before.conversationId,
            tool_key: before.toolKey,
            spec_hash: hash,
          })
          .onConflict((oc) =>
            oc.columns(["conversation_id", "tool_key"]).doUpdateSet({ spec_hash: hash }),
          )
          .execute();
      } else if (scope === "always" && hash !== null && before.requestedFor !== null) {
        await t
          .insertInto("tool_grants")
          .values({
            org_id: orgId,
            account_id: before.requestedFor,
            agent_id: ctx.agent_id,
            tool_key: before.toolKey,
            spec_hash: hash,
          })
          .onConflict((oc) =>
            oc
              .columns(["org_id", "account_id", "agent_id", "tool_key"])
              .doUpdateSet({ spec_hash: hash, created_at: sql<Date>`now()` }),
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
