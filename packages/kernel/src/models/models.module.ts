import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { ModelEnablementModule } from "./enablement.js";
import { PricesService } from "./prices.js";
import { ModelPurposesService } from "./purposes.js";

/** Model prices, model purposes and the model disabled lists. */
@Module({
  imports: [
    ExtensionRegistryModule,
    IdentityModule,
    OrgLockModule,
    ProvidersModule,
    ModelEnablementModule,
  ],
  providers: [PricesService, ModelPurposesService],
  exports: [PricesService, ModelPurposesService, ModelEnablementModule],
})
export class ModelsModule {}
