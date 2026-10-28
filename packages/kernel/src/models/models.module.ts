import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { PricesService } from "./prices.js";
import { ModelPurposesService } from "./purposes.js";

/** Model prices and model purposes. */
@Module({
  imports: [ExtensionsModule, IdentityModule, OrgLockModule],
  providers: [PricesService, ModelPurposesService],
  exports: [PricesService, ModelPurposesService],
})
export class ModelsModule {}
