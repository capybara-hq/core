import { type ContextJob, withJobContext } from "../../log-context.js";
import { asPlatform, withOrgScope, withoutOrgScope } from "../database/org-scope.js";
import { runOutsideTransaction } from "../database/transaction-host.js";

/**
 * The wrapper every queue processor runs its job in: a fresh async context (no transaction of
 * whoever enqueued the job or started the worker is visible), `queue` / `jobId` / `runId` in the
 * log context, and the tracing span when tracing is on (`withJobContext`). The org scope (RLS spec
 * §5.3, §10) is the job's org when its data carries a string `orgId`; else the platform scope when
 * the queue's work is deployment-wide (`opts.platform`, the reason); else none, never inherited
 * from whoever started the worker (a missing org fails closed once RLS is enforced, and the
 * unscoped-query check reports it).
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
export function runJob<T>(
  queue: string,
  job: ContextJob,
  fn: () => Promise<T>,
  opts: { platform?: string } = {},
): Promise<T> {
  const orgId = (job.data as { orgId?: unknown } | null | undefined)?.orgId;
  const run = () => withJobContext(queue, job, fn);
  return runOutsideTransaction(() => {
    if (typeof orgId === "string" && orgId !== "") return withOrgScope(orgId, run);
    if (opts.platform !== undefined) return asPlatform(opts.platform, run);
    return withoutOrgScope(run);
  });
}
