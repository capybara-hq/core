import { Module } from "@nestjs/common";
import { BackgroundStoreModule } from "../background/store.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { DeviceProviderSelectionModule } from "../devices/device-provider-selection.module.js";
import { DialInRelayModule } from "../dial-in/relay.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { ModelsModule } from "../models/models.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StepLogModule } from "../runtime/step-log.js";
import { CloudPermissionSnapshotsModule } from "./cloud-permission-snapshot.module.js";
import { DeviceReportsModule } from "./device-reports.module.js";
import { SandboxJobs } from "./jobs.js";
import { LegacyRetirementModule } from "./legacy-retirement.module.js";
import { OperationAuthorityModule } from "./operation-authority.module.js";
import { OperationIntentsModule } from "./operation-intents.module.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
import { SandboxProviderRegistryModule } from "./providers.module.js";
import { CommandReviewService } from "./review/review.service.js";
import { SandboxService } from "./sandbox.service.js";

/**
 * Sandboxes: the one {@link SandboxService} (a device's file system and instance over the
 * `device-provider@1` provider, with the shared / exclusive leases of {@link SandboxLeases}), the review
 * every command passes in auto mode ({@link CommandReviewService}), and the producer of the
 * one-off `sandbox-destroy-for` jobs (`MaintenanceProcessor` consumes them). The sweeps
 * (`SandboxSweepJobs`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    // which providers serve an org: a use needs the device's provider on in its org
    DeviceProviderSelectionModule,
    SandboxProviderRegistryModule,
    // whether a dial-in device's machine is connected before a dispatch is recorded
    DialInRelayModule,
    DeviceReportsModule,
    PermissionAuthorityModule,
    PermissionFactsModule,
    OperationIntentsModule,
    OperationAuthorityModule,
    BackgroundStoreModule,
    LegacyRetirementModule,
    CloudPermissionSnapshotsModule,
    // the command review's classifier: the `review` purpose, its hooks, usage and audit writes
    ModelsModule,
    ExtensionsModule,
    EventLogModule,
    StepLogModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [SandboxService, SandboxJobs, CommandReviewService],
  exports: [
    SandboxProviderRegistryModule,
    LegacyRetirementModule,
    PermissionAuthorityModule,
    SandboxService,
    OperationIntentsModule,
    OperationAuthorityModule,
    SandboxJobs,
    CommandReviewService,
    CloudPermissionSnapshotsModule,
    DeviceReportsModule,
  ],
})
export class SandboxModule {}
