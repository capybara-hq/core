import { OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable, Module, Optional } from "@nestjs/common";
import type { Job, Worker } from "bullmq";
import { BackgroundModule } from "../background/background.module.js";
import { BG_WAKE_JOB, type BgWakeJobData } from "../background/wake-rules.js";
import { OWNED_PLUGIN_CLEANUP_JOB, type OwnedPluginCleanupData } from "../catalog/job-ids.js";
import { OwnedPluginCleanup, OwnedPluginCleanupModule } from "../catalog/owned-plugin-cleanup.js";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { runJob } from "../infra/queue/run-job.js";
import { KernelScheduleModule } from "../infra/schedule/schedule.module.js";
import { ScheduledRuns } from "../infra/schedule/scheduled-runs.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import {
  DEVICE_OP_RESOLVE_JOB,
  type DeviceOpResolveData,
} from "../local-devices/policy-op-jobs.js";
import type { KernelLogger } from "../log.js";
import { DIRECTORY_SYNC_JOB, DirectorySync, type SyncJobData } from "../orgs/directory-sync.js";
import { Offboarding, RUN_STOP_JOB, type RunStopJobData } from "../orgs/offboarding.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { CloudPermissionSnapshots } from "../sandbox/cloud-permission-snapshot.js";
import {
  runSandboxDestroyFor,
  runSandboxResetFiles,
  SANDBOX_DESTROY_FOR_JOB,
  SANDBOX_RESET_FILES_JOB,
} from "../sandbox/jobs.js";
import {
  HOLDER_REVOKE,
  OPERATION_RECONCILE,
  OPERATION_REVOKE,
} from "../sandbox/operation-intents.js";
import { SandboxOperationReconcileJob } from "../sandbox/operation-reconcile.job.js";
import { PERMISSION_APPROVAL_RECHECK } from "../sandbox/permission-transitions.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SandboxService } from "../sandbox/sandbox.service.js";
import { ScheduledTaskFireModule, ScheduledTaskFirer } from "../schedules/fire.js";
import {
  SCHED_FIRE_JOB,
  SCHED_SETTLE_JOB,
  type SchedFireJobData,
  type SchedSettleJobData,
} from "../schedules/job-ids.js";
import {
  SHARE_OBJECT_DELETE_JOB,
  type ShareObjectDeleteData,
  ShareObjects,
  ShareObjectsModule,
} from "../shares/share-objects.js";
import {
  PLATFORM_ICON_DELETE_JOB,
  type PlatformIconDeleteData,
  PlatformIconObjects,
  PlatformIconObjectsModule,
} from "../themes/platform-icon-objects.js";
import { DeviceOpResolver } from "../tools/device-op-resolver.js";
import { type DriftConnectorJobData, ToolDrift } from "../tools/drift.js";
import { DRIFT_CONNECTOR_JOB } from "../tools/job-ids.js";
import {
  PermissionApprovalJobs,
  type PermissionRecheckData,
} from "../tools/permission-approval-jobs.js";
import { ToolsModule } from "../tools/tools.module.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { RunDeletion, STOP_DELETED_ORG_JOB, type StopDeletedOrgData } from "./run-deletion.js";
import { ENSURE_RUN_JOB, type EnsureRunJobData, RunQueue } from "./run-queue.js";
import { RuntimeModule } from "./runtime.module.js";
import {
  DELIVER_TO_PARENT_JOB,
  type DeliverToParentJobData,
  processDeliverToParent,
  processStopTree,
  STOP_TREE_JOB,
  type StopTreeJobData,
} from "./subagents/tree-jobs.js";
import { WAIT_TIMEOUT_JOB, Waits, type WaitTimeoutData } from "./waits.js";

export { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";

/** The maintenance worker's concurrency (as the hand-made worker had). */
export const MAINTENANCE_CONCURRENCY = 5;

/**
 * The one consumer of `cap-kernel-maintenance` (decision R11 of the Nest kernel spec): dispatches
 * each one-off job by name to its domain (`wait-timeout` → {@link Waits}, `sandbox-destroy-for` and
 * `sandbox-reset-files` → {@link SandboxService}, `drift-connector` → {@link ToolDrift}, `directory-sync` →
 * {@link DirectorySync}, `run-stop` → {@link Offboarding.stopRun}, `bg-wake` and `ensure-run` → {@link RunQueue.ensureRun}, `stop-tree` →
 * {@link processStopTree} and `deliver-to-parent` → {@link processDeliverToParent} (both in
 * runtime/subagents/tree-jobs.ts, over {@link Waits}), `owned-plugin-cleanup` →
 * {@link OwnedPluginCleanup}, `sched-fire` and `sched-settle` → {@link ScheduledTaskFirer}, `device-op-resolve` →
 * {@link DeviceOpResolver}, `share-object-delete` → {@link ShareObjects}, `platform-icon-delete` →
 * {@link PlatformIconObjects}). The name of a periodic job (a `@LockedCron` / `@LockedInterval` job,
 * such as `sandbox-suspend-idle`) runs that job's body once ({@link ScheduledRuns.runNow}), as the
 * maintenance handlers did when those jobs were schedulers on this queue: an operator's or a
 * test's one-off run, not a second schedule (decision R23 of the Nest kernel spec). Any other
 * name fails the job (BullMQ retries it; in a rolling deploy a newer replica knows it). The producers are the domains' own (same names, ids and options).
 */
@Injectable()
export class MaintenanceProcessor extends WorkerHost<Worker> {
  constructor(
    @Inject(PermissionApprovalJobs)
    private readonly permissionApprovals: Pick<PermissionApprovalJobs, "recheck">,
    @Inject(Waits)
    private readonly waits: Pick<
      Waits,
      "processTimeout" | "childFinished" | "stopChildren" | "stopDescendantsOfStopped" | "stopTree"
    >,
    @Inject(SandboxService)
    private readonly sandbox: Pick<
      SandboxService,
      "destroyDevice" | "resetFileSystem" | "revokeDeadHolder"
    >,
    @Inject(ToolDrift) private readonly drift: Pick<ToolDrift, "check">,
    @Inject(DirectorySync) private readonly directory: Pick<DirectorySync, "runSyncJob">,
    @Inject(RunDeletion) private readonly deletion: Pick<RunDeletion, "stopOrg" | "stopTree">,
    @Inject(Offboarding) private readonly offboarding: Pick<Offboarding, "stopRun">,
    @Inject(RunQueue) private readonly runs: Pick<RunQueue, "ensureRun">,
    @Inject(OwnedPluginCleanup) private readonly ownedCleanup: Pick<OwnedPluginCleanup, "run">,
    @Inject(ScheduledTaskFirer)
    private readonly scheduledTasks: Pick<ScheduledTaskFirer, "fire" | "settle">,
    @Inject(DeviceOpResolver) private readonly deviceOps: Pick<DeviceOpResolver, "resolve">,
    @Inject(ScheduledRuns) private readonly scheduled: Pick<ScheduledRuns, "runNow">,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error" | "warn">,
    @Inject(SandboxOperationReconcileJob)
    private readonly operations: Pick<SandboxOperationReconcileJob, "reconcile" | "revoke">,
    @Inject(ShareObjects) private readonly shareObjects: Pick<ShareObjects, "deleteObject">,
    @Inject(PlatformIconObjects)
    private readonly platformIcons: Pick<PlatformIconObjects, "deleteObject">,
    @Optional()
    @Inject(CloudPermissionSnapshots)
    private readonly snapshots?: Pick<CloudPermissionSnapshots, "reconcileDevice">,
  ) {
    super();
  }

  process(job: Job, token?: string): Promise<void> {
    return runJob(MAINTENANCE_QUEUE_NAME, job, () => this.dispatch(job, token));
  }

  /** Starts consuming (worker role, after the extensions loaded; built with `autorun: false`). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  private async dispatch(job: Job, token: string | undefined): Promise<void> {
    switch (job.name) {
      case PERMISSION_APPROVAL_RECHECK:
        await this.permissionApprovals.recheck(job.data as PermissionRecheckData);
        return;
      case OPERATION_RECONCILE:
        await this.operations.reconcile((job.data as { operationId: string }).operationId);
        return;
      case OPERATION_REVOKE:
        await this.operations.revoke((job.data as { operationId: string }).operationId);
        return;
      // a crashed sandbox holder's intents, owed before its record was forgotten (B-1)
      case HOLDER_REVOKE: {
        const { deviceId, token } = job.data as { deviceId: string; token: string };
        await this.sandbox.revokeDeadHolder(deviceId, token);
        return;
      }
      case STOP_DELETED_ORG_JOB:
        await this.deletion.stopOrg(job.data as StopDeletedOrgData);
        return;
      case WAIT_TIMEOUT_JOB:
        await this.waits.processTimeout(job as Job<WaitTimeoutData>, token);
        return;
      case SANDBOX_DESTROY_FOR_JOB:
        await runSandboxDestroyFor(this.sandbox, this.log, job);
        return;
      case SANDBOX_RESET_FILES_JOB:
        await runSandboxResetFiles(this.sandbox, job, this.snapshots);
        return;
      case DRIFT_CONNECTOR_JOB: {
        const { orgId, connectorId, trigger } = job.data as DriftConnectorJobData;
        await this.drift.check(orgId, connectorId, trigger);
        return;
      }
      case DIRECTORY_SYNC_JOB:
        await this.directory.runSyncJob(job.data as SyncJobData);
        return;
      // a departed member's run stop, owed by the offboarding (transactional outbox spec §8.1)
      case RUN_STOP_JOB:
        try {
          await this.offboarding.stopRun(job.data as RunStopJobData);
        } catch (err) {
          // nothing stops the run after its last attempt: say so (the failed job is kept)
          if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
            this.log.error("a departed member's run could not be stopped", {
              jobId: job.id,
              runId: (job.data as RunStopJobData).runId,
              err,
            });
          }
          throw err;
        }
        return;
      // the end of a conversation's wake window (background Bash spec §3)
      case BG_WAKE_JOB: {
        // fired before the window ended (clock skew): it reschedules under its next retry id
        const { conversationId, retry } = job.data as BgWakeJobData;
        await this.runs.ensureRun(conversationId, { wakeRetry: (retry ?? 0) + 1 });
        return;
      }
      // the ensure-run backstop of a message, wake or run end (transactional outbox spec §6)
      case ENSURE_RUN_JOB:
        await this.runs.ensureRun((job.data as EnsureRunJobData).conversationId);
        return;
      // the stops a run's end or a root's delete owes its sub-agent tree (outbox spec §6)
      case STOP_TREE_JOB:
        await processStopTree(this.waits, job.data as StopTreeJobData, this.deletion);
        return;
      // a finished sub-agent run's delivery to its parent (transactional outbox spec §6)
      case DELIVER_TO_PARENT_JOB:
        await processDeliverToParent(this.waits, job.data as DeliverToParentJobData);
        return;
      // a removed org-owned plugin's extension (plugin scope phase 3, P3-20)
      case OWNED_PLUGIN_CLEANUP_JOB:
        await this.ownedCleanup.run((job.data as OwnedPluginCleanupData).itemId);
        return;
      // one task run of a scheduled task (scheduled tasks spec §6)
      case SCHED_FIRE_JOB:
        await this.scheduledTasks.fire((job.data as SchedFireJobData).taskRunId);
        return;
      // a task run's settle check, claimed or unfired (ruling R26)
      case SCHED_SETTLE_JOB:
        await this.scheduledTasks.settle(job.data as SchedSettleJobData);
        return;
      // a device policy op whose outcome was not recorded (transactional outbox spec §7)
      case DEVICE_OP_RESOLVE_JOB:
        await this.deviceOps.resolve(job.data as DeviceOpResolveData);
        return;
      // a share snapshot a refresh or revoke stopped using (file sharing spec §2)
      case SHARE_OBJECT_DELETE_JOB:
        await this.shareObjects.deleteObject(job.data as ShareObjectDeleteData);
        return;
      // a platform icon object no row names any more, or an upload's orphan check (§10.2.1)
      case PLATFORM_ICON_DELETE_JOB:
        await this.platformIcons.deleteObject(job.data as PlatformIconDeleteData);
        return;
      default:
        if (await this.scheduled.runNow(job.name)) return;
        // never completed unrun: in a rolling deploy an old worker meets a job a newer replica
        // owed (its outbox row is gone once added); failing it leaves it to BullMQ's retries, so a
        // newer replica can take it within the job's attempts
        throw new Error(`unknown maintenance job "${job.name}"`);
    }
  }

  @OnWorkerEvent("failed")
  failed(job: Job | undefined, err: Error): void {
    this.log.error("maintenance job failed", { name: job?.name, jobId: job?.id, err });
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("maintenance worker error", { err });
  }
}

/**
 * The maintenance queue's consumer: {@link MaintenanceProcessor}. Imported only by the worker role
 * (`WorkerModule`), so other roles get no processor and no BullMQ worker. It never starts by
 * itself: the worker role (`WorkerRole`) starts it after the extensions loaded.
 */
@Module({
  imports: [
    // the periodic jobs' bodies (a periodic job's name enqueued here runs it once)
    KernelScheduleModule,
    // the exact stop a revoked background start owes (SandboxOperationReconcileJob)
    BackgroundModule,
    RuntimeModule,
    SandboxModule,
    ToolsModule,
    OrgsModule,
    // the removed org plugins' cleanup job (worker-only through this module)
    OwnedPluginCleanupModule,
    // the scheduled task fire job and the scanner (worker-only through this module)
    ScheduledTaskFireModule,
    // the share snapshot deletion
    ShareObjectsModule,
    // the platform icon object deletion
    PlatformIconObjectsModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    SandboxOperationReconcileJob,
    configuredProcessor(MaintenanceProcessor, MAINTENANCE_QUEUE_NAME, {
      concurrency: MAINTENANCE_CONCURRENCY,
    }),
  ],
  exports: [MaintenanceProcessor],
})
export class MaintenanceModule {}
