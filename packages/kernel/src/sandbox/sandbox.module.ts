import { Module } from "@nestjs/common";
import { BackgroundStoreModule } from "../background/store.module.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SandboxJobs } from "./jobs.js";
import { SandboxLeases } from "./leases.js";
import { SandboxProviders } from "./providers.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * Sandboxes: the one {@link SandboxService} (an environment's file system and instance over the
 * `sandbox@2` provider, with the shared / exclusive leases of {@link SandboxLeases}) and the
 * producer of the
 * one-off `sandbox-destroy-for` jobs (`MaintenanceProcessor` consumes them). The sweeps
 * (`SandboxSweepJobs`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    ExtensionRegistryModule,
    BackgroundStoreModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [SandboxProviders, SandboxLeases, SandboxService, SandboxJobs],
  exports: [SandboxService, SandboxJobs, SandboxProviders],
})
export class SandboxModule {}
