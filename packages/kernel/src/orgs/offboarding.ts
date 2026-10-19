import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { KernelDatabase } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { SessionService } from "../identity/sessions.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { Credentials } from "../tools/credentials.js";
import type { QuestionsService } from "../tools/questions.service.js";
import type { OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

/** 离职原因：管理员移出、本人离开、通讯录同步判定离职。 */
export type OffboardReason = "removed" | "left" | "directory";

/** 一次离职处理的结果；调用方提交事务后交给 {@link Offboarding.afterCommit}。 */
export interface OffboardResult {
  role: OrgRole;
  /** 在 PG 中被吊销的会话（提交后写 Redis 吊销标记）。 */
  revokedSessionIds: string[];
  /** 写了 cancelled 事件的会话 → 最大 seq（提交后发布）。 */
  notify: Map<string, number>;
  /** 被取消的等待（运行 id + 审批 / 输入请求 id），提交后可续跑这些运行。 */
  cancelledWaits: { runId: string; waitId: string }[];
  /** 负责的 agent 转交给的所有者；没有转交时为 null。 */
  newOwnerId: string | null;
}

export interface OffboardingDeps {
  credentials: Pick<Credentials, "clearAccount">;
  approvals: Pick<ApprovalsService, "cancelPendingFor">;
  questions: Pick<QuestionsService, "cancelPendingFor">;
  /** 提交后写会话吊销标记（快速路径；鉴权以 PG `revoked_at` 为准）。 */
  sessions?: Pick<SessionService, "markRevoked">;
  /** 提交后发布 cancelled 事件。 */
  eventLog?: Pick<EventLog, "notify">;
  /** 提交后续跑等待被取消的运行（模型从日志看到取消结果）。 */
  resume?: (runId: string, waitId: string) => Promise<unknown>;
  log?: Pick<Logger, "warn">;
}

/**
 * 成员离职（spec 3.3）：管理员移出、本人离开与通讯录同步共用这一条路径，全部写入在调用方的同一个事务内，
 * 要么都生效要么都不生效。Redis 吊销标记、事件发布与续跑是提交后的尽力而为（{@link afterCommit}）。框架无关。
 */
export class Offboarding {
  constructor(private readonly deps: OffboardingDeps) {}

  /**
   * 在事务 `t` 内（调用方应已锁组织行，并完成「最后一个 owner」等前置检查）：
   * 1. 删除成员关系（非成员 → `member.not_found`；删后组织没有 owner → `org.last_owner`），清空指向该组织的会话当前组织；
   * 2. 吊销该账号**全部**会话与个人令牌（令牌与会话是账号级的，无法只吊销「该组织下」的，按保守处理）；
   * 3. 删除其在该组织所有应用上的个人凭据；
   * 4. 取消其作为处理人的 pending 审批与提问（写 cancelled 事件）；
   * 5. 其负责的该组织 agent 转给组织所有者（最早加入的 owner）并置 `needs_reassignment = true`；
   * 6. 审计 `org.member.offboarded`。
   */
  async offboard(
    t: Trx,
    orgId: string,
    accountId: string,
    reason: OffboardReason,
    actor: { actorAccountId?: string; actorTokenId?: string } = {},
  ): Promise<OffboardResult> {
    const deleted = await t
      .deleteFrom("memberships")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .returning("role")
      .executeTakeFirst();
    if (!deleted) throw new ApiError("member.not_found", "Member not found");
    const owner = await t
      .selectFrom("memberships")
      .select("account_id")
      .where("org_id", "=", orgId)
      .where("role", "=", "owner")
      .orderBy("created_at")
      .orderBy("account_id")
      .limit(1)
      .executeTakeFirst();
    if (!owner) {
      throw new ApiError("org.last_owner", "An organization must keep at least one owner");
    }
    await t
      .updateTable("sessions")
      .set({ current_org_id: null })
      .where("account_id", "=", accountId)
      .where("current_org_id", "=", orgId)
      .execute();

    const sessions = await t
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();
    const tokens = await t
      .updateTable("api_tokens")
      .set({ revoked_at: sql<Date>`now()` })
      .where("kind", "=", "personal")
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();

    const credentials = await this.deps.credentials.clearAccount(orgId, accountId, t);

    const approvals = await this.deps.approvals.cancelPendingFor(t, orgId, accountId);
    const questions = await this.deps.questions.cancelPendingFor(t, orgId, accountId);
    const notify = new Map(approvals.seqs);
    for (const [c, seq] of questions.seqs) notify.set(c, Math.max(notify.get(c) ?? 0, seq));

    const agents = await t
      .updateTable("agents")
      .set({
        owner_account_id: owner.account_id,
        needs_reassignment: true,
        updated_at: sql<Date>`now()`,
      })
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .returning("id")
      .execute();

    await audit(t, {
      ...(actor.actorAccountId !== undefined && { actorAccountId: actor.actorAccountId }),
      ...(actor.actorTokenId !== undefined && { actorTokenId: actor.actorTokenId }),
      orgId,
      action: "org.member.offboarded",
      target: accountId,
      detail: {
        reason,
        role: deleted.role,
        sessionsRevoked: sessions.length,
        tokensRevoked: tokens.length,
        credentialsDeleted: credentials,
        approvalsCancelled: approvals.records.length,
        questionsCancelled: questions.records.length,
        agentsReassigned: agents.map((a) => a.id),
        newOwner: agents.length > 0 ? owner.account_id : null,
      },
    });
    return {
      role: deleted.role,
      revokedSessionIds: sessions.map((s) => s.id),
      notify,
      cancelledWaits: [
        ...approvals.records.map((a) => ({ runId: a.runId, waitId: a.id })),
        ...questions.records.map((q) => ({ runId: q.runId, waitId: q.id })),
      ],
      newOwnerId: agents.length > 0 ? owner.account_id : null,
    };
  }

  /** 提交之后：写会话吊销标记、发布 cancelled 事件、续跑等待被取消的运行。每步失败只记 warn。 */
  async afterCommit(r: OffboardResult): Promise<void> {
    const { sessions, eventLog, resume, log } = this.deps;
    try {
      await sessions?.markRevoked(r.revokedSessionIds);
    } catch (err) {
      log?.warn("offboarding: cannot write session revocation markers", { err });
    }
    for (const [conversationId, seq] of r.notify) {
      try {
        await eventLog?.notify(conversationId, seq);
      } catch (err) {
        log?.warn("offboarding: event notify failed", { conversationId, err });
      }
    }
    if (resume) {
      for (const w of r.cancelledWaits) {
        try {
          await resume(w.runId, w.waitId);
        } catch (err) {
          log?.warn("offboarding: cannot resume run", { runId: w.runId, err });
        }
      }
    }
  }
}
