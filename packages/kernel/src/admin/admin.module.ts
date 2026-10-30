import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { SetupService } from "./setup.service.js";
import { SetupLockModule } from "./setup-lock.js";

/** Deployment administration: the setup wizard (its controllers are the api role's, `ApiModule`). */
@Module({
  imports: [IdentityModule, OrgsModule, SetupLockModule],
  providers: [SetupService],
  exports: [SetupService],
})
export class AdminModule {}
