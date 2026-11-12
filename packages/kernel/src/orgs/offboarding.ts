import { DIRECTORY_EXTENSION_POINT } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { retargetSetupRequests } from "../agents/pending-connector-requests.js";
import { EventLog } from "../conversations/event-log.js";
import { lockConversationTrees } from "../conversations/tree.js";
import { ApiError } from "../errors.js";
import { enabledExtensionsQuery } from "../extensions/enabled.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { SessionService } from "../identity/sessions.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { RunControl } from "../runtime/run-control.js";
import { oweDeviceDestroy } from "../sandbox/jobs.js";
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
  /** The person's active runs in the org (queued / running / waiting): a `run-stop` job each is owed. */
  runs: InFlightRun[];
  /** 负责的 agent 转交给的所有者；没有转交时为 null。 */
  newOwnerId: string | null;
  /** The person's devices in the org, soft-deleted here; a destroy job each is owed. */
  devices: string[];
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
  abortQueued(conversationId: string, runId: string, byAccountId: string | null): Promise<boolean>;
  requestAbort(runId: string, byAccountId: string | null): Promise<void>;
}

/**
 * The stop of a departed member's run (transactional outbox spec §8.1), owed by the offboard
 * transaction on the maintenance queue under {@link runStopJobId}; `MaintenanceProcessor` runs
 * {@link Offboarding.stopRun}.
 */
export const RUN_STOP_JOB = "run-stop";

/** The `run-stop` job's data. */
export interface RunStopJobData {
  conversationId: string;
  runId: string;
}

/** The `run-stop` job id: a run is stopped once (no `:`). */
export const runStopJobId = (runId: string): string => `run-stop-${runId}`;

const ACTIVE = ["queued", "running", "waiting"] as const;
/** 通讯录同步加入的成员关系的 `source` 前缀（`directory:<插件名>`）。 */
const DIRECTORY_SOURCE_PREFIX = "directory:";

/**
 * 成员离职（spec 3.3）：管理员移出、本人离开与通讯录同步共用这一条路径，全部写入在调用方的同一个事务内，
 * 要么都生效要么都不生效。The stops of the person's runs and the destruction of their devices are owed
 * in that transaction (outbox jobs, transactional outbox spec §8.1); the Redis revocation markers
 * and the event publishes after the commit are hints ({@link afterOffboard}: `revoked_at` in PG is
 * the authority).
 *
 * 已接受的窄窗口：离职提交时正在进行的 OAuth token 刷新（`Credentials` 刷新锁内）可能在提交之后把此人的
 * 个人凭据重新写回（upsert）。凭据只在此人以成员身份调用工具时使用，而其运行已被中止、成员关系已删除，
 * 残留的凭据不会被使用；重新加入组织后会被新的连接覆盖。
 */
@Injectable()
export class Offboarding {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(SessionService) private readonly sessions: Pick<SessionService, "markRevoked">,
    @Inject(ExtensionRegistry) private readonly registry: Pick<ExtensionRegistry, "list">,
    @Inject(EventLog) private readonly eventLog: Pick<EventLog, "notify" | "publishChanged">,
    /** Owes the run stops and device destroys in the offboard transaction. */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    /** Stops the departed member's runs (`by: null`, a system action) in the `run-stop` job. */
    @Inject(RunControl) private readonly runs: OffboardingRunControl,
    @Inject(Credentials) private readonly credentials: Pick<Credentials, "clearAccount">,
    @Inject(ApprovalsService)
    private readonly approvals: Pick<
      ApprovalsService,
      "pendingConversationsFor" | "cancelPendingFor"
    >,
    @Inject(QuestionsService)
    private readonly questions: Pick<
      QuestionsService,
      "pendingConversationsFor" | "cancelPendingFor"
    >,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
  ) {}

  /**
   * In the caller's transaction (`mandatory`: the caller holds the org row lock, order org row →
   * membership, and did the "last owner" checks)：
   * 1. 删除成员关系（非成员 → `member.not_found`；删后组织没有 owner → `org.last_owner`），清空指向该组织的会话当前组织；
   * 2. Removal and directory offboarding revoke **every** session and personal token of the
   *    account (both are account-wide, so conservatively all); a person who leaves (`left`) keeps
   *    them, and the session's current org is cleared (the membership check ends the access);
   * 3. 删除其在该组织所有连接器上的个人凭据；
   * 4. 取消其作为处理人的 pending 审批与提问（写 cancelled 事件）; owes a `run-stop` job for each of the
   *    person's active runs in the org;
   * 5. 其负责的该组织 agent 转给组织所有者（最早加入的 owner）并置 `needs_reassignment = true`；
   * 6. 归档其在该组织各渠道连接上的 IM 话题行（重新加入后在 IM 里开始新的对话，不接着旧会话），
   *    删除其在该组织的「以后都允许」工具授权（`tool_grants`）；
   * 7. 手动移出或本人离开（不是同步判定离职）时写通讯录排除（Ruling A20 / A24）：对该组织启用的每个通讯录插件，
   *    以及成员关系自身的 `directory:<插件>` 来源，不论此人当初是不是由通讯录加入（手动重新加入后再被移出也不会被同步加回）；
   *    同步不再把此人加回，直到有人手动重新加入（{@link MembersService.add} 删除排除）；
   * 8. 审计 `org.member.offboarded`；
   * 9. Soft-deletes the person's devices in the org and clears their default row, and owes the
   *    destruction of each (instance and files, `device-destroy-<deviceId>`).
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
    // then, in one pass, the member's conversations and those holding a pending approval or
    // question this offboarding cancels, before any of their queue, approval or question rows
    // (final review m2: queue dispatch, send-now and remove lock a conversation, then its queue
    // rows). Locked tree by tree, root first (`lockConversationTrees`), not in id order: a reply
    // locks its root and then the sub-agents' conversations whose network asks it skips, and a
    // child's id may sort before its root's (40P01)
    const own = await this.db
      .selectFrom("conversations")
      .select("id")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
      .execute();
    const approvalConvs = await this.approvals.pendingConversationsFor(orgId, accountId);
    const questionConvs = await this.questions.pendingConversationsFor(orgId, accountId);
    const locked = await lockConversationTrees(this.db.db, [
      ...own.map((c) => c.id),
      ...approvalConvs,
      ...questionConvs,
    ]);
    const isLocked = new Set(locked);
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

    // A person who leaves keeps their sign-in and personal tokens: the org guard reads the
    // membership on every request, so access to this org ends with the row above, and their other
    // orgs keep working. Removal and directory offboarding revoke both (account-wide, conservative).
    const revoke = reason !== "left";
    const sessions = revoke
      ? await this.db
          .updateTable("sessions")
          .set({ revoked_at: sql<Date>`now()` })
          .where("account_id", "=", accountId)
          .where("revoked_at", "is", null)
          .returning("id")
          .execute()
      : [];
    const tokens = revoke
      ? await this.db
          .updateTable("api_tokens")
          .set({ revoked_at: sql<Date>`now()` })
          .where("kind", "=", "personal")
          .where("account_id", "=", accountId)
          .where("revoked_at", "is", null)
          .returning("id")
          .execute()
      : [];

    // in this transaction (the approvals and questions services join it: `mandatory`)
    const credentials = await this.credentials.clearAccount(orgId, accountId);
    // only in the conversations locked above (one asked meanwhile elsewhere waits for its run's stop)
    const approvals = await this.approvals.cancelPendingFor(
      orgId,
      accountId,
      approvalConvs.filter((c) => isLocked.has(c)),
    );
    const questions = await this.questions.cancelPendingFor(
      orgId,
      accountId,
      questionConvs.filter((c) => isLocked.has(c)),
    );
    const notify = new Map(approvals.seqs);
    for (const [c, seq] of questions.seqs) notify.set(c, Math.max(notify.get(c) ?? 0, seq));

    const runs = await this.db
      .selectFrom("runs")
      .innerJoin("conversations", "conversations.id", "runs.conversation_id")
      .select(["runs.id", "runs.conversation_id", "runs.status"])
      .where("conversations.org_id", "=", orgId)
      // 评测回放的隐藏对话由评测 worker 驱动（不执行工具），随评测运行停下，不在这里中止。
      // 评测运行的创建者离开组织也不取消评测运行（Ruling S1-b）：管理员发起的评测运行是组织的工作，
      // 只有取消、删除评测集、删除组织或 agent 才会停下（见 evals/budget.ts `EvalBudget.cancelRuns`）
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
    // their stops are owed with the offboarding (the job reads the run's state when it runs)
    for (const r of runs) {
      await this.outbox.add<RunStopJobData>({
        queue: MAINTENANCE_QUEUE_NAME,
        name: RUN_STOP_JOB,
        jobId: runStopJobId(r.id),
        data: { conversationId: r.conversation_id, runId: r.id },
        orgId,
      });
    }

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
    // their connector setup requests follow them to the org owner (ruling P4-T6-4)
    await retargetSetupRequests(
      this.db.db,
      agents.map((a) => a.id),
      owner.account_id,
    );

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

    const devices = await this.db
      .updateTable("devices")
      .set({ deleted_at: sql<Date>`now()`, updated_at: sql<Date>`now()` })
      .where("org_id", "=", orgId)
      .where("owner_kind", "=", "personal")
      .where("owner_account_id", "=", accountId)
      .where("deleted_at", "is", null)
      .returning("id")
      .execute();
    for (const d of devices) await oweDeviceDestroy(this.outbox, d.id, orgId);
    await this.db
      .deleteFrom("device_defaults")
      .where("org_id", "=", orgId)
      .where("account_id", "=", accountId)
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
        ...(devices.length > 0 && { devicesDeleted: devices.length }),
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
      devices: devices.map((r) => r.id),
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
   * writes the session revocation markers and publishes the cancelled events and queue changes,
   * all hints (the run stops and device destroys were owed in the transaction). A failing step
   * only logs a warning.
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
  }

  /**
   * The `run-stop` job (`MaintenanceProcessor`): stops a departed member's run the way the
   * conversation's stop does (`POST .../abort`), by no account: a waiting run is aborted directly,
   * a queued run is ended in PG (ruling R27: it never starts later, however long it was held), an
   * orphan is finished directly, a running run is asked to stop through Redis (its replica ends it). A finished run is left alone. No
   * new run follows, as after a person's stop: the departed member's queued messages were deleted.
   * A failure throws (the job is retried).
   */
  async stopRun(data: RunStopJobData): Promise<void> {
    const run = await this.db
      .selectFrom("runs")
      .select("status")
      .where("id", "=", data.runId)
      .executeTakeFirst();
    if (run === undefined || !(ACTIVE as readonly string[]).includes(run.status)) return;
    const ctl = this.runs;
    if (
      run.status === "waiting" &&
      (await ctl.abortWaiting(data.conversationId, data.runId, null))
    ) {
      return;
    }
    if (run.status === "queued") {
      // a queued run may wait for hours: it is ended in PG, never left to the stop marker's TTL
      // (ruling R27); the marker first, so a worker that takes it meanwhile stops too
      await ctl.requestAbort(data.runId, null);
      if (await ctl.abortQueued(data.conversationId, data.runId, null)) return;
      // a worker took it (now running) or it moved on: the marker stops it; re-read and go on
      const now = await this.db
        .selectFrom("runs")
        .select("status")
        .where("id", "=", data.runId)
        .executeTakeFirst();
      if (now?.status === "queued") {
        throw new Error(`run ${data.runId} is still queued; the run-stop job retries`);
      }
      if (now?.status !== "waiting") return;
      await ctl.abortWaiting(data.conversationId, data.runId, null);
      return;
    }
    if (await ctl.abortIfOrphaned(data.conversationId, data.runId, null)) return;
    await ctl.requestAbort(data.runId, null);
  }
}
