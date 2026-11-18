import { Module } from "@nestjs/common";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { IdentityModule } from "../identity/identity.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ProvidersModule } from "../runtime/providers.js";
import { UsageReportJobsModule } from "../runtime/usage-report-jobs.js";
import { ModelEmbeddings } from "./embeddings.js";
import { ModelEnablementModule } from "./enablement.js";
import { ModelImages } from "./images.js";
import { PricesService } from "./prices.js";
import { ModelPurposesService } from "./purposes.js";

/**
 * Model prices, model purposes, the model disabled lists, the `ctx.models` embeddings broker and
 * the image generation calls ({@link ModelImages}).
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
    // an embed call's `usage.report` delivery, owed with its `model_usage` row (no queue)
    UsageReportJobsModule,
  ],
  providers: [PricesService, ModelPurposesService, ModelEmbeddings, ModelImages],
  exports: [
    PricesService,
    ModelPurposesService,
    ModelEnablementModule,
    ModelEmbeddings,
    ModelImages,
  ],
})
export class ModelsModule {}
