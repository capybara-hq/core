import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import { pauseQueueIn } from "../conversations/queue.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { ScheduledTaskRunTracker } from "../schedules/run-tracker.js";
import { ACTIVE_RUN_STATUSES, oweEnsureRun } from "./run-jobs.js";
import { pairStoppedForks } from "./subagents/skill-fork.js";
import { oweDeliverToParent, oweStopChildren } from "./subagents/tree-jobs.js";

/** 运行的终态。 */
export type TerminalStatus = "completed" | "failed" | "aborted";

export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TerminalStatus>([
  "completed",
  "failed",
  "aborted",
]);

export interface FinishRunArgs {
  conversationId: string;
  runId: string;
  status: TerminalStatus;
  /** loop 吸收到的位置；null 表示未知（仍至少推进到触发消息）。 */
  consumed: number | null;
  /** 终态事件（run_finished / run_failed / run_aborted），幂等键为 `<type>:<runId>`。 */
  event: Pick<AppendEvent, "type" | "payload">;
  /**
   * consumed_seq 是否至少推进到 `runs.trigger_seq`，默认 true（失败、中止、完成）。
   * 超时（max_duration）传 false：loop 没吸收的消息没有被回复，必须留给下一轮（R34）。
   */
  floorToTrigger?: boolean;
  /**
   * Runs in the transaction once the run is known not to be terminal, before the terminal event
   * (and before the run's open fork invocation gets its report, which {@link RunFinish.finishIn}
   * always writes).
   */
  beforeTerminal?: () => Promise<void>;
}

/**
 * Writes runs' terminal states (one instance; the run worker, the run queue's orphan repairs, the
 * waits and the eval replays finish runs through it).
 */
@Injectable()
export class RunFinish {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(EventLog) private readonly eventLog: EventLog,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    /** A scheduled task's run follows its kernel run's end in the same transaction (spec §6). */
    @Inject(ScheduledTaskRunTracker)
    private readonly taskRuns: Pick<ScheduledTaskRunTracker, "onRunFinished">,
    /** The run's end owes the conversation's ensure-run backstop (transactional outbox spec §6). */
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
  ) {}

  /**
   * 在调用方的事务内写运行的终态：会话行锁 → 运行仍未结束才写终态事件、推进 `consumed_seq`、更新 `runs.status`。
   * It also owes the conversation's ensure-run backstop under the terminal event's seq.
   *
   * Sub-agents (transactional outbox spec §6): before the terminal event the run's open fork
   * invocation gets its report (`pairStoppedForks`; an `Agent` call has its result from its
   * dispatch), so no terminal path leaves an open call. After it, the stops and the delivery the
   * run's end causes are owed here (runtime/subagents/tree-jobs.ts), the caller still doing them
   * right after its commit: `stop-tree` when an active fork child remains or a sub-agent run a
   * person stopped has sub-agents below it, `deliver-to-parent` for a sub-agent's run. The
   * delivery is a job, not written here: this transaction holds the child's conversation and run
   * rows, and the parent's conversation row comes first in the dispatch's lock order (parent
   * conversation, parent run, budget run, child conversation).
   * 返回终态事件的 seq；运行已是终态（例如已被其他副本标记失败）→ 返回 null，什么都不写。
   *
   * `consumed_seq = GREATEST(consumed_seq, consumed, runs.trigger_seq)`：不回退，且失败 / 中止 / 完成都至少
   * 消费到触发该运行的消息——否则结束时的 ensureRun 会对同一条消息无限重试（失败）或卡住会话。
   * 超时（`floorToTrigger: false`）只取 `GREATEST(consumed_seq, consumed)`：没吸收的消息留给下一轮（R34）。
   * 加锁顺序与 `RunQueue.ensureRun` 一致（先会话行、后 runs 行），不会互相死锁。
   * 调用方在提交后对非 null 的返回值调用 {@link notifyFinished}。
   */
  @Transactional({ propagation: "mandatory" })
  async finishIn(a: FinishRunArgs): Promise<number | null> {
    const t = this.kdb.db;
    const conv = await t
      .selectFrom("conversations")
      .select(["kind", "org_id"])
      .where("id", "=", a.conversationId)
      .forUpdate()
      .executeTakeFirst();
    const run = await t
      .selectFrom("runs")
      .select("status")
      .where("id", "=", a.runId)
      .forUpdate()
      .executeTakeFirst();
    if (!run || TERMINAL_STATUSES.has(run.status)) return null;
    await a.beforeTerminal?.();
    await pairStoppedForks(t, this.eventLog, a.runId);
    const [ev] = await this.eventLog.appendIn(a.conversationId, [
      { ...a.event, runId: a.runId, idemKey: `${a.event.type}:${a.runId}` },
    ]);
    await t
      .updateTable("conversations")
      .set({
        consumed_seq:
          a.floorToTrigger === false
            ? sql`GREATEST(consumed_seq, ${a.consumed ?? 0}::bigint)`
            : sql`GREATEST(consumed_seq, ${a.consumed ?? 0}::bigint, (SELECT r.trigger_seq FROM capybara.runs r WHERE r.id = ${a.runId}))`,
      })
      .where("id", "=", a.conversationId)
      .execute();
    await t
      .updateTable("runs")
      .set({ status: a.status, finished_at: sql`now()` })
      .where("id", "=", a.runId)
      .execute();
    await this.taskRuns.onRunFinished(a.runId, a.status, failureMessage(a.event));
    // a failed or stopped run pauses the queued messages until the person resumes (spec §5.7)
    if (a.status !== "completed") await pauseQueueIn(t, a.conversationId);
    const seq = (ev as ConversationEvent).seq;
    // what arrived during the run starts the next one after the commit (the run worker's post-job
    // ensureRun); owed here too, for when that never happens (an eval's hidden conversation never
    // starts runs)
    if (conv && (conv.kind === "chat" || conv.kind === "subagent")) {
      await oweEnsureRun(this.outbox, a.conversationId, seq, conv.org_id);
    }
    if (conv) await this.oweTreeWork(a, conv.kind, conv.org_id);
    return seq;
  }

  /** {@link finishIn}'s owed stops and delivery of a run's sub-agent tree. */
  private async oweTreeWork(a: FinishRunArgs, kind: string, orgId: string): Promise<void> {
    const t = this.kdb.db;
    if (kind === "subagent") await oweDeliverToParent(this.outbox, a.runId, orgId);
    const forkChild = await t
      .selectFrom("subagent_dispatches as sd")
      .innerJoin("runs as cr", "cr.id", "sd.child_run_id")
      .select("sd.child_run_id")
      .where("sd.parent_run_id", "=", a.runId)
      .where("sd.for_skill", "=", true)
      .where("cr.status", "in", ACTIVE_RUN_STATUSES)
      .limit(1)
      .executeTakeFirst();
    const stoppedWithChildren =
      kind === "subagent" &&
      personStopped(a.event) &&
      (await t
        .selectFrom("conversations")
        .select("id")
        .where("parent_conversation_id", "=", a.conversationId)
        .where("kind", "=", "subagent")
        .limit(1)
        .executeTakeFirst()) !== undefined;
    if (forkChild || stoppedWithChildren) await oweStopChildren(this.outbox, a.runId, orgId);
  }

  /** 自开事务写终态并在提交后发布会话通知；返回值同 {@link finishIn}。 */
  async finish(a: FinishRunArgs): Promise<number | null> {
    const toSeq = await this.finishOwn(a);
    if (toSeq !== null) await notifyFinished(this.eventLog, a.conversationId, toSeq, a.status);
    return toSeq;
  }

  @Transactional({ propagation: "requires_new" })
  private finishOwn(a: FinishRunArgs): Promise<number | null> {
    return this.finishIn(a);
  }
}

/**
 * A `run_aborted` a person caused (an account and no `detail`): a sub-agent run stopped that way
 * stops its descendants (`Waits.stopDescendantsOfStopped`, agent map spec §6).
 */
function personStopped(event: FinishRunArgs["event"]): boolean {
  if (event.type !== "run_aborted") return false;
  const p = event.payload as { byAccountId?: unknown; detail?: unknown } | undefined;
  return typeof p?.byAccountId === "string" && p.detail === undefined;
}

/** The message of a `run_failed` event's error, for the task run (undefined otherwise). */
function failureMessage(event: FinishRunArgs["event"]): string | undefined {
  if (event.type !== "run_failed") return undefined;
  const m = (event.payload as { error?: { message?: unknown } } | undefined)?.error?.message;
  return typeof m === "string" ? m : undefined;
}

/**
 * After a terminal event committed: notify the log, and for a failed or stopped run also send
 * `changed: queue` (the queue may have paused).
 */
export async function notifyFinished(
  eventLog: Pick<EventLog, "notify" | "publishChanged">,
  conversationId: string,
  toSeq: number,
  status: TerminalStatus,
): Promise<void> {
  await eventLog.notify(conversationId, toSeq);
  if (status !== "completed") await eventLog.publishChanged(conversationId, "queue");
}
