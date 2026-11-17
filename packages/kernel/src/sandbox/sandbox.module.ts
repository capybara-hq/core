import { Module } from "@nestjs/common";
import { BackgroundStoreModule } from "../background/store.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { ModelsModule } from "../models/models.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StepLogModule } from "../runtime/step-log.js";
import { CloudPermissionSnapshots } from "./cloud-permission-snapshot.js";
import { SandboxJobs } from "./jobs.js";
import { SandboxLeases } from "./leases.js";
import { OperationAuthorityModule } from "./operation-authority.module.js";
import { OperationIntentsModule } from "./operation-intents.module.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";
import { CommandReviewService } from "./review/review.service.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * Sandboxes: the one {@link SandboxService} (a device's file system and instance over the
 * `sandbox@2` provider, with the shared / exclusive leases of {@link SandboxLeases}), the review
 * every command passes in auto mode ({@link CommandReviewService}), and the producer of the
 * one-off `sandbox-destroy-for` jobs (`MaintenanceProcessor` consumes them). The sweeps
 * (`SandboxSweepJobs`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    SandboxProviderRegistryModule,
    PermissionAuthorityModule,
    PermissionFactsModule,
    OperationIntentsModule,
    OperationAuthorityModule,
    BackgroundStoreModule,
    // the command review's classifier: the `review` purpose, its hooks, usage and audit writes
    ModelsModule,
    ExtensionsModule,
    EventLogModule,
    StepLogModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    SandboxLeases,
    SandboxService,
    SandboxJobs,
    CommandReviewService,
    CloudPermissionSnapshots,
  ],
  exports: [
    SandboxProviderRegistryModule,
    PermissionAuthorityModule,
    SandboxService,
    OperationIntentsModule,
    OperationAuthorityModule,
    SandboxJobs,
    CommandReviewService,
    CloudPermissionSnapshots,
  ],
})
export class SandboxModule {}
