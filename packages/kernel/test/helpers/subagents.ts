import type { Queue } from "bullmq";
import { sql } from "kysely";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { type FinishRunArgs, RunFinish } from "../../src/runtime/run-finish.js";
import { handlesFor } from "./identity.js";
import { waitFor } from "./runs.js";

/**
 * Writes a run's terminal state over a test's pool (`RunFinish.finish`, its own transaction, then
 * the notify): `eventLog` must be built over the same pool (`eventLogFor`).
 */
export function finishRun(
  db: KernelSchemaDb,
  eventLog: EventLog,
  a: FinishRunArgs,
): Promise<number | null> {
  const h = handlesFor(db as never);
  return new RunFinish(h.db, eventLog, h.txHost).finish(a);
}

/** A dispatched child run of a parent conversation, oldest first. */
export interface ChildRun {
  conversationId: string;
  runId: string;
  parentRunId: string;
  status: string;
}

export async function childRunsOf(db: KernelSchemaDb, parentConv: string): Promise<ChildRun[]> {
  const rows = await db
    .selectFrom("subagent_dispatches as sd")
    .innerJoin("runs as r", "r.id", "sd.child_run_id")
    .select([
      "sd.child_conversation_id as conversationId",
      "sd.child_run_id as runId",
      "sd.parent_run_id as parentRunId",
      "r.status",
    ])
    .where("sd.parent_conversation_id", "=", parentConv)
    .orderBy("sd.created_at")
    .orderBy("sd.parent_call_id")
    .execute();
  return rows;
}

/** The status of a run. */
export async function runStatus(db: KernelSchemaDb, runId: string): Promise<string | undefined> {
  return (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirst())
    ?.status;
}

/** Waits until the parent conversation's only run is `waiting` and `n` children are dispatched. */
export async function parentWaiting(
  db: KernelSchemaDb,
  parentConv: string,
  n: number,
  timeoutMs = 20_000,
): Promise<{ runId: string; children: ChildRun[] }> {
  return waitFor(
    async () => {
      const run = await db
        .selectFrom("runs")
        .select(["id", "status"])
        .where("conversation_id", "=", parentConv)
        .executeTakeFirst();
      if (run?.status !== "waiting") return null;
      const children = await childRunsOf(db, parentConv);
      return children.length >= n ? { runId: run.id, children } : null;
    },
    timeoutMs,
    `parent waiting on ${n} sub-agent(s)`,
  );
}

/**
 * Removes the queued jobs of these child conversations (a paused sub-agent queue keeps them):
 * simulates an enqueue lost after the dispatch commit.
 */
export async function dropChildJobs(queue: Queue, childConvs: string[]): Promise<number> {
  const jobs = await queue.getJobs(["wait", "prioritized", "delayed"]);
  let n = 0;
  for (const j of jobs) {
    if (j && childConvs.includes((j.data as { conversationId: string }).conversationId)) {
      await j.remove();
      n++;
    }
  }
  return n;
}

/** Moves a run's queued / created time back past the sweeps' grace periods. */
export async function backdateRun(db: KernelSchemaDb, runId: string): Promise<void> {
  await db
    .updateTable("runs")
    .set({
      created_at: sql`now() - interval '5 minutes'`,
      queued_at: sql`CASE WHEN queued_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END`,
      waiting_since: sql`CASE WHEN waiting_since IS NULL THEN NULL ELSE now() - interval '5 minutes' END`,
      finished_at: sql`CASE WHEN finished_at IS NULL THEN NULL ELSE now() - interval '5 minutes' END`,
    })
    .where("id", "=", runId)
    .execute();
}

/**
 * Finishes a child run by hand (its reply, then `run_finished`), as a worker would, but without
 * reporting to the parent: the finisher "crashed" before `onChildFinished`.
 */
export async function finishChildByHand(
  db: KernelSchemaDb,
  eventLog: EventLog,
  child: { conversationId: string; runId: string },
  text: string,
): Promise<void> {
  await eventLog.append(child.conversationId, [
    {
      type: "assistant_message",
      runId: child.runId,
      idemKey: `assistant:${child.runId}:by-hand`,
      payload: { step: 1, content: [{ type: "text", text }], stopReason: "end_turn" },
    },
  ]);
  await finishRun(db, eventLog, {
    conversationId: child.conversationId,
    runId: child.runId,
    status: "completed",
    consumed: null,
    event: { type: "run_finished", payload: { reason: "completed", consumedUpToSeq: 0 } },
  });
}
