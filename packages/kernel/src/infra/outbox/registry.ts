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
  opts?: Pick<
    JobsOptions,
    "attempts" | "backoff" | "priority" | "removeOnComplete" | "removeOnFail"
  >;
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
  // `runtime/usage-report-jobs.ts` USAGE_REPORT_JOB: owed with the usage it reports (a `usage`
  // event or a `model_usage` row) while some plugin subscribes, under `usageReportJobId` /
  // `modelUsageJobId` (spec §8.1)
  "usage-report": {
    queue: "cap-kernel-usage-report",
    idempotent:
      "handlers are idempotent by eventId (the event's `<conversationId>/<seq>` or the model_usage row id), and the job's `pending` list keeps a retry from reaching plugins already served",
    processedIn: "packages/kernel/src/runtime/run-processors.ts",
    // first attempt plus 5 retries, 2 s doubling (F11); finished jobs kept a day so a re-add of the
    // same id (a crash between the add and the row's delete) dedupes; failed ones a week; both
    // capped by count (I-2: a long outage of a billing endpoint cannot grow Redis)
    opts: {
      attempts: 6,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: { age: 24 * 3600, count: 100_000 },
      removeOnFail: { age: 7 * 86_400, count: 100_000 },
    },
  },
  // `channels/deliver-job.ts` DELIVER_JOB: owed by every event append of a conversation with a
  // channel target (a reply, an approval decision, a question answer, a wait stop) and by binding
  // a conversation to its target, under `deliverJobId` (spec §8.1)
  deliver: {
    queue: "cap-kernel-channels",
    idempotent:
      "a delivery resumes from the conversation's delivered seq under a per-conversation lock and sends with idempotency keys, so a second job sends nothing twice",
    processedIn: "packages/kernel/src/channels/channels.module.ts",
    // the platform's retry-after, else exponential (the processor's `deliver` backoff strategy);
    // behind inbound jobs; removed once done, so a later append's id is never deduped away
    opts: {
      attempts: 8,
      backoff: { type: "deliver" },
      priority: 10,
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `catalog/scope-sync.ts` SCOPE_ITEM_JOB: owed by every transaction that changes an item's
  // scope, disabled flag, list, owner or platform version, under `scopeItemJobId` (one per scope
  // version), and by a sync deferred on a replica that had not loaded the extension yet, under
  // `scopeRetryJobId` with `runAt` (spec §8.1)
  "scope-item": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the sync converges each (item, org) from the scope, switches and installs it reads under the org's lock, and the installer re-checks under the org row lock, so a second run changes nothing",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    // one attempt (a pair's failure is recorded, not retried); removed once done, so the next
    // add of the same id is not swallowed
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  },
  // `catalog/scope-jobs.ts` SCOPE_BACKSTOP_JOB: owed by a confirmation's commit (an import, a
  // permissions confirm, an org upload's first version) with `runAt` 5 min on, under
  // `scopeBackstopJobId`, so a crash before the post-deploy add still converges (ruling R24)
  "scope-item-backstop": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the sync converges each (item, org) from what it reads, as a scope-item job does, so a run after the immediate job changes nothing",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    // retried while the item's extension is not enabled on the deployment yet (the job throws):
    // 1, 2, 4, 8 min; removed once done
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `catalog/scope-sync.ts` SCOPE_ORG_JOB: owed by an org's creation, under `scopeOrgJobId`
  "scope-org": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the sync converges each (item, org) of the org from what it reads, so a second run changes nothing",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  },
  // `catalog/job-ids.ts` OWNED_PLUGIN_CLEANUP_JOB: owed by the removal of an org-owned plugin
  // (and by a confirmation that took out the extension of an item removed meanwhile), under
  // `ownedPluginCleanupJobId` (spec §8.1)
  "owned-plugin-cleanup": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "the cleanup takes the extension out only while no live item uses it, and a missing install or a released claim changes nothing",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // a few retries while PG is briefly unavailable; removed once done
    opts: {
      attempts: 3,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `schedules/job-ids.ts` SCHED_FIRE_JOB: owed by the transaction that writes a pending task run
  // (the scan's tick, a person's "run now"), under `schedFireJobId` (spec §8.1)
  "sched-fire": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "a fire acts only on a pending task run, under its row lock; a retried start reuses what the first one made",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // a few retries while PG is briefly unavailable; removed once done
    opts: {
      attempts: 3,
      backoff: { type: "exponential", delay: 2_000 },
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
