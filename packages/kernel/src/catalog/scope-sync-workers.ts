import { Module } from "@nestjs/common";
import { configuredProcessor } from "../infra/queue/configured-processor.js";
import { CatalogModule } from "./catalog.module.js";
import {
  PLUGIN_SCOPE_CONCURRENCY,
  PLUGIN_SCOPE_QUEUE,
  PluginScopeSyncProcessor,
} from "./scope-sync.js";

/**
 * The plugin scope queue's consumer: {@link PluginScopeSyncProcessor}. Imported only by the worker
 * role (`WorkerModule`), so other roles get no processor and no BullMQ worker. It never starts by
 * itself: the worker role (`WorkerRole`) starts it after the extensions loaded.
 */
@Module({
  imports: [CatalogModule],
  providers: [
    configuredProcessor(PluginScopeSyncProcessor, PLUGIN_SCOPE_QUEUE, {
      concurrency: PLUGIN_SCOPE_CONCURRENCY,
    }),
  ],
  exports: [PluginScopeSyncProcessor],
})
export class PluginScopeWorkersModule {}
