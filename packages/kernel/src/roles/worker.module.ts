import { type DynamicModule, Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { CatalogJobs } from "../catalog/jobs.js";
import { ChannelsModule, ChannelWorkersModule } from "../channels/channels.module.js";
import { GatewayCheckJob } from "../channels/supervisor.js";
import type { KernelConfig } from "../config/schema.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { AttachmentCleanupJob } from "../conversations/attachments.service.js";
import { TitlesModule } from "../conversations/titles.js";
import { EvalWorkersModule } from "../evals/evals.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { PluginsReconcileJob } from "../extensions/lifecycle.js";
import { KernelScheduleModule } from "../infra/schedule/schedule.module.js";
import { DirectoryScanJob } from "../orgs/directory-sync.js";
import { OffboardSweepJob } from "../orgs/offboarding.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { MaintenanceModule } from "../runtime/maintenance.js";
import { RuntimeWorkersModule } from "../runtime/run-processors.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { UsageReportModule, UsageSweepJob } from "../runtime/usage-report.js";
import { WaitSweepJob } from "../runtime/waits.js";
import { SandboxSweepJobs } from "../sandbox/jobs.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { StoragePurgeJob } from "../storage/purge.js";
import { StorageModule } from "../storage/storage.module.js";
import { ToolJobs } from "../tools/jobs.js";
import { ToolsModule } from "../tools/tools.module.js";
import { WorkerRole } from "./worker-role.js";

/**
 * The worker role (nest kernel spec §2), imported by `KernelModule` only when `roles` includes
 * `worker`: the cron scheduler and the `@LockedInterval` scheduler (`KernelScheduleModule`, the one
 * place `ScheduleModule.forRoot` is imported), every fixed-period job (`@LockedCron` /
 * `@LockedInterval`, each once per tick across replicas), every queue consumer (`@Processor`: runs,
 * sub-agent runs, `usage.report`, titles, evals, maintenance, channel deliveries) and
 * {@link WorkerRole}, which `KernelLifecycle` drives. A process without the worker role runs no cron
 * and no BullMQ worker (the queues' producers exist on every role).
 */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class WorkerModule {
  static forRoot(config: KernelConfig): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        KernelScheduleModule,
        // the queue consumers (their worker options come from the startup config)
        RuntimeWorkersModule.forRoot(config),
        EvalWorkersModule.forRoot(config),
        ChannelWorkersModule.forRoot(config),
        MaintenanceModule,
        // the domains the fixed-period jobs call
        RuntimeModule,
        UsageReportModule,
        TitlesModule,
        AttachmentsModule,
        StorageModule,
        SandboxModule,
        ToolsModule,
        CatalogModule,
        OrgsModule,
        ExtensionsModule,
        ChannelsModule,
      ],
      providers: [
        WaitSweepJob,
        UsageSweepJob,
        AttachmentCleanupJob,
        StoragePurgeJob,
        SandboxSweepJobs,
        ToolJobs,
        CatalogJobs,
        DirectoryScanJob,
        OffboardSweepJob,
        PluginsReconcileJob,
        GatewayCheckJob,
        WorkerRole,
      ],
      exports: [WorkerRole],
    };
  }
}
