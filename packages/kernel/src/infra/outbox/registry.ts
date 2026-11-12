import type { KernelQueueName } from "../queue/queue-names.js";

/** What the registry says about one job name added through the outbox (spec §3.5, §5). */
export interface OutboxJobSpec {
  /** The kernel queue the job is added to. */
  queue: KernelQueueName;
  /** One sentence: why a duplicate delivery of this job is harmless (state check, key, id). */
  idempotent: string;
  /** Repo-relative path of the file whose `@Processor` handles the job. */
  processedIn: string;
}

/**
 * Every job name added through the outbox. The task that introduces a job name adds its entry; a
 * name without one does not type-check as an `OutboxJobName` (`add` does not check it at runtime).
 */
export const OUTBOX_JOBS = {} as const satisfies Record<string, OutboxJobSpec>;

export type OutboxJobName = keyof typeof OUTBOX_JOBS;
