import { Module } from "@nestjs/common";
import { CatalogModule } from "../catalog/catalog.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { InboxModule } from "../inbox/inbox.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { ProvidersModule } from "../runtime/providers.js";
import { AdminOverviewService } from "./overview.service.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { SetupService } from "./setup.service.js";
import { SetupLockModule } from "./setup-lock.js";

/**
 * Deployment administration: the setup wizard, the platform-level audit log and the admin overview
 * (its controllers are the api role's, `ApiModule`).
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
  ],
  providers: [SetupService, PlatformAuditService, AdminOverviewService],
  exports: [SetupService, PlatformAuditService, AdminOverviewService],
})
export class AdminModule {}
