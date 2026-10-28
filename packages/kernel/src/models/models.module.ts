import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { PricesService } from "./prices.js";
import { ModelPurposesService } from "./purposes.js";

/** Model prices and model purposes. */
@Module({
  imports: [ExtensionsModule],
  providers: [PricesService, ModelPurposesService],
  exports: [PricesService, ModelPurposesService],
})
export class ModelsModule {}
