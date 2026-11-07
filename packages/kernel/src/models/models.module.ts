import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { ModelEmbeddings } from "./embeddings.js";
import { ModelEnablementModule } from "./enablement.js";
import { PricesService } from "./prices.js";
import { ModelPurposesService } from "./purposes.js";

/**
 * Model prices, model purposes, the model disabled lists and the `ctx.models` embeddings broker.
 * Below the extension host (the host injects {@link ModelEmbeddings} for `ctx.models`): it must not
 * import `ExtensionsModule`.
 */
@Module({
  imports: [
    ExtensionRegistryModule,
    IdentityModule,
    OrgLockModule,
    ProvidersModule,
    ModelEnablementModule,
  ],
  providers: [PricesService, ModelPurposesService, ModelEmbeddings],
  exports: [PricesService, ModelPurposesService, ModelEnablementModule, ModelEmbeddings],
})
export class ModelsModule {}
