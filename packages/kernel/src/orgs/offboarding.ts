import type { Logger } from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import type { EventLog } from "../conversations/event-log.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { SessionService } from "../identity/sessions.js";
import type { Maintenance } from "../runtime/maintenance.js";
import type { ApprovalsService } from "../tools/approvals.service.js";
import type { Credentials } from "../tools/credentials.js";
import type { QuestionsService } from "../tools/questions.service.js";
import type { OrgRole } from "./roles.js";

type Trx = Transaction<KernelDatabase>;

/** 离职原因：管理员移出、本人离开、通讯录同步判定离职。 */
export type OffboardReason = "removed" | "left" | "directory";

/** 一个进行中的运行。 */
export interface InFlightRun {
  conversationId: string;
  runId: string;
  status: "queued" | "running" | "waiting";
}

/** 一次离职处理的结果；调用方提交事务后交给 {@link Offboarding.afterCommit}。 */
export interface OffboardResult {
  role: OrgRole;
  /** 在 PG 中被吊销的会话（提交后写 Redis 吊销标记）。 */
  revokedSessionIds: string[];
  /** 写了 cancelled 事件的会话 → 最大 seq（提交后发布）。 */
  notify: Map<string, number>;
  /** 此人在该组织进行中的运行（queued / running / waiting），提交后中止。 */
  runs: InFlightRun[];
  /** 负责的 agent 转交给的所有者；没有转交时为 null。 */
  newOwnerId: string | null;
}

/** 运行中止：与会话中止接口（`POST .../abort`）同一套路径，`byAccountId = null` 表示系统发起。 */
export interface OffboardingRunControl {
  abortWaiting(conversationId: string, runId: string, byAccountId: string | null): Promise<boolean>;
  abortIfOrphaned(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean>;
  requestAbort(runId: string, byAccountId: string | null): Promise<void>;
}

/** 兜底扫描：维护队列任务名、job scheduler id（不含 `:`）、周期与每次条数。 */
export const OFFBOARD_SWEEP_JOB = "offboard-sweep";
export const OFFBOARD_SWEEP_SCHEDULER_ID = "offboard-sweep-every-10m";
export const OFFBOARD_SWEEP_EVERY_MS = 600_000;
export const OFFBOARD_SWEEP_BATCH = 500;

const ACTIVE = ["queued", "running", "waiting"] as const;

export interface OffboardingDeps {
  credentials: Pick<Credentials, "clearAccount">;
  approvals: Pick<ApprovalsService, "cancelPendingFor">;
  questions: Pick<QuestionsService, "cancelPendingFor">;
  /** 提交后写会话吊销标记（快速路径；鉴权以 PG `revoked_at` 为准）。 */
  sessions?: Pick<SessionService, "markRevoked">;
  /** 提交后发布 cancelled 事件。 */
  eventLog?: Pick<EventLog, "notify">;
  /** 提交后中止此人在该组织进行中的运行（Ruling A7）。 */
  runs?: OffboardingRunControl;
  /** 兜底扫描用：读「发起人已不是成员」的进行中运行。 */
  db?: KernelDb;
  /** 给了就登记兜底扫描（每 10 分钟，worker 角色执行）。 */
  maintenance?: Pick<Maintenance, "handle" | "schedule">;
  log?: Pick<Logger, "warn">;
}

/**
 * 成员离职（spec 3.3）：管理员移出、本人离开与通讯录同步共用这一条路径，全部写入在调用方的同一个事务内，
 * 要么都生效要么都不生效。Redis 吊销标记、事件发布与中止进行中的运行是提交后的尽力而为（{@link afterCommit}），
 * 漏掉的运行由兜底扫描（{@link sweep}：发起人已不是该组织成员的进行中运行）中止。框架无关。
 *
 * 已接受的窄窗口：离职提交时正在进行的 OAuth token 刷新（`Credentials` 刷新锁内）可能在提交之后把此人的
 * 个人凭据重新写回（upsert）。凭据只在此人以成员身份调用工具时使用，而其运行已被中止、成员关系已删除，
 * 残留的凭据不会被使用；重新加入组织后会被新的连接覆盖。
 */
export class Offboarding {
  constructor(private readonly deps: OffboardingDeps) {
    deps.maintenance?.schedule({
      id: OFFBOARD_SWEEP_SCHEDULER_ID,
      name: OFFBOARD_SWEEP_JOB,
      everyMs: () => OFFBOARD_SWEEP_EVERY_MS,
    });
    deps.maintenance?.handle(OFFBOARD_SWEEP_JOB, async () => {
      await this.sweep();
    });
  }

  /**
   * 在事务 `t` 内（调用方应已锁组织行——顺序：组织行 → 成员关系，并完成「最后一个 owner」等前置检查）：
   * 1. 删除成员关系（非成员 → `member.not_found`；删后组织没有 owner → `org.last_owner`），清空指向该组织的会话当前组织；
   * 2. 吊销该账号**全部**会话与个人令牌（令牌与会话是账号级的，无法只吊销「该组织下」的，按保守处理）；
   * 3. 删除其在该组织所有应用上的个人凭据；
   * 4. 取消其作为处理人的 pending 审批与提问（写 cancelled 事件），记下此人在该组织进行中的运行（提交后中止）；
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

    const runs = await t
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id", "runs.status"])
      .where("conversations.org_id", "=", orgId)
      .where("runs.status", "in", ACTIVE)
      .where((eb) =>
        eb.or([
          eb("runs.trigger_account_id", "=", accountId),
          eb("conversations.account_id", "=", accountId),
        ]),
      )
      .execute();

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
        runsToStop: runs.length,
        agentsReassigned: agents.map((a) => a.id),
        newOwner: agents.length > 0 ? owner.account_id : null,
      },
    });
    return {
      role: deleted.role,
      revokedSessionIds: sessions.map((s) => s.id),
      notify,
      runs: runs.map((r) => ({
        conversationId: r.conversation_id,
        runId: r.id,
        status: r.status as InFlightRun["status"],
      })),
      newOwnerId: agents.length > 0 ? owner.account_id : null,
    };
  }

  /** 提交之后：写会话吊销标记、发布 cancelled 事件、中止此人在该组织进行中的运行。每步失败只记 warn。 */
  async afterCommit(r: OffboardResult): Promise<void> {
    const { sessions, eventLog, log } = this.deps;
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
    for (const run of r.runs) await this.stopRun(run);
  }

  /**
   * 中止一个运行，顺序同会话中止接口：waiting → 直接取消等待并写终态；孤儿 → 直接写终态；
   * 否则经 Redis 广播中止（运行所在副本收到后结束；尚未开始的运行开始时补查中止标记）。失败只记 warn。
   * 不像会话中止那样随后起新一轮运行：离职者的待处理消息不再处理。
   */
  private async stopRun(run: InFlightRun): Promise<void> {
    const ctl = this.deps.runs;
    if (!ctl) return;
    try {
      if (
        run.status === "waiting" &&
        (await ctl.abortWaiting(run.conversationId, run.runId, null))
      ) {
        return;
      }
      if (await ctl.abortIfOrphaned(run.conversationId, run.runId, null)) return;
      await ctl.requestAbort(run.runId, null);
    } catch (err) {
      this.deps.log?.warn("offboarding: cannot stop run", { runId: run.runId, err });
    }
  }

  /**
   * 兜底扫描（维护队列每 10 分钟）：进行中、且发起人已不是该会话所属组织成员的运行 → 中止
   * （提交后的中止没做成时，如进程崩溃）。返回本次处理的运行数（经广播中止的运行在真正结束前，下一轮仍会再处理）。
   */
  async sweep(): Promise<number> {
    const { db } = this.deps;
    if (!db || !this.deps.runs) return 0;
    const rows = await db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id", "runs.status"])
      .where("runs.status", "in", ACTIVE)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("memberships")
              .select(sql`1`.as("one"))
              .whereRef("memberships.org_id", "=", "conversations.org_id")
              .whereRef("memberships.account_id", "=", "runs.trigger_account_id"),
          ),
        ),
      )
      .limit(OFFBOARD_SWEEP_BATCH)
      .execute();
    for (const r of rows) {
      this.deps.log?.warn("offboard sweep: stopping run of a former member", { runId: r.id });
      await this.stopRun({
        conversationId: r.conversation_id,
        runId: r.id,
        status: r.status as InFlightRun["status"],
      });
    }
    return rows.length;
  }
}
