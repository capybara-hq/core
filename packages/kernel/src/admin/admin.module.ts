import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { PlatformAuditService } from "./platform-audit.service.js";
import { SetupService } from "./setup.service.js";
import { SetupLockModule } from "./setup-lock.js";

/**
 * Deployment administration: the setup wizard and the platform-level audit log (its controllers are
 * the api role's, `ApiModule`).
 */
@Module({
  imports: [IdentityModule, OrgsModule, SetupLockModule],
  providers: [SetupService, PlatformAuditService],
  exports: [SetupService, PlatformAuditService],
})
export class AdminModule {}
