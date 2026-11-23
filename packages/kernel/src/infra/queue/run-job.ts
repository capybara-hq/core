import { type ContextJob, withJobContext } from "../../log-context.js";
import { asPlatform, withOrgScope } from "../database/org-scope.js";
import { runOutsideTransaction } from "../database/transaction-host.js";

/**
 * The wrapper every queue processor runs its job in: a fresh async context (no transaction of
 * whoever enqueued the job or started the worker is visible), `queue` / `jobId` / `runId` in the
 * log context, and the tracing span when tracing is on (`withJobContext`). The org scope (RLS spec
 * §5.3) is the job's org when its data carries a string `orgId`, else the platform scope with the
 * queue as the reason (deployment-wide jobs).
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
  const orgId = (job.data as { orgId?: unknown } | null | undefined)?.orgId;
  return runOutsideTransaction(() =>
    typeof orgId === "string" && orgId !== ""
      ? withOrgScope(orgId, () => withJobContext(queue, job, fn))
      : asPlatform(`job of ${queue}`, () => withJobContext(queue, job, fn)),
  );
}
