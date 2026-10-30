import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SandboxJobs } from "./jobs.js";
import { SandboxLeases } from "./leases.js";
import { SandboxProviders } from "./providers.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * Sandboxes: the one {@link SandboxService} (a conversation's sandbox over the `sandbox@1`
 * provider, with the shared / exclusive leases of {@link SandboxLeases}) and the producer of the
 * one-off `sandbox-destroy-for` jobs (`MaintenanceProcessor` consumes them). The sweeps
 * (`SandboxSweepJobs`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [ExtensionRegistryModule, QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME)],
  providers: [SandboxProviders, SandboxLeases, SandboxService, SandboxJobs],
  exports: [SandboxService, SandboxJobs],
})
export class SandboxModule {}
