import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ChannelsModule } from "../channels/channels.module.js";
import { PromptSuggestionsModule } from "../conversations/prompt-suggestions.js";
import { TitlesModule } from "../conversations/titles.js";
import { EvalsModule } from "../evals/evals.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { LifecycleHooksModule } from "../extensions/lifecycle-hooks.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RunJobsModule } from "../runtime/run-jobs.js";
import { UsageReportModule } from "../runtime/usage-report.js";
import { AuditLogService } from "./audit-log.service.js";
import { AdminHealthService } from "./health.service.js";
import { OrgNetworkAdmin } from "./org-network.service.js";
import { OutboxDeadService } from "./outbox-dead.service.js";
import { AdminOverviewService } from "./overview.service.js";
import { SetupService } from "./setup.service.js";
import { SetupLockModule } from "./setup-lock.js";
import { AdminUsageService } from "./usage.service.js";

/**
 * Deployment administration: the setup wizard, the audit log reader (the platform's and each
 * org's) and the admin overview with its health read, seven-day usage aggregate and dead outbox
 * rows, and the super admin's side of the org network allowances (its controllers are the api
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
    PromptSuggestionsModule,
    UsageReportModule,
    EvalsModule,
    LifecycleHooksModule,
    // the price table of the usage aggregate
    ModelsModule,
  ],
  providers: [
    SetupService,
    AuditLogService,
    AdminOverviewService,
    AdminHealthService,
    AdminUsageService,
    OutboxDeadService,
    OrgNetworkAdmin,
  ],
  exports: [
    SetupService,
    AuditLogService,
    AdminOverviewService,
    AdminHealthService,
    AdminUsageService,
    OutboxDeadService,
    OrgNetworkAdmin,
  ],
})
export class AdminModule {}
