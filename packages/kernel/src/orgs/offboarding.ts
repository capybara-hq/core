import { DIRECTORY_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { sql } from "kysely";
import { EventLog } from "../conversations/event-log.js";
import { ApiError } from "../errors.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { SessionService } from "../identity/sessions.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER, REDIS } from "../infra/tokens.js";
import { LegacyPorts } from "../lifecycle/legacy-ports.js";
import type { KernelLogger } from "../log.js";
import { RunControl } from "../runtime/run-control.js";
import { ApprovalsService } from "../tools/approvals.service.js";
import { Credentials } from "../tools/credentials.js";
import { QuestionsService } from "../tools/questions.service.js";
import type { OrgRole } from "./roles.js";

/** 离职原因：管理员移出、本人离开、通讯录同步判定离职。 */
export type OffboardReason = "removed" | "left" | "directory";

/** 一个进行中的运行。 */
export interface InFlightRun {
  conversationId: string;
  runId: string;
  status: "queued" | "running" | "waiting";
}

/** The result of one offboarding; the caller registers {@link Offboarding.afterOffboard} with the infra `afterCommit`. */
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
  /** 此人在该组织的对话里还没销毁的沙箱（按对话 id），提交后投递销毁。 */
  sandboxConversations: string[];
  /** Conversations whose queued messages were deleted (`changed: queue` after commit). */
  queueConversations: string[];
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

/** The safety-net sweep: cron job name (no `:`), every 10 minutes, and the rows per page. */
export const OFFBOARD_SWEEP_JOB = "offboard-sweep";
/** The maintenance job scheduler id it had before it became a cron (retired at worker start). */
export const OFFBOARD_SWEEP_SCHEDULER_ID = "offboard-sweep-every-10m";
export const OFFBOARD_SWEEP_BATCH = 500;
/** 一次兜底扫描最多翻的页数（每页 {@link OFFBOARD_SWEEP_BATCH} 条），防止单次任务无限长。 */
export const OFFBOARD_SWEEP_MAX_PAGES = 20;
/** 已经广播中止的运行的标记保留时长（秒），长于扫描周期：期间扫描不再重复广播。 */
export const OFFBOARD_ABORT_MARK_TTL_SECONDS = 1800;
/** 「已请求中止」标记（Redis 键）。 */
export const offboardAbortKey = (runId: string) => `capk:offboard-abort:${runId}`;

const ACTIVE = ["queued", "running", "waiting"] as const;
/** 通讯录同步加入的成员关系的 `source` 前缀（`directory:<插件名>`）。 */
const DIRECTORY_SOURCE_PREFIX = "directory:";

/**
 * 成员离职（spec 3.3）：管理员移出、本人离开与通讯录同步共用这一条路径，全部写入在调用方的同一个事务内，
 * 要么都生效要么都不生效。Redis 吊销标记、事件发布与中止进行中的运行是提交后的尽力而为（{@link afterOffboard}），
 * 漏掉的运行由兜底扫描（{@link sweep}：发起人已不是该组织成员的进行中运行）中止。框架无关。
 *
 * 已接受的窄窗口：离职提交时正在进行的 OAuth token 刷新（`Credentials` 刷新锁内）可能在提交之后把此人的
 * 个人凭据重新写回（upsert）。凭据只在此人以成员身份调用工具时使用，而其运行已被中止、成员关系已删除，
 * 残留的凭据不会被使用；重新加入组织后会被新的连接覆盖。
 *
 * The sandbox destruction (Task 3.8) is read from {@link LegacyPorts} at call time.
 */
@Injectable()
export class Offboarding {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SessionService) private readonly sessions: Pick<SessionService, "markRevoked">,
    @Inject(REDIS) private readonly redis: Pick<Redis, "set" | "exists">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "notify" | "publishChanged">,
    @Inject(LegacyPorts) private readonly ports: LegacyPorts,
    /** Stops the departed member's runs (`by: null`, a system action). */
    @Inject(RunControl) private readonly runs: OffboardingRunControl,
    @Inject(Credentials) private readonly credentials: Pick<Credentials, "clearAccount">,
    @Inject(ApprovalsService)
    private readonly approvals: Pick<ApprovalsService, "cancelPendingFor">,
    @Inject(QuestionsService)
    private readonly questions: Pick<QuestionsService, "cancelPendingFor">,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /** The safety-net sweep every 10 minutes (once per tick across replicas). */
  @LockedCron("*/10 * * * *", { name: OFFBOARD_SWEEP_JOB })
  async sweepJob(): Promise<void> {
    await this.sweep();
  }

  /**
   * In the caller's transaction (`mandatory`: the caller holds the org row lock, order org row →
   * membership, and did the "last owner" checks)：
   * 1. 删除成员关系（非成员 → `member.not_found`；删后组织没有 owner → `org.last_owner`），清空指向该组织的会话当前组织；
   * 2. 吊销该账号**全部**会话与个人令牌（令牌与会话是账号级的，无法只吊销「该组织下」的，按保守处理）；
   * 3. 删除其在该组织所有连接器上的个人凭据；
   * 4. 取消其作为处理人的 pending 审批与提问（写 cancelled 事件），记下此人在该组织进行中的运行（提交后中止）；
   * 5. 其负责的该组织 agent 转给组织所有者（最早加入的 owner）并置 `needs_reassignment = true`；
   * 6. 归档其在该组织各渠道连接上的 IM 话题行（重新加入后在 IM 里开始新的对话，不接着旧会话），
   *    删除其在该组织的「以后都允许」工具授权（`tool_grants`）；
   * 7. 手动移出或本人离开（不是同步判定离职）时写通讯录排除（Ruling A20 / A24）：对该组织启用的每个通讯录插件，
   *    以及成员关系自身的 `directory:<插件>` 来源，不论此人当初是不是由通讯录加入（手动重新加入后再被移出也不会被同步加回）；
   *    同步不再把此人加回，直到有人手动重新加入（{@link MembersService.add} 删除排除）；
   * 8. 审计 `org.member.offboarded`；
   * 9. 记下此人在该组织对话里还没销毁的沙箱（提交后销毁，尽力而为）。
   */
  @Transactional({ propagation: "mandatory" })
  async offboard(
    orgId: string,
    accountId: string,
    reason: OffboardReason,
    actor: { actorAccountId?: string; actorTokenId?: string } = {},
  ): Promise<OffboardResult> {
    const deleted = await this.db
      .deleteFrom("memberships")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .returning(["role", "source"])
      .executeTakeFirst();
    if (!deleted) throw new ApiError("member.not_found", "Member not found");
    // lock the member's agents in id order, right after the membership and before anything that
    // appends to a conversation (approvals, questions lock conversation rows): a dispatch takes
    // FOR SHARE on two agent rows in id order and then appends to the parent conversation, so
    // offboarding goes agents -> conversations the same way (batch 10 m4, batch 11 m1); an UPDATE
    // alone would lock in scan order. These rows (and the conversations below) are updated, never
    // deleted or re-keyed, so NO KEY UPDATE: it still excludes FOR SHARE and other writers, but not
    // the foreign key checks (FOR KEY SHARE) of a transaction that writes rows referencing them,
    // which may already hold a conversation row this transaction waits for (40P01)
    await this.db
      .selectFrom("agents")
      .select("id")
      .where("org_id", "=", orgId)
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    // then the member's conversations in id order, before any of their queue rows (final review
    // m2): queue dispatch, send-now and remove lock a conversation, then its queue rows; deleting
    // the rows first and updating the conversations after could deadlock with them (40P01)
    await this.db
      .selectFrom("conversations")
      .select("id")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .orderBy("id")
      .forNoKeyUpdate()
      .execute();
    const owner = await this.db
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
    await this.db
      .updateTable("sessions")
      .set({ current_org_id: null })
      .where("account_id", "=", accountId)
      .where("current_org_id", "=", orgId)
      .execute();

    const sessions = await this.db
      .updateTable("sessions")
      .set({ revoked_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();
    const tokens = await this.db
      .updateTable("api_tokens")
      .set({ revoked_at: sql<Date>`now()` })
      .where("kind", "=", "personal")
      .where("account_id", "=", accountId)
      .where("revoked_at", "is", null)
      .returning("id")
      .execute();

    // in this transaction (the approvals and questions services join it: `mandatory`)
    const credentials = await this.credentials.clearAccount(orgId, accountId);
    const approvals = await this.approvals.cancelPendingFor(orgId, accountId);
    const questions = await this.questions.cancelPendingFor(orgId, accountId);
    const notify = new Map(approvals.seqs);
    for (const [c, seq] of questions.seqs) notify.set(c, Math.max(notify.get(c) ?? 0, seq));

    const runs = await this.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id", "runs.status"])
      .where("conversations.org_id", "=", orgId)
      // 评测回放的隐藏对话由评测 worker 驱动（不执行工具），随评测运行停下，不在这里中止。
      // 评测运行的创建者离开组织也不取消评测运行（Ruling S1-b）：管理员发起的评测运行是组织的工作，
      // 只有取消、删除评测集、删除组织或 agent 才会停下（见 evals/budget.ts cancelEvalRuns）
      // a removed member's sub-agents run with their identity and credentials: stopped too
      .where("conversations.kind", "in", ["chat", "subagent"])
      .where("runs.status", "in", ACTIVE)
      .where((eb) =>
        eb.or([
          eb("runs.trigger_account_id", "=", accountId),
          eb("conversations.account_id", "=", accountId),
        ]),
      )
      .execute();

    const agents = await this.db
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

    const threads = await this.db
      .updateTable("channel_threads")
      .set({ archived_at: sql<Date>`now()` })
      .where("account_id", "=", accountId)
      .where("archived_at", "is", null)
      .where("connection_id", "in", (eb) =>
        eb.selectFrom("channel_connections").select("id").where("org_id", "=", orgId),
      )
      .executeTakeFirst();
    const grants = await this.db
      .deleteFrom("tool_grants")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .executeTakeFirst();

    const excluded =
      reason === "directory" ? [] : await this.exclusionPlugins(orgId, deleted.source);
    if (excluded.length > 0) {
      await this.db
        .insertInto("directory_exclusions")
        .values(
          excluded.map((plugin) => ({
            org_id: orgId,
            account_id: accountId,
            plugin,
            created_by: actor.actorAccountId ?? null,
          })),
        )
        .onConflict((oc) => oc.columns(["org_id", "account_id", "plugin"]).doNothing())
        .execute();
    }

    // Queued messages never go out after their author leaves (they also hold `@` resource bodies
    // read with the person's credentials): deleted here, so no dispatch can pick them up.
    const queued = await this.db
      .deleteFrom("conversation_queue")
      .where("conversation_id", "in", (eb) =>
        eb
          .selectFrom("conversations")
          .select("id")
          .where("org_id", "=", orgId)
          .where("account_id", "=", accountId),
      )
      .returning("conversation_id")
      .execute();
    const queueConversations = [...new Set(queued.map((r) => r.conversation_id))];
    if (queueConversations.length > 0) {
      await this.db
        .updateTable("conversations")
        .set({ queue_paused: false, queue_pause_reason: null })
        .where("id", "in", queueConversations)
        .execute();
    }

    const sandboxes = await this.db
      .selectFrom("sandboxes")
      .innerJoin("conversations", "conversations.id", "sandboxes.conversation_id")
      .select("sandboxes.conversation_id")
      .where("conversations.org_id", "=", orgId)
      .where("conversations.account_id", "=", accountId)
      .where("sandboxes.status", "<>", "destroyed")
      .execute();

    await audit(this.db.db, {
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
        channelThreadsArchived: Number(threads.numUpdatedRows),
        toolGrantsDeleted: Number(grants.numDeletedRows),
        ...(excluded.length > 0 && { directoryExcluded: excluded }),
        ...(sandboxes.length > 0 && { sandboxesToDestroy: sandboxes.length }),
        ...(queued.length > 0 && { queuedMessagesDeleted: queued.length }),
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
      sandboxConversations: sandboxes.map((r) => r.conversation_id),
      queueConversations,
    };
  }

  /** 要写排除的通讯录插件：该组织启用的已加载通讯录插件 ∪ 成员关系自身的 `directory:<插件>` 来源，去重排序。 */
  private async exclusionPlugins(orgId: string, source: string | null): Promise<string[]> {
    const out = new Set<string>();
    if (source?.startsWith(DIRECTORY_SOURCE_PREFIX)) {
      out.add(source.slice(DIRECTORY_SOURCE_PREFIX.length));
    }
    // Ruling A24: every loaded directory extension enabled in the org
    const loaded = this.registry
      .list("directory")
      .filter((e) => e.capability === DIRECTORY_EXTENSION_POINT)
      .map((e) => e.plugin);
    if (loaded.length > 0) {
      const rows = await this.db
        .selectFrom(enabledExtensionsQuery(this.db.db, orgId).as("en"))
        .select("en.plugin")
        .where("en.plugin", "in", loaded)
        .execute();
      for (const r of rows) out.add(r.plugin);
    }
    return [...out].sort();
  }

  /**
   * After the commit (callers register it with the infra `afterCommit` inside their transaction):
   * writes the session revocation markers, publishes the cancelled events, stops the person's
   * runs in the org and schedules destroying their conversations' sandboxes. A failing step only
   * logs a warning.
   */
  async afterOffboard(r: OffboardResult): Promise<void> {
    const { sessions, log, eventLog } = this;
    try {
      await sessions.markRevoked(r.revokedSessionIds);
    } catch (err) {
      log.warn("offboarding: cannot write session revocation markers", { err });
    }
    for (const [conversationId, seq] of r.notify) {
      try {
        await eventLog.notify(conversationId, seq);
      } catch (err) {
        log.warn("offboarding: event notify failed", { conversationId, err });
      }
    }
    for (const conversationId of r.queueConversations) {
      try {
        await eventLog.publishChanged(conversationId, "queue");
      } catch (err) {
        log.warn("offboarding: queue change notify failed", { conversationId, err });
      }
    }
    for (const run of r.runs) await this.stopRun(run);
    if (r.sandboxConversations.length > 0) {
      try {
        await this.ports.sandboxDestroy.destroy(r.sandboxConversations);
      } catch (err) {
        log.warn("offboarding: cannot schedule sandbox destruction", {
          count: r.sandboxConversations.length,
          err,
        });
      }
    }
  }

  /**
   * 中止一个运行，顺序同会话中止接口：waiting → 直接取消等待并写终态；孤儿 → 直接写终态；
   * 否则经 Redis 广播中止（运行所在副本收到后结束；尚未开始的运行开始时补查中止标记）。失败只记 warn。
   * 不像会话中止那样随后起新一轮运行：离职者的待处理消息不再处理。
   */
  private async stopRun(run: InFlightRun): Promise<void> {
    const ctl = this.runs;
    try {
      if (
        run.status === "waiting" &&
        (await ctl.abortWaiting(run.conversationId, run.runId, null))
      ) {
        return;
      }
      if (await ctl.abortIfOrphaned(run.conversationId, run.runId, null)) return;
      await ctl.requestAbort(run.runId, null);
      // 广播中止的运行要等所在副本到达步骤边界才真正结束：广播成功后记标记，扫描在其有效期内不再重复广播
      // （广播失败不记，下一轮扫描重试）
      await this.redis
        .set(offboardAbortKey(run.runId), "1", "EX", OFFBOARD_ABORT_MARK_TTL_SECONDS)
        .catch((err: unknown) => this.log.warn("offboarding: cannot mark abort", { err }));
    } catch (err) {
      this.log.warn("offboarding: cannot stop run", { runId: run.runId, err });
    }
  }

  /**
   * 兜底扫描（维护队列每 10 分钟）：进行中、且发起人已不是该会话所属组织成员的运行 → 中止
   * （提交后的中止没做成时，如进程崩溃）。按 `(runs.created_at, runs.id)` 键集分页翻完（每页 500 条，
   * 至多 20 页）：经广播中止、尚未真正结束的运行仍是进行中，若只取前 500 条，超过 500 条卡住的运行会
   * 一直占满这一页，后面的永远轮不到。已广播中止、仍带 `capk:offboard-abort:<runId>` 标记（30 分钟）的运行跳过，
   * 不每轮重复广播；标记过期仍未结束的再处理一次。返回本次处理（未跳过）的运行数。
   * 现任成员（含匿名访客这样的 guest 成员）发起的运行不受影响。
   */
  async sweep(batch = OFFBOARD_SWEEP_BATCH): Promise<number> {
    const db = this.db;
    // 游标的时间用文本保存完整的微秒精度（JS Date 只有毫秒，会让同一行再被取到）
    let after: { createdAt: string; id: string } | undefined;
    let total = 0;
    for (let page = 0; page < OFFBOARD_SWEEP_MAX_PAGES; page++) {
      const cursor = after;
      const rows = await db
        .selectFrom("runs")
        .innerJoin("conversations", "conversations.id", "runs.conversation_id")
        .select(["runs.id", "runs.conversation_id", "runs.status"])
        .select(sql<string>`runs.created_at::text`.as("created_at_text"))
        .where("runs.status", "in", ACTIVE)
        // a removed member's sub-agents run with their identity and credentials: stopped too
        .where("conversations.kind", "in", ["chat", "subagent"])
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
        .$if(cursor !== undefined, (q) =>
          q.where(
            sql<boolean>`(runs.created_at, runs.id) > (${cursor?.createdAt}::timestamptz, ${cursor?.id})`,
          ),
        )
        .orderBy("runs.created_at")
        .orderBy("runs.id")
        .limit(batch)
        .execute();
      for (const r of rows) {
        if (await this.recentlyAborted(r.id)) continue;
        total++;
        this.log.warn("offboard sweep: stopping run of a former member", { runId: r.id });
        await this.stopRun({
          conversationId: r.conversation_id,
          runId: r.id,
          status: r.status as InFlightRun["status"],
        });
      }
      const last = rows[rows.length - 1];
      if (rows.length < batch || !last) break;
      after = { createdAt: last.created_at_text, id: last.id };
    }
    return total;
  }

  private async recentlyAborted(runId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(offboardAbortKey(runId))) === 1;
    } catch {
      return false;
    }
  }
}
