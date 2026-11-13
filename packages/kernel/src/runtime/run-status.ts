import type { KernelSchemaDb } from "../db/kernel-schema.js";

/** 运行的终态。 */
export type TerminalStatus = "completed" | "failed" | "aborted";

/** The terminal run statuses (a leaf module: the event writers of a run start import it too). */
export const TERMINAL_STATUSES: ReadonlySet<string> = new Set<TerminalStatus>([
  "completed",
  "failed",
  "aborted",
]);

/**
 * Whether run `runId` has ended, read in the caller's transaction with its row locked: call it
 * after the conversation row lock (lock order conversation, then run, as `RunFinish.finishIn`), so
 * no stop can end the run between this read and the transaction's appends. A missing run is not
 * ended (a caller may record for a run id without a row).
 */
export async function runEndedIn(db: KernelSchemaDb, runId: string): Promise<boolean> {
  const row = await db
    .selectFrom("runs")
    .select("status")
    .where("id", "=", runId)
    .forUpdate()
    .executeTakeFirst();
  return row !== undefined && TERMINAL_STATUSES.has(row.status);
}
