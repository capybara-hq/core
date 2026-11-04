import { Module } from "@nestjs/common";
import { BackgroundTaskStore } from "./store.js";

/**
 * The background task store alone, so `SandboxModule` (which kills lost tasks after a resume) can
 * import it while `BackgroundModule`'s launch and poller import `SandboxModule`, without a cycle.
 */
@Module({
  providers: [BackgroundTaskStore],
  exports: [BackgroundTaskStore],
})
export class BackgroundStoreModule {}
