import { Module } from "@nestjs/common";
import { ScheduledTaskStore } from "./store.js";

/**
 * The scheduled task store alone, so the scanner (worker), the fire job, the HTTP API and the
 * schedule tools can each import it without importing one another.
 */
@Module({
  providers: [ScheduledTaskStore],
  exports: [ScheduledTaskStore],
})
export class ScheduledTaskStoreModule {}
