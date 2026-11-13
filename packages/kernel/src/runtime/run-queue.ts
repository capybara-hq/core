import { randomUUID } from "node:crypto";
import type { Logger } from "@capybara-hq/plugin-sdk";
import { getQueueToken } from "@nestjs/bullmq";
import { Inject, Injectable, Optional } from "@nestjs/common";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { visibleTo } from "../agents/agent-lookup.js";
import {
  BG_WAKE_JOB,
  type BgWakeJobData,
  bgWakeJobId,
  wakeDecisionIn,
} from "../background/wake-rules.js";
import { EventLog } from "../conversations/event-log.js";
import { dispatchQueuedIn, pauseQueueWith } from "../conversations/queue.js";
import { conversationTree } from "../conversations/tree.js";
import type { ConversationKind, KernelSchemaDb } from "../db/kernel-schema.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import { linkStartedRunIn } from "../schedules/run-tracker.js";
import { scheduledTaskRunAt } from "../schedules/unattended.js";
import type { RunAbortDetail } from "./abort.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { ConversationLock } from "./conversation-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { notifyFinished, RunFinish } from "./run-finish.js";
import { ACTIVE_RUN_STATUSES, RunJobs, runJobId, runQueueNameFor } from "./run-jobs.js";
import { rootConversationOf } from "./subagents/child.js";
import { budgetWindowOf } from "./subagents/limits.js";

export {
  ACTIVE_RUN_STATUSES,
  ENSURE_RUN_BACKSTOP_MS,
  ENSURE_RUN_JOB,
  type EnsureRunJobData,
  ensureRunJobId,
  RUN_QUEUE_NAME,
  type RunJobData,
  runJobId,
  runQueueNameFor,
  SUBAGENT_RUN_QUEUE_NAME,
} from "./run-jobs.js";

/**
 * Test seam (`KernelOverride`): returns true to make {@link RunQueue.ensureRun} throw before it
 * does anything (Redis unreachable, or a direct call after a commit that never happened). The
 * kernel never provides it.
 */
export const ENSURE_RUN_FAILS = Symbol("ENSURE_RUN_FAILS");

/** What {@link RunQueue.ensureRun}'s transaction decided, for the steps after its commit. */
interface EnsureState {
  dispatchedSeq: number | null;
  dispatchedSwitch: boolean;
  dispatchedUnarchived: boolean;
  /** The queue paused in this transaction: the open pages hear it after the commit. */
  pausedNow: boolean;
  /** A finish would wake the conversation once its wake window ends (background Bash §3). */
  wakeLater: { windowEnd: number; delayMs: number } | null;
}

/**
 * Margin added to the delayed wake job: its window is read on the database's clock, the delay runs
 * on this process's and Redis's, so the job does not usually fire just before the window ends (one
 * that does reschedules itself under its next retry id, `bgWakeJobId`).
 */
const WAKE_JOB_MARGIN_MS = 1000;

/** The fields of a conversation's active run that the orphan abort reads. */
interface ActiveRunRow {
  id: string;
  status: string;
  trigger_seq: string;
  /** A resume's job id; null: the trigger's (`runJobId`). */
  job_id: string | null;
}

/**
 * 运行队列（生产方）：`ensureRun` 在会话有未消费的用户消息、且没有进行中的运行时插入 `runs` 行并投递任务。
 * 「是否已有运行」以 PG 为准（会话行锁内检查 `runs` 中的 queued / running），并参考会话锁的持有者；
 * 多副本并发调用对同一会话串行化，同一时刻至多一个未结束的运行。
 */
@Injectable()
export class RunQueue {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(ConversationLock) private readonly lock: Pick<ConversationLock, "holder">,
    @Inject(RunJobs) private readonly jobs: RunJobs,
    @Inject(RunFinish) private readonly finisher: Pick<RunFinish, "finishIn">,
    /** An orphan aborted directly loses its checkpoint thread (thread_id = runId). */
    @Inject(KyselyCheckpointSaver)
    private readonly checkpoints: Pick<KyselyCheckpointSaver, "deleteThread">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<Logger, "error" | "warn">,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(KernelConfigService) private readonly config: KernelConfigService,
    /** The producer side of the delayed `bg-wake` job (`MaintenanceProcessor` consumes it). */
    @Inject(getQueueToken(MAINTENANCE_QUEUE_NAME))
    private readonly maintenance: Pick<Queue, "add">,
    @Optional()
    @Inject(ENSURE_RUN_FAILS)
    private readonly ensureFails: () => boolean = () => false,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * 有未消费的用户消息（最新 user_message 的 seq > `consumed_seq`）、会话锁无人持有、
   * 且没有 queued / running / waiting 的运行时：插入 `runs`（queued），返回 runId；否则返回 null。
   * The run's job is owed in the same transaction (transactional outbox spec §6): the outbox
   * delivers it after the commit, so a queued run never lacks its job.
   *
   * The boundary (`trigger_seq`) is that newest message; with none unconsumed, the queue's head
   * once it is sent; with no head either, a wake-eligible finished background task or sub-agent
   * delivery (background Bash spec §3, agent map spec §5.3, {@link wakeDecisionIn}): the run is
   * then attributed to the event's trigger account and joins the tree's budget window, and an
   * event inside the wake window schedules the delayed `bg-wake` job instead. A sub-agent's
   * conversation is only woken this way ({@link childWakeIn}).
   *
   * An active run (queued, running or waiting) is left alone: a run nobody runs any more is the
   * `run-orphan-check`'s to repair (transactional outbox spec §6), never this call's, and reads
   * never call it.
   *
   * A conversation whose agent is soft-deleted starts no run.
   */
  async ensureRun(
    conversationId: string,
    /** From the `bg-wake` job: it fired `wakeRetry - 1` times before its window ended. */
    opts: { wakeRetry?: number } = {},
  ): Promise<string | null> {
    if (this.ensureFails()) throw new Error("ensureRun failure (test seam)");
    if ((await this.lock.holder(conversationId)) !== null) return null;
    const st: EnsureState = {
      dispatchedSeq: null,
      dispatchedSwitch: false,
      dispatchedUnarchived: false,
      pausedNow: false,
      wakeLater: null,
    };
    const created = await this.ensureRunIn(conversationId, st);
    if (st.wakeLater !== null) {
      await this.scheduleWake(conversationId, st.wakeLater, opts.wakeRetry ?? 0);
    }
    const { dispatchedSeq, dispatchedSwitch, dispatchedUnarchived, pausedNow } = st;
    // a pause is published too (batch 5 review I1): the page shows the reason without a reload
    if (pausedNow) await this.eventLog.publishChanged(conversationId, "queue");
    if (dispatchedSeq !== null) {
      await this.eventLog.notify(conversationId, dispatchedSeq);
      await this.eventLog.publishChanged(conversationId, "queue");
      if (dispatchedSwitch) await this.eventLog.publishChanged(conversationId, "selection");
      if (dispatchedUnarchived) await this.eventLog.publishChanged(conversationId, "archived");
    }
    return created;
  }

  /** {@link ensureRun}'s transaction: what it decided goes back through `st`. */
  @Transactional({ propagation: "requires_new" })
  private async ensureRunIn(conversationId: string, st: EnsureState): Promise<string | null> {
    const t = this.db;
    const conv = await t
      .selectFrom("conversations")
      .select([
        "consumed_seq",
        "org_id",
        "agent_id",
        "kind",
        "queue_paused",
        "account_id",
        "deleted_at",
        "tree_stopped_at",
      ])
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    // 评测回放的隐藏对话：运行由评测 worker 在里面直接驱动（工具只回放记录），绝不为它起真实运行
    if (conv?.kind !== "chat" && conv?.kind !== "subagent") return null;
    // A deleted conversation starts no run, whatever is still unconsumed or queued
    if (conv.deleted_at !== null) return null;
    if (conv.kind === "subagent") return this.childWakeIn(conversationId, conv, st);
    const newest = await t
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "user_message")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    /** The boundary is a wake event: the run joins the tree's budget window (agent map §6). */
    let isWake = false;
    /** The run's boundary: its `trigger_seq` and the account it runs as. */
    let last: { seq: string; accountId: string } | undefined = newest && {
      seq: newest.seq,
      accountId: (newest.payload as { authorAccountId: string }).authorAccountId,
    };
    // an active run (one waiting for approval or an answer too) takes what arrives at its next
    // step or is followed by the next run after its end
    if (await this.activeRun(t, conversationId)) return null;
    if (!last || Number(last.seq) <= Number(conv.consumed_seq)) {
      // Nothing unconsumed: the queue's head goes out when the queue is not paused. Interjections
      // are always unconsumed messages, so the queue never jumps ahead of them.
      if (conv.queue_paused) return null;
      const owner = await t
        .selectFrom("agents")
        .select("deleted_at")
        .where("id", "=", conv.agent_id)
        .executeTakeFirstOrThrow();
      if (owner.deleted_at !== null) return null;
      const head = await t
        .selectFrom("conversation_queue")
        .select("id")
        .where("conversation_id", "=", conversationId)
        .limit(1)
        .executeTakeFirst();
      if (head) {
        // A queued message may wait for hours: it goes out only while its author can still use
        // the conversation (active, a member, the agent visible to them; the isAccessible rule).
        // Otherwise the queue pauses instead of posting as someone who lost access.
        if (!(await authorCanSend(t, conversationId, conv.account_id))) {
          await pauseQueueWith(t, conversationId, "author_cannot_send");
          st.pausedNow = true;
          this.log.warn("queued message not sent: its author can no longer use the conversation", {
            conversationId,
          });
          return null;
        }
        const sent = await dispatchQueuedIn(t, this.eventLog, conversationId);
        if (!sent) return null;
        if ("paused" in sent) {
          st.pausedNow = true;
          this.log.warn("queued skill invocation not sent: the skill can no longer be invoked", {
            conversationId,
          });
          return null;
        }
        st.dispatchedSeq = sent.event.seq;
        st.dispatchedSwitch = sent.switched;
        st.dispatchedUnarchived = sent.unarchived;
        last = {
          seq: String(sent.event.seq),
          accountId: (sent.event.payload as { authorAccountId: string }).authorAccountId,
        };
      } else {
        // Nothing queued either: a finished background task may wake the idle conversation
        // (background Bash spec §3; a person's message or the queue always goes first)
        const wake = await wakeDecisionIn(
          t,
          { id: conversationId, orgId: conv.org_id, rootId: conversationId },
          Number(conv.consumed_seq),
          this.config.get().runtime.wakeOnBackgroundTask,
          (accountId) => authorCanSend(t, conversationId, accountId),
        );
        if (wake?.kind === "later") st.wakeLater = wake;
        if (wake?.kind !== "wake") return null;
        last = { seq: String(wake.seq), accountId: wake.triggerAccountId };
        isWake = true;
      }
    }
    // phase D run boundary: the first unconsumed fork invocation is the trigger of the run that
    // absorbs it (`forkBoundary`); later messages wait for the next run
    const fork = await t
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "user_message")
      .where("seq", ">", conv.consumed_seq)
      .where(sql<boolean>`payload -> 'skill' ->> 'mode' = 'fork'`)
      .orderBy("seq")
      .limit(1)
      .executeTakeFirst();
    const trigger = fork
      ? { seq: fork.seq, accountId: (fork.payload as { authorAccountId: string }).authorAccountId }
      : last;
    const jobId = await this.jobIdFor(conversationId, Number(trigger.seq));
    const agent = await t
      .selectFrom("agents")
      .select(["current_version", "deleted_at"])
      .where("id", "=", conv.agent_id)
      .executeTakeFirstOrThrow();
    // agent 已软删除：会话对任何人都不可见，不再为它起运行。
    if (agent.deleted_at !== null) return null;
    const runId = randomUUID();
    if (!(await this.oweJob(conversationId, runId, jobId.id, "chat", conv.org_id))) return null;
    // scheduled tasks spec §4: a task's message makes the run unattended; a wake inherits it
    // from the run that produced its event; a person's message never does
    const taskRunId = await scheduledTaskRunAt(t, conversationId, trigger.seq);
    await t
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conversationId,
        status: "queued",
        agent_version: agent.current_version,
        trigger_account_id: trigger.accountId,
        trigger_seq: Number(trigger.seq),
        job_id: jobId.recorded,
        // a chat conversation always has its person-triggered run before any wake (a wake event
        // comes from a run of it or of its tree); null would only make the wake run its own window
        budget_run_id: isWake ? await budgetWindowOf(t, conversationId) : null,
        scheduled_task_run_id: taskRunId,
      })
      .execute();
    // the task run its message started follows this run from now on (spec §6)
    if (taskRunId !== null) await linkStartedRunIn(t, taskRunId, runId, conversationId);
    // the root runs again: a person's stop of its tree no longer holds the tree's wakes
    // (agent map spec §6); read with the row lock above, so the hot path issues no statement
    if (conv.tree_stopped_at !== null) {
      await t
        .updateTable("conversations")
        .set({ tree_stopped_at: null })
        .where("id", "=", conversationId)
        .execute();
    }
    return runId;
  }

  /**
   * The job id of a new run for `seq` (in {@link ensureRunIn}'s transaction, read from PG only):
   * the trigger's `runJobId` for its first run; a later run of the same trigger (a run that hit its
   * deadline leaves the messages it did not absorb unconsumed, R34) gets `<runJobId>-<n>`,
   * recorded in `runs.job_id`, so its job is never taken for the earlier run's (BullMQ ignores an
   * add under the id of a job it still holds).
   */
  private async jobIdFor(
    conversationId: string,
    seq: number,
  ): Promise<{ id: string; recorded: string | null }> {
    const prior = await this.db
      .selectFrom("runs")
      .select(sql<string>`count(*)`.as("n"))
      .where("conversation_id", "=", conversationId)
      .where("trigger_seq", "=", String(seq))
      .executeTakeFirst();
    const n = Number(prior?.n ?? 0);
    if (n === 0) return { id: runJobId(conversationId, seq), recorded: null };
    const id = `${runJobId(conversationId, seq)}-${n + 1}`;
    return { id, recorded: id };
  }

  /**
   * Owes the new run's job in {@link ensureRunIn}'s transaction, before its run row is written.
   * False (logged): the same job id is still owed, so the caller writes no run (a second run of
   * one trigger; the conversation's unique active run makes this a should-not-happen).
   */
  private async oweJob(
    conversationId: string,
    runId: string,
    jobId: string,
    kind: ConversationKind,
    orgId: string,
  ): Promise<boolean> {
    if (await this.jobs.owe({ runId, conversationId }, jobId, kind, orgId)) return true;
    this.log.warn("run job for this trigger already owed; not starting a run", {
      conversationId,
      jobId,
    });
    return false;
  }

  /**
   * {@link ensureRunIn} for a sub-agent's conversation (agent map spec §5.3), under its row lock.
   * Its runs from a task, or from a message to an idle sub-agent, are started by the dispatch
   * (`Agent`, `SendMessage`), which also records the dispatch. Here it is started from a parent's
   * message that reached its run after that run's last model call (agent map spec §10: a message
   * racing the run's end starts a new run, never lost); and it is woken by its own background
   * task's finish or a delivery from its own sub-agent, under the same rules as a chat
   * conversation. Neither happens once its last run was stopped (`aborted`): a stopped sub-agent is
   * started again only by its parent; nor while a person's stop of the root holds the tree
   * (`conversations.tree_stopped_at`, cleared by the root's next run). Both read the queue and the trigger account's access on the root
   * of its tree; a message needs no wake setting and has no wake window. The run counts against
   * the root's budget window and runs on the sub-agent queue under `runJobId(child, boundary
   * seq)`. An active run is never started past (one nobody runs is the `run-orphan-check`'s).
   */
  private async childWakeIn(
    conversationId: string,
    conv: { consumed_seq: string; org_id: string; agent_id: string },
    st: EnsureState,
  ): Promise<string | null> {
    const t = this.db;
    if (await this.activeRun(t, conversationId)) return null;
    // a stopped sub-agent (its last run `aborted`: a person's or a tree stop) stays stopped: no
    // message, task finish or delivery that reached it before or during the stop wakes it (a
    // descendant's report that landed just before the stop would otherwise restart the stopped
    // branch); they are parked for its next run, which only its parent starts (`Agent`,
    // `SendMessage`)
    const last = await t
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (last?.status === "aborted") return null;
    const rootId = await rootConversationOf(t, conversationId);
    // a tree a person stopped at its root (agent map spec §6, changed in acceptance 2026-11-13)
    // starts no sub-agent run here until the root runs again: an idle sub-agent the stop found
    // with nothing running (or one whose report raced the stop) is not woken by a late finish
    if (await treeStopped(t, rootId)) return null;
    const wake =
      (await this.pendingMessageIn(conversationId, Number(conv.consumed_seq), rootId)) ??
      (await wakeDecisionIn(
        t,
        { id: conversationId, orgId: conv.org_id, rootId },
        Number(conv.consumed_seq),
        this.config.get().runtime.wakeOnBackgroundTask,
        (accountId) => authorCanSend(t, rootId, accountId),
      ));
    if (wake?.kind === "later") st.wakeLater = wake;
    if (wake?.kind !== "wake") return null;
    const jobId = await this.jobIdFor(conversationId, wake.seq);
    const agent = await t
      .selectFrom("agents")
      .select(["current_version", "deleted_at"])
      .where("id", "=", conv.agent_id)
      .executeTakeFirstOrThrow();
    if (agent.deleted_at !== null) return null;
    // a sub-agent runs its definition frozen at dispatch: its runs keep the version recorded then
    const previous = await t
      .selectFrom("runs")
      .select("agent_version")
      .where("conversation_id", "=", conversationId)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    const runId = randomUUID();
    if (!(await this.oweJob(conversationId, runId, jobId.id, "subagent", conv.org_id))) {
      return null;
    }
    await t
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conversationId,
        status: "queued",
        agent_version: previous?.agent_version ?? agent.current_version,
        trigger_account_id: wake.triggerAccountId,
        trigger_seq: wake.seq,
        job_id: jobId.recorded,
        budget_run_id: await budgetWindowOf(t, rootId),
        // a parent's message or a wake: unattended when the run behind it was (scheduled tasks §4)
        scheduled_task_run_id: await scheduledTaskRunAt(t, conversationId, wake.seq),
      })
      .execute();
    return runId;
  }

  /**
   * The newest unconsumed message of an idle sub-agent (a `SendMessage` its last run did not absorb)
   * as a run boundary, or null: none; the root's queue is paused or the root deleted (the
   * message waits for the unpause, {@link wakeHeldTree}); or its author can no longer send to the
   * root (it waits for a later run). The caller already refused a stopped sub-agent (last run
   * `aborted`): a message that reached it while running and then stopped is parked, and the next
   * run its parent starts absorbs it. Called under the sub-agent's row lock.
   */
  private async pendingMessageIn(
    conversationId: string,
    consumed: number,
    rootId: string,
  ): Promise<{ kind: "wake"; seq: number; triggerAccountId: string } | null> {
    const t = this.db;
    const message = await t
      .selectFrom("conversation_events")
      .select(["seq", "payload"])
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "user_message")
      .where("seq", ">", String(consumed))
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!message) return null;
    const root = await t
      .selectFrom("conversations")
      .select(["queue_paused", "deleted_at"])
      .where("id", "=", rootId)
      .executeTakeFirst();
    if (!root || root.queue_paused || root.deleted_at !== null) return null;
    const accountId = (message.payload as { authorAccountId: string }).authorAccountId;
    if (!(await authorCanSend(t, rootId, accountId))) return null;
    return { kind: "wake", seq: Number(message.seq), triggerAccountId: accountId };
  }

  /**
   * Re-derives the wakes a paused root held for its tree (agent map spec §5.3: a paused root queue
   * holds the wakes of the whole tree): after the root's queue is unpaused, {@link ensureRun} on
   * every sub-agent conversation below it that has an unconsumed wake event or message and no
   * active run (the root itself is the caller's own `ensureRun`). Errors are logged; the
   * ensure-run backstop the releasing transaction owed ({@link oweHeldTreeIn}) wakes it later.
   */
  async wakeHeldTree(rootId: string): Promise<void> {
    for (const c of await this.heldTree(rootId)) {
      try {
        await this.ensureRun(c.id);
      } catch (err) {
        this.log.warn("cannot wake a held sub-agent", { conversationId: c.id, err });
      }
    }
  }

  /**
   * Owes, in the caller's transaction (the one that unpauses the root's queue or sends its item
   * now), the ensure-run backstop of every sub-agent {@link wakeHeldTree} would wake after the
   * commit, under the sub-agent's newest seq (transactional outbox spec §6): a process that dies
   * before that call leaves no held wake behind. A root whose queue is still paused (or that is
   * deleted) releases nothing and owes nothing.
   */
  @Transactional({ propagation: "mandatory" })
  async oweHeldTreeIn(rootId: string): Promise<void> {
    const root = await this.db
      .selectFrom("conversations")
      .select(["queue_paused", "deleted_at"])
      .where("id", "=", rootId)
      .executeTakeFirst();
    if (!root || root.queue_paused || root.deleted_at !== null) return;
    for (const c of await this.heldTree(rootId)) {
      await this.jobs.oweEnsureRun(c.id, c.seq, c.org_id);
    }
  }

  /**
   * The sub-agent conversations below `rootId` a paused root holds: not deleted, with an
   * unconsumed wake event (a finished background task, a delivery) or message, and no active run;
   * with their org and newest seq. Reads only (no row locks).
   */
  private async heldTree(rootId: string) {
    const ids = (await conversationTree(this.db, rootId))
      .filter((c) => c.level > 0)
      .map((c) => c.id);
    if (ids.length === 0) return [];
    return this.db
      .selectFrom("conversations as c")
      .select(["c.id", "c.org_id", "c.last_seq as seq"])
      .where("c.id", "in", ids)
      .where("c.deleted_at", "is", null)
      .where(({ exists, selectFrom }) =>
        exists(
          selectFrom("conversation_events as e")
            .select(sql`1`.as("one"))
            .whereRef("e.conversation_id", "=", "c.id")
            .where("e.type", "in", [
              "background_task_finished",
              "subagent_delivery",
              "user_message",
            ])
            .whereRef("e.seq", ">", "c.consumed_seq"),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("runs as r")
              .select(sql`1`.as("one"))
              .whereRef("r.conversation_id", "=", "c.id")
              .where("r.status", "in", ACTIVE_RUN_STATUSES),
          ),
        ),
      )
      .execute();
  }

  /**
   * Schedules the delayed `bg-wake` job at the end of the conversation's wake window (after the
   * commit): one job per conversation and window end, so finishes inside one window share it. It
   * calls {@link ensureRun}, which wakes the conversation if a finish is still unconsumed. A failed
   * enqueue is logged: the next message, run end or page opening re-derives the wake.
   */
  private async scheduleWake(
    conversationId: string,
    w: { windowEnd: number; delayMs: number },
    retry: number,
  ): Promise<void> {
    const data: BgWakeJobData = { conversationId, ...(retry > 0 && { retry }) };
    try {
      await this.maintenance.add(BG_WAKE_JOB, data, {
        // a job that fired early reschedules under a new id (its own is still taken)
        jobId: bgWakeJobId(conversationId, w.windowEnd, retry),
        delay: w.delayMs + WAKE_JOB_MARGIN_MS,
        removeOnComplete: true,
        removeOnFail: true,
      });
    } catch (err) {
      this.log.error("cannot schedule the background task wake", { conversationId, err });
    }
  }

  /**
   * Owes the ensure-run backstop of `conversationId` in the caller's transaction
   * ({@link oweEnsureRun}): `seq` is the event the transaction wrote, `orgId` the conversation's.
   */
  oweEnsureRun(conversationId: string, seq: number | string, orgId: string): Promise<boolean> {
    return this.jobs.oweEnsureRun(conversationId, seq, orgId);
  }

  /**
   * Stops an orphaned run directly (`POST .../abort`, a tree stop): a `running` run whose
   * conversation lock is free and whose BullMQ job is gone hears no stop broadcast, so its
   * `run_aborted` is written here (status aborted, `consumed_seq` at least to its trigger): true. Not
   * an orphan (someone runs it; a queued run's job is owed, or lost and re-added by the
   * `run-orphan-check`, whose worker then sees the stop marker) or already finished: false, and the
   * caller broadcasts the stop.
   */
  async abortIfOrphaned(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
    detail?: RunAbortDetail,
  ): Promise<boolean> {
    if ((await this.lock.holder(conversationId)) !== null) return false;
    const toSeq = await this.abortOrphanIn(conversationId, runId, byAccountId, detail);
    if (toSeq === null) return false;
    await notifyFinished(this.eventLog, conversationId, toSeq, "aborted");
    await this.dropCheckpoints(runId);
    return true;
  }

  @Transactional({ propagation: "requires_new" })
  private async abortOrphanIn(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
    detail: RunAbortDetail | undefined,
  ): Promise<number | null> {
    const t = this.db;
    const conv = await t
      .selectFrom("conversations")
      .select("kind")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    const active = await this.activeRun(t, conversationId);
    if (!conv || !active || active.id !== runId) return null;
    if (!(await this.isOrphan(conversationId, active, conv.kind))) return null;
    this.log.warn("aborting orphaned run directly", { conversationId, runId });
    return this.finisher.finishIn({
      conversationId,
      runId,
      status: "aborted",
      consumed: null,
      event: {
        type: "run_aborted",
        payload: { byAccountId, reason: "user", ...(detail !== undefined && { detail }) },
      },
    });
  }

  /**
   * Ends a `queued` run in PG before any worker started it (an offboarded member's run, ruling
   * R27): with the conversation lock free, under the conversation row lock, a run still `queued`
   * is finished `aborted` with `run_aborted` (`consumed_seq` at least to its trigger), so a job
   * that runs later finds it finished and starts nothing. True when it did; false when a worker
   * holds the conversation or is in the middle of the run's first start (`run_started` written,
   * `started_at` not yet set; it hears the stop), or the run is no longer queued. A run resumed
   * from `waiting` to `queued` is ended like a new one. The caller writes the stop marker first, so a worker that takes the
   * conversation meanwhile still stops; a worker that read the run before this commit re-checks it
   * under the row locks before its `run_started` and never moves it back to `running`.
   */
  async abortQueued(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<boolean> {
    if ((await this.lock.holder(conversationId)) !== null) return false;
    const toSeq = await this.abortQueuedIn(conversationId, runId, byAccountId);
    if (toSeq === null) return false;
    await notifyFinished(this.eventLog, conversationId, toSeq, "aborted");
    await this.dropCheckpoints(runId);
    return true;
  }

  @Transactional({ propagation: "requires_new" })
  private async abortQueuedIn(
    conversationId: string,
    runId: string,
    byAccountId: string | null,
  ): Promise<number | null> {
    const t = this.db;
    const conv = await t
      .selectFrom("conversations")
      .select("id")
      .where("id", "=", conversationId)
      .forUpdate()
      .executeTakeFirst();
    const active = await this.activeRun(t, conversationId);
    if (!conv || !active || active.id !== runId || active.status !== "queued") return null;
    // a worker is in the middle of the run's FIRST start (its `run_started` written, `started_at`
    // not set yet; it holds the conversation since): the stop marker ends it. A run resumed from
    // `waiting` back to `queued` has both from its first start and is ended here like a new one:
    // its worker skips `run_started` (it exists) and its conditional `running` update finds the run
    // finished
    const first = await t
      .selectFrom("runs")
      .select("started_at")
      .where("id", "=", runId)
      .executeTakeFirst();
    if (first?.started_at === null) {
      const started = await t
        .selectFrom("conversation_events")
        .select("seq")
        .where("conversation_id", "=", conversationId)
        .where("idem_key", "=", `run_started:${runId}`)
        .executeTakeFirst();
      if (started) return null;
    }
    return this.finisher.finishIn({
      conversationId,
      runId,
      status: "aborted",
      consumed: null,
      event: { type: "run_aborted", payload: { byAccountId, reason: "user" } },
    });
  }

  /** 会话当前未结束的运行（调用方已持有会话行锁）。 */
  private activeRun(t: KernelSchemaDb, conversationId: string): Promise<ActiveRunRow | undefined> {
    return t
      .selectFrom("runs")
      .select(["id", "status", "trigger_seq", "job_id"])
      .where("conversation_id", "=", conversationId)
      .where("status", "in", ACTIVE_RUN_STATUSES)
      .executeTakeFirst();
  }

  /**
   * Whether an active run is an orphan for {@link abortIfOrphaned} (the caller saw the conversation
   * lock free): a `running` one whose BullMQ job (a resume's under `runs.job_id`) is gone. A
   * `waiting` one never is (no job by design), nor a `queued` one (its job is owed in the
   * transaction that queued it).
   */
  private async isOrphan(
    conversationId: string,
    active: ActiveRunRow,
    kind: ConversationKind,
  ): Promise<boolean> {
    if (active.status !== "running") return false;
    const jobId = active.job_id ?? runJobId(conversationId, Number(active.trigger_seq));
    return (await this.jobs.getJob(jobId, runQueueNameFor(kind))) === undefined;
  }

  /** 删除已结束运行的 checkpoint thread（失败只记日志）。 */
  private async dropCheckpoints(runId: string): Promise<void> {
    await this.checkpoints
      .deleteThread(runId)
      .catch((err) => this.log.warn("checkpoint delete failed", { runId, err }));
  }
}

/** The conversation's owner is active and can still see its agent (`isAccessible`'s rule). */
async function authorCanSend(
  t: KernelSchemaDb,
  conversationId: string,
  accountId: string,
): Promise<boolean> {
  const row = await t
    .selectFrom("conversations")
    .select("conversations.id")
    .where("conversations.id", "=", conversationId)
    .where((eb) =>
      eb.and([
        eb.exists(
          eb
            .selectFrom("accounts")
            .select(sql`1`.as("one"))
            .where("accounts.id", "=", accountId)
            .where("accounts.status", "=", "active"),
        ),
        eb.exists(
          eb
            .selectFrom("agents")
            .select(sql`1`.as("one"))
            .whereRef("agents.id", "=", "conversations.agent_id")
            .where("agents.deleted_at", "is", null)
            .where(visibleTo(accountId)),
        ),
      ]),
    )
    .executeTakeFirst();
  return row !== undefined;
}

/**
 * Whether a person's stop of the root conversation holds its tree (`tree_stopped_at`, agent map
 * spec §6): set by the stop, cleared when the root next starts a run.
 */
async function treeStopped(t: KernelSchemaDb, rootId: string): Promise<boolean> {
  const root = await t
    .selectFrom("conversations")
    .select("tree_stopped_at")
    .where("id", "=", rootId)
    .executeTakeFirst();
  return root?.tree_stopped_at != null;
}
