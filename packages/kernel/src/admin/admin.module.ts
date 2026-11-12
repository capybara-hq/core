import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { TitlesModule } from "../conversations/titles.js";
import { EvalsModule } from "../evals/evals.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RunJobsModule } from "../runtime/run-jobs.js";
import { UsageReportJobsModule } from "../runtime/usage-report-jobs.js";
import { AdminHealthService } from "./health.service.js";
import { OutboxDeadService } from "./outbox-dead.service.js";
import { AdminOverviewService } from "./overview.service.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { SetupService } from "./setup.service.js";
import { SetupLockModule } from "./setup-lock.js";
import { AdminUsageService } from "./usage.service.js";

/**
 * Deployment administration: the setup wizard, the platform-level audit log and the admin overview
 * with its health read, seven-day usage aggregate and dead outbox rows (its controllers are the api
 * role's, `ApiModule`).
 */
@Module({
  imports: [
    IdentityModule,
    OrgsModule,
    SetupLockModule,
    ExtensionsModule,
    CatalogModule,
    ProvidersModule,
    InboxModule,
    // the kernel queues the health overview counts, as their owners register them (shared
    // instances: no queue connection of its own)
    RunJobsModule,
    ChannelsModule,
    TitlesModule,
    UsageReportJobsModule,
    EvalsModule,
    // the price table of the usage aggregate
    ModelsModule,
  ],
  providers: [
    SetupService,
    PlatformAuditService,
    AdminOverviewService,
    AdminHealthService,
    AdminUsageService,
    OutboxDeadService,
  ],
  exports: [
    SetupService,
    PlatformAuditService,
    AdminOverviewService,
    AdminHealthService,
    AdminUsageService,
    OutboxDeadService,
  ],
})
export class AdminModule {}
