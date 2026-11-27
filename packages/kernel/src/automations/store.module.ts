import { Module } from "@nestjs/common";
import { AutomationStore } from "./store.js";

/**
 * The automation store alone, so the scanner (worker), the fire job, the HTTP API and the
 * automation tools can each import it without importing one another.
 */
@Module({
  providers: [AutomationStore],
  exports: [AutomationStore],
})
export class AutomationStoreModule {}
