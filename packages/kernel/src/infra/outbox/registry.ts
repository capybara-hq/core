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
 * The plugin scope queue's one retry policy (`scope-item`, `scope-item-chunk`, `scope-org`): 7
 * attempts, 5 s doubling, so the retries wait 5 + 10 + 20 + 40 + 80 + 160 = 315 s (about five
 * minutes) before the last attempt. That is the window a replica has to load an extension its
 * deploy enabled: the enable's `kernel.plugins.changed` message reconciles every replica at once,
 * and if a replica misses it, its periodic reconcile does within
 * `extensionHost.reconcileIntervalSeconds` (default 60 s). An interval longer than the window (it
 * is not capped: tests set an hour to keep the periodic reconcile out of the way) leaves such a
 * replica's chunk to its last attempt, which records `catalog.not_deployed` for the pair until the
 * next sync of the item.
 * Removed once done, so the next add of the same id is not swallowed.
 */
const SCOPE_JOB_OPTS = {
  attempts: 7,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: true,
} as const satisfies OutboxJobSpec["opts"];

/**
 * Every job name added through the outbox. The task that introduces a job name adds its entry; a
 * name without one does not type-check as an `OutboxJobName` (`add` does not check it at runtime).
 */
export const OUTBOX_JOBS = {
  // `automations/job-ids.ts` TRIGGER_DISPATCH_JOB: owed by the transaction that stores a trigger
  // event (`TriggerEventsService.emit`, collaboration spec §4.2), under `trigger-dispatch-<eventId>`
  "trigger-dispatch": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Dispatches one stored event by id; the dispatcher reads the event's state and delivers each automation at most once (deliveries keyed by automation and event)",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  // `automations/job-ids.ts` AUTOMATION_COALESCE_JOB: owed by the dispatch that opens a window of
  // events for one (automation, subject) pair (`TriggerDispatcher`, collaboration spec §4.7), under
  // `<coalesceJobId(automation, subject)>-<first event id>`, due when the window closes
  "automation-coalesce": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Flushes the pair's deliveries still waiting for a run under the automation row lock; a repeat finds none and records nothing",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // removed once done, so a later window's add is never swallowed by a kept job
    opts: {
      attempts: 10,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `shares/share-objects.ts` SHARE_OBJECT_DELETE_JOB: owed before the file library by a share's
  // refresh and revoke (`shareObjectDeleteJobId`); no longer owed, handled for rows owed before the
  // deploy (a key a blob uses is never deleted)
  "share-object-delete": {
    queue: "cap-kernel-maintenance",
    idempotent: "Deletes one object key; deleting a missing object is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  // `files/blob-objects.ts` BLOB_DELETE_JOB: owed with a blob turned `deleting` (an upload dropped
  // before use whose own blob nothing else points at; the blob sweep; a hashing merge's
  // duplicate), under `blobDeleteJobId`
  "blob-delete": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Deletes the object and row only of a blob still in deleting status that no file or share points at; deleting a missing object is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // removed on failure too: the blob sweep owes a stale deletion again under the same id
    opts: {
      attempts: 10,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `files/hash-job.ts` FILE_LIBRARY_HASH_JOB: the hashing dispatcher, owed by the hourly kickoff
  // under its own name as id
  "file-library-hash": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Owes each org's first hashing batch under a deterministic id; a second run owes the same ids, deduplicated",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // removed either way, so the next kickoff can owe it again
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `files/hash-job.ts` FILE_LIBRARY_HASH_ORG_JOB: one org's hashing batch, owed by the dispatcher
  // and by the previous batch, under `fileLibraryHashOrgJobId`
  "file-library-hash-org": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Holds the org's hashing lock and re-checks each blob under its row lock and the hash's lock; a blob already hashed or merged is skipped",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `files/library-backfill.ts` FILE_LIBRARY_BACKFILL_JOB: the one-off catch-up copy, owed by the
  // kickoff until it settled, under its own name as id
  "file-library-backfill": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Does nothing once the settled marker exists; the copy itself is idempotent and writes the marker in its own transaction",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 30000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `files/blob-objects.ts` FILE_RELEASE_JOB: owed, deferred, by every discard and draft cleanup
  // of an upload, under `fileReleaseJobId`
  "file-release": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Re-reads the deleted file under its row lock and releases its blob only while nothing else points at it, or deletes its own staging key; a second run finds nothing to do",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  // `files/blob-objects.ts` FILE_STAGING_DELETE_JOB: owed by a finalize that reused another blob, a
  // discard and the draft cleanup, under `fileStagingDeleteJobId`
  "file-staging-delete": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Deletes the file's own staging key only when the file is no longer uploading and no blob names that key; deleting a missing object is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  // `themes/platform-icon-objects.ts` PLATFORM_ICON_DELETE_JOB: owed by an icon upload (its own
  // object's delayed orphan check), a replace and a clear (the object the row stopped naming)
  "platform-icon-delete": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Deletes one icon object only when the purpose's row does not name it, under the purpose's lock; deleting a missing object is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // removed on failure too: the ids are content addressed, so a kept failed job would swallow a
    // later owing of the same deletion
    opts: {
      attempts: 10,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  "permission-approval-recheck": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "Reads the current revision and resumes only waiting runs without another pending wait; queued runs are unchanged.",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  "sandbox-operation-reconcile": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "records unknown outcomes and leaves execution to the current run/tool claim; never dispatches a native operation",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 5, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  "sandbox-operation-revoke": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "persists an operation tombstone and acknowledges only a successful idempotent provider revoke",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
  // `sandbox/operation-intents.ts` HOLDER_REVOKE: owed before a crashed sandbox holder's record is
  // forgotten, under `sandbox-holder-revoke-<deviceId>-<token>`
  "sandbox-holder-revoke": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "revokes only the holder's intents still admitted, dispatching or started-or-unknown; a revoked one is left as it is",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 10, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: true },
  },
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
  // `tools/tool-watch-queue.ts` TOOL_WATCH_JOB: the first poll of a watched question, owed with
  // its ask under `toolWatchJobId`; later polls re-delay the same job (browser long waits §5.3)
  "tool-watch": {
    queue: "cap-kernel-tool-watch",
    idempotent:
      "deterministic job id per question; the job re-reads the question and acts only while it is pending, and the wake is conditional on pending under the row lock",
    processedIn: "packages/kernel/src/tools/tool-watch.processor.ts",
    // one job polls a wait of up to a day: kernel errors are re-delayed in the job itself; only a
    // failing re-delay (Redis gone) uses an attempt, retried every 10 s for a day's worth
    opts: {
      attempts: 8_640,
      backoff: { type: "fixed", delay: 10_000 },
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
  // `orgs/offboarding.ts` RUN_STOP_JOB: owed by the offboard transaction for each of the departed
  // member's active runs in the org, under `runStopJobId` (spec §8.1)
  "stop-deleted-org": {
    queue: "cap-kernel-maintenance",
    idempotent: "only active runs are settled and only running background tasks are stopped",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
    },
  },
  "run-stop": {
    queue: "cap-kernel-maintenance",
    idempotent: "stopping a finished run is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // retried while PG or Redis is briefly unavailable; removed once done; a job that failed every
    // attempt is kept a week (no sweep stops the run after it: the failure must stay visible)
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
    },
  },
  // `sandbox/jobs.ts` SANDBOX_DESTROY_FOR_JOB: owed by the transaction that soft-deletes a device
  // (its deletion, offboarding), under `deviceDestroyJobId` (spec §8.1)
  "sandbox-destroy-for": {
    queue: "cap-kernel-maintenance",
    idempotent: "destroying a destroyed device is a no-op",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // the options the direct enqueue had: retried while the provider is down
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 100,
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
  // `channels/deliver-job.ts` RESUME_JOB: owed by the update that lets a connection deliver again
  // (re-enabled, or credentials rotated while active), under `resumeJobId` (one per update)
  "channel-resume": {
    queue: "cap-kernel-channels",
    idempotent:
      "the catch-up re-reads which of the connection's conversations lag their log and adds their delivery jobs, and a delivery resumes from the delivered seq under a per-conversation lock, so a second catch-up sends nothing twice",
    processedIn: "packages/kernel/src/channels/channels.module.ts",
    // retried while PG or Redis is briefly unavailable; behind inbound jobs like a delivery;
    // removed once done
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      priority: 10,
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `catalog/scope-jobs.ts` SCOPE_ITEM_JOB: owed by every transaction that changes what an item's
  // sync converges to (its scope, disabled flag, list, owner or platform version, an import's
  // commit deploying no extension) and by the deploy of its extension (enable, a new version of an
  // enabled one, an approval), under `scopeItemJobId` (one per owing transaction, spec §8.1)
  "scope-item": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the fan-out owes the same chunk job ids again (`<item job id>-c<n>`), which the outbox and BullMQ dedupe, and each chunk converges from what it reads",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    // the plugin scope queue's one retry policy (a PG or Redis blip); removed once done, so the
    // next add of the same id is not swallowed
    opts: SCOPE_JOB_OPTS,
  },
  // `catalog/scope-jobs.ts` SCOPE_CHUNK_JOB: owed by a scope-item job, one per chunk of orgs, under
  // `scopeChunkJobId`
  "scope-item-chunk": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the sync converges each (item, org) from the scope, switches and installs it reads under the org's lock, and the installer re-checks under the org row lock, so a second run changes nothing",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    // retried while the item's extension is enabled but not loaded on the replica (the job throws
    // after its other pairs, P3-38): 5 s doubling, about five minutes in all; the last attempt
    // installs anyway and records what fails. A pair's own failure is recorded and does not fail
    // the job; a retry of a deferred chunk attempts every pair again, a failed one included
    // (idempotent: it converges from what it reads)
    opts: SCOPE_JOB_OPTS,
  },
  // `catalog/scope-jobs.ts` SCOPE_ORG_JOB: owed by an org's creation, under `scopeOrgJobId`
  "scope-org": {
    queue: "cap-kernel-plugin-scope",
    idempotent:
      "the sync converges each (item, org) of the org from what it reads, so a second run changes nothing",
    processedIn: "packages/kernel/src/catalog/scope-sync-workers.ts",
    // as a chunk job: retried while one of its items' extensions is not loaded on the replica
    opts: SCOPE_JOB_OPTS,
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
  // `automations/job-ids.ts` AUTOMATION_FIRE_JOB: owed by the transaction that writes a pending task run
  // (the scan's tick, a person's "run now"), under `automationFireJobId` (spec §8.1)
  "automation-fire": {
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
  // `automations/job-ids.ts` AUTOMATION_SETTLE_JOB: the claimed check, owed by the fire job's claim (the
  // transaction that writes `fired_at`) with `runAt` 10 min on, under `automationSettleJobId` (a run
  // still in flight owes the next check an hour on); the unfired check, owed with the task run
  // (scan tick, "run now") under `automationSettleUnfiredJobId` (ruling R26)
  "automation-settle": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "a check acts only on a task run still pending (claimed for the claimed check, unclaimed for the unfired one), under the task and run row locks, so a run claimed, started, ended or skipped since is left as it is",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // retried while PG is briefly unavailable; removed once done
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `background/wake-rules.ts` BG_WAKE_JOB: owed by the `ensureRun` transaction that finds a
  // conversation's wake inside its wake window, under `bgWakeJobId`, with `runAt` = the window's
  // end (background Bash spec §3)
  "bg-wake": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "the wake only calls ensureRun, which decides from the conversation's state under its row lock, so a wake with nothing unconsumed or an active run starts nothing",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    // the options the direct enqueue had (the queue's default retries): removed once done, so a
    // later window's wake is never deduped away (a job that fired early owes its next retry id)
    opts: { removeOnComplete: true, removeOnFail: true },
  },
  // `evals/jobs.ts` EVAL_CASE_JOB: owed by an eval run's start transaction (the run row and its
  // pending results), one per case, under `evalJobId`
  "eval-case": {
    queue: "cap-kernel-evals",
    idempotent:
      "a case job replays only the case's unfinished results (and pending judgements) of a still-active run, each under a fresh claim, so a second job writes no result twice",
    processedIn: "packages/kernel/src/evals/evals.module.ts",
    // the options the direct enqueue had: transient failures outside the handler (PG, Redis)
    // retried with backoff; removed once done, failed ones kept (by count)
    opts: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: 1000,
    },
  },
  // `tools/connector-tools-jobs.ts` CONNECTOR_TOOLS_JOB: owed by a deferred connector create, an
  // org admin's save that turns a connector ready, and a personal connector's first member
  // credential, under `connectorToolsJobId` (plugin pages spec §5.2.1)
  "connector-tools-list": {
    queue: "cap-connector-tools",
    idempotent:
      "Lists the connector's current tools and stores them with the drift compare-and-write under the connector's row lock; a second listing finds the same snapshot and changes nothing",
    processedIn: "packages/kernel/src/tools/connector-tools.processor.ts",
    // 5 attempts, 10 s doubling (an endpoint briefly down); finished and failed jobs removed (each
    // owing has its own id); a connector still without tools is picked up by the drift scan
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `catalog/template-connector-jobs.ts` TEMPLATE_CONNECTORS_JOB: owed by an install's commit
  // (`PluginInstaller.markInstalled`) and an org switching an extension on
  // (`OrgExtensionConfigs.put`), under `templateConnectorsJobId` (ruling R27)
  "template-connectors-ensure": {
    queue: "cap-template-connectors",
    idempotent:
      "Creates only the template connectors the org never had, each under the org row lock with that rule re-checked, so a second ensure finds them and creates nothing",
    processedIn: "packages/kernel/src/catalog/template-connectors.processor.ts",
    // 8 attempts, 5 s doubling (about 10 minutes: a connector extension enabled by the owing
    // transaction loads on the replica within it); finished and failed jobs removed (each owing
    // has its own id)
    opts: {
      attempts: 8,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: true,
    },
  },
  // `push/jobs.ts` PUSH_FANOUT_JOB: one per trigger event, owed in the event's transaction by
  // `PushOwed` under `pushFanoutJobId` (`push-fanout-<eventId>`, mobile app spec §9.4)
  "push-fanout": {
    queue: "cap-push-deliver",
    idempotent: "Owes delivery jobs under deterministic ids; a repeat owes nothing new",
    processedIn: "packages/kernel/src/push/push-processor.ts",
    // 5 attempts, 5 s doubling (PG briefly unavailable); finished and failed jobs kept a day, so
    // an add of the same id within it is swallowed
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    },
  },
  // `push/jobs.ts` PUSH_DELIVER_JOB: one per event and registration, owed by the push fanout
  // under `pushDeliverJobId` (`push-<eventId>-<registrationId>`, mobile app spec §9.4)
  "push-deliver": {
    queue: "cap-push-deliver",
    idempotent:
      "Completed jobs are kept a day under the deterministic id, so a repeated add is swallowed; a missing registration ends the job",
    processedIn: "packages/kernel/src/push/push-processor.ts",
    // 5 attempts, 10 s doubling (transient and rate_limited answers, timeouts); finished and
    // failed jobs kept a day, so an add of the same id within it is swallowed
    opts: {
      attempts: 5,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    },
  },
  // `device-access/conversation-notices.ts` CONVERSATION_NOTICE_JOB: owed by a conversation's
  // deletion with its notice row, under `conversationNoticeJobId` (close tabs on delete §4.1)
  "device-conversation-notice": {
    queue: "cap-kernel-maintenance",
    idempotent:
      "the attempt claims the notice row (a lease) and the service's handling is idempotent; a delivered notice deleted its row, so a repeat finds none",
    processedIn: "packages/kernel/src/runtime/maintenance.ts",
    opts: { attempts: 1, removeOnComplete: true, removeOnFail: true },
  },
  // `extensions/run-lifecycle-owe.ts` RUN_LIFECYCLE_JOB: owed by the transaction that starts a
  // run, suspends it on a person, resumes it, ends it (finished, failed, aborted) or declines,
  // expires or gives up on directed work, once per phase of a run (and wait) and plugin
  // (collaboration spec §4.8); delivered by the lifecycle queue's consumer
  "hook-run-lifecycle": {
    queue: "cap-kernel-lifecycle",
    idempotent:
      "the `run.lifecycle` handler sets a display state keyed by the run and phase (the SDK contract: handlers are idempotent); the job id is deterministic per run, phase and wait",
    processedIn: "packages/kernel/src/extensions/lifecycle-hooks.ts",
    opts: {
      attempts: 10,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
    },
  },
  // `extensions/lifecycle-hooks.ts` LIFECYCLE_JOB: owed by the transaction that removes a member,
  // deletes an agent or deletes an org, once per subscribing plugin, under `lifecycleJobId`
  // (memory plugin spec §6.3)
  lifecycle: {
    queue: "cap-kernel-lifecycle",
    idempotent:
      "lifecycle handlers must be idempotent (the SDK contract): they delete what the plugin holds for the removed member, agent or org, and deleting it again is a no-op",
    processedIn: "packages/kernel/src/extensions/lifecycle-hooks.ts",
    // retried while the plugin is not loaded on the replica that took the job (a rolling deploy)
    // or its handler fails: 15 attempts from 2 s, doubling (about 18 h in all); removed once done;
    // a job that failed every attempt is kept a week (the failure must stay visible)
    opts: {
      attempts: 15,
      backoff: { type: "exponential", delay: 2_000 },
      removeOnComplete: true,
      removeOnFail: { age: 7 * 86_400, count: 1_000 },
    },
  },
} as const satisfies Record<string, OutboxJobSpec>;

export type OutboxJobName = keyof typeof OUTBOX_JOBS;

/** The registry's BullMQ options of a job name (none for a name it does not list). */
export function outboxJobOptions(name: string): OutboxJobSpec["opts"] {
  return (OUTBOX_JOBS as Record<string, OutboxJobSpec>)[name]?.opts;
}
