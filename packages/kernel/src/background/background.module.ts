import { Module } from "@nestjs/common";
import { BackgroundTaskStore } from "./store.js";

/**
 * Background Bash (spec 2026-11-05-background-bash-design): the task store. The launch, the
 * poller and the tools join this module in later tasks.
 */
@Module({
  providers: [BackgroundTaskStore],
  exports: [BackgroundTaskStore],
})
export class BackgroundModule {}
