import { sql, type Transaction } from "kysely";
import type { AppendEvent, EventLog } from "../conversations/event-log.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";

type KernelTrx = Transaction<KernelDatabase>;

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
}

/**
 * 在事务 `t` 内写运行的终态：会话行锁 → 运行仍未结束才写终态事件、推进 `consumed_seq`、更新 `runs.status`。
 * 返回终态事件的 seq；运行已是终态（例如已被其他副本标记失败）→ 返回 null，什么都不写。
 *
 * `consumed_seq = GREATEST(consumed_seq, consumed, runs.trigger_seq)`：不回退，且任何终态都至少消费到
 * 触发该运行的消息——否则结束时的 ensureRun 会对同一条消息无限重试（失败）或卡住会话。
 * 加锁顺序与 `RunQueue.ensureRun` 一致（先会话行、后 runs 行），不会互相死锁。
 * 调用方在提交后对非 null 的返回值调用 `eventLog.notify`。
 */
export async function finishRunIn(
  t: KernelTrx,
  eventLog: EventLog,
  a: FinishRunArgs,
): Promise<number | null> {
  await t
    .selectFrom("conversations")
    .select("id")
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
  const [ev] = await eventLog.append(
    a.conversationId,
    [{ ...a.event, runId: a.runId, idemKey: `${a.event.type}:${a.runId}` }],
    t,
  );
  await t
    .updateTable("conversations")
    .set({
      consumed_seq: sql`GREATEST(consumed_seq, ${a.consumed ?? 0}::bigint, (SELECT r.trigger_seq FROM capybara.runs r WHERE r.id = ${a.runId}))`,
    })
    .where("id", "=", a.conversationId)
    .execute();
  await t
    .updateTable("runs")
    .set({ status: a.status, finished_at: sql`now()` })
    .where("id", "=", a.runId)
    .execute();
  return (ev as ConversationEvent).seq;
}

/** 自开事务写终态并在提交后发布会话通知；返回值同 {@link finishRunIn}。 */
export async function finishRun(
  db: KernelDb,
  eventLog: EventLog,
  a: FinishRunArgs,
): Promise<number | null> {
  const toSeq = await db.transaction().execute((t) => finishRunIn(t, eventLog, a));
  if (toSeq !== null) await eventLog.notify(a.conversationId, toSeq);
  return toSeq;
}
