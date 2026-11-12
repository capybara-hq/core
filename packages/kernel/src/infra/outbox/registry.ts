import type { JobsOptions } from "bullmq";
import type { KernelQueueName } from "../queue/queue-names.js";

/** What the registry says about one job name added through the outbox (spec §3.5, §5). */
export interface OutboxJobSpec {
  /** The kernel queue the job is added to, or the queues when one job name serves several. */
  queue: KernelQueueName | readonly KernelQueueName[];
  /** One sentence: why a duplicate delivery of this job is harmless (state check, key, id). */
  idempotent: string;
  /** Repo-relative path of the file whose `@Processor` handles the job. */
  processedIn: string;
  /**
   * BullMQ options the dispatcher adds the job with over the queue defaults
   * (`QUEUE_JOB_DEFAULTS`); the job id and the delay always come from the row.
   */
  opts?: Pick<JobsOptions, "attempts" | "backoff" | "removeOnComplete" | "removeOnFail">;
}

/**
 * Every job name added through the outbox. The task that introduces a job name adds its entry; a
 * name without one does not type-check as an `OutboxJobName` (`add` does not check it at runtime).
 */
export const OUTBOX_JOBS = {
  // `runtime/run-jobs.ts` RUN_JOB: one name on both run queues (a sub-agent's runs go to the
  // sub-agent queue), under the job ids `runJobId` builds and, for a waiting run's resume
  // (`RunResume.resumeIn`), `resumeJobId`
  run: {
    queue: ["cap-kernel-runs", "cap-kernel-subagent-runs"],
    idempotent:
      "the run worker starts only a run in `queued` state for this job's runId; a finished run's job only repeats the idempotent post-run ensureRun, a waiting run's does nothing",
    processedIn: "packages/kernel/src/runtime/run-processors.ts",
    // one attempt (the run's own paths handle failures); removed once done, so the next run of the
    // same trigger can take the id again (the post-run ensureRun, R34)
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  },
  // `runtime/run-jobs.ts` ENSURE_RUN_JOB: the ensure-run backstop owed with every message, queue
  // change, background task finish, sub-agent delivery and run end (spec §6), under the job ids
  // `ensureRunJobId` builds
  "ensure-run": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "ensureRun decides from the conversation's state; with nothing unconsumed it is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // removed once done (the queue defaults keep finished jobs), so a later write under the same
    // seq (a queue change writes no event of its own) owes a job that is not deduped away
    opts: { removeOnComplete: true, removeOnFail: true },
  },
  // `runtime/waits.ts` WAIT_TIMEOUT_JOB: owed with the suspend that sets a run `waiting`, under
  // `waitTimeoutJobId`, with `runAt` = the wait's deadline (spec §6 "Resumes and timeouts")
  "wait-timeout": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "a timeout acts only on a still-pending wait (a row lock and status check) and a resume starts only a waiting run with nothing else pending",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // retried while PG is briefly unavailable; removed once done
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `runtime/subagents/tree-jobs.ts` STOP_TREE_JOB: owed by a run's terminal transaction that
  // leaves an active fork child (or a person-stopped sub-agent's descendants), under
  // `stopChildrenJobId`, and by a root's delete, under `stopDeletedTreeJobId` (spec §6)
  "stop-tree": {
    queue: "cap-kernel-maintenance",
    idempotent: "stopping a stopped run is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // retried while PG is briefly unavailable; removed once done
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `runtime/subagents/tree-jobs.ts` DELIVER_TO_PARENT_JOB: owed by a sub-agent run's terminal
  // transaction, under `deliverToParentJobId` (spec §6)
  "deliver-to-parent": {
    queue: "cap-kernel-maintenance",
    idempotent: "the delivery's idempotency key is the child run id",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
} as const satisfies Record<string, OutboxJobSpec>;

export type OutboxJobName = keyof typeof OUTBOX_JOBS;

/** The registry's BullMQ options of a job name (none for a name it does not list). */
export function outboxJobOptions(name: string): OutboxJobSpec["opts"] {
  return (OUTBOX_JOBS as Record<string, OutboxJobSpec>)[name]?.opts;
}
