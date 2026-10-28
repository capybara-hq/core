// Ported from octok-platform libs/common/src/logging/bullmq-failure.logger.ts (owner-approved, 2026-10-28).
// Adapted to the kernel: pino logger, ApiError (our HttpException) is a business error.
import type { Job } from "bullmq";
import { ApiError } from "../../errors.js";
import type { KernelLogger } from "../../log.js";

export interface LogJobFailureOptions {
  /** Extra fields added to the record. */
  tags?: Record<string, string>;
  /**
   * Overrides the "final failure" decision. By default a failure is final when
   * `attemptsMade >= opts.attempts`; an `UnrecoverableError` fails the job at once with attempts
   * left, so a caller holding the error instance passes `final: true`.
   */
  final?: boolean;
}

/**
 * One log line for a failed BullMQ job, by retry progress: `error` when final, `warn` while
 * retries remain. Business errors (`ApiError`) are skipped: they are already recorded in the
 * job's own status or database rows. Use it from `@OnWorkerEvent("failed")`.
 */
export function logJobFailure(
  log: KernelLogger,
  job: Job,
  error: Error,
  options?: LogJobFailureOptions,
): void {
  if (error instanceof ApiError) return;
  const maxAttempts = job.opts?.attempts ?? 1;
  const final = options?.final ?? job.attemptsMade >= maxAttempts;
  const fields = {
    queue: job.queueName,
    jobId: String(job.id ?? ""),
    attempt: job.attemptsMade,
    maxAttempts,
    final,
    err: error,
    ...options?.tags,
  };
  const msg = `queue job failed [${job.queueName}#${job.id}] attempt=${job.attemptsMade}/${maxAttempts}`;
  if (final) log.error(msg, fields);
  else log.warn(msg, fields);
}
