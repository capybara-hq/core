import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SandboxJobs, SandboxSweepJobs } from "./jobs.js";
import { SandboxLeases } from "./leases.js";
import { SandboxProviders } from "./providers.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * Sandboxes: the one {@link SandboxService} (a conversation's sandbox over the `sandbox@1`
 * provider, with the shared / exclusive leases of {@link SandboxLeases}), the sweeps (crons) and
 * the producer of the one-off `sandbox-destroy-for` jobs (the maintenance worker consumes them
 * until Task 3.9, R11).
 */
@Module({
  imports: [ExtensionRegistryModule, QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME)],
  providers: [SandboxProviders, SandboxLeases, SandboxService, SandboxJobs, SandboxSweepJobs],
  exports: [SandboxService, SandboxJobs],
})
export class SandboxModule {}
