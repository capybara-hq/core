import { Module } from "@nestjs/common";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgsModule } from "../orgs/orgs.module.js";
import { SetupService } from "./setup.service.js";

/** Deployment administration: the setup wizard (the admin controllers stay in ApiModule until 4.1). */
@Module({
  imports: [IdentityModule, OrgsModule],
  providers: [SetupService],
  exports: [SetupService],
})
export class AdminModule {}
