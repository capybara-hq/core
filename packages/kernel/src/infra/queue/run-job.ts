import { type ContextJob, withJobContext } from "../../log-context.js";
import { runOutsideTransaction } from "../database/transaction-host.js";

/**
 * The wrapper every queue processor runs its job in: a fresh async context (no transaction of
 * whoever enqueued the job or started the worker is visible), `queue` / `jobId` / `runId` in the
 * log context, and the tracing span when tracing is on (`withJobContext`).
 *
 * ```ts
 * @Processor("cap-kernel-titles")
 * class TitleProcessor extends WorkerHost {
 *   process(job: Job) {
 *     return runJob("cap-kernel-titles", job, () => this.titles.generate(job.data));
 *   }
 * }
 * ```
 */
export function runJob<T>(queue: string, job: ContextJob, fn: () => Promise<T>): Promise<T> {
  return runOutsideTransaction(() => withJobContext(queue, job, fn));
}
