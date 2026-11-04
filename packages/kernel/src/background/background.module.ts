import { Module } from "@nestjs/common";
import { BackgroundStoreModule } from "./store.module.js";

/**
 * Background Bash (spec 2026-11-05-background-bash-design): the task store (from
 * {@link BackgroundStoreModule}, which `SandboxModule` imports too). The launch, the poller and
 * the tools join this module in later tasks.
 */
@Module({
  imports: [BackgroundStoreModule],
  exports: [BackgroundStoreModule],
})
export class BackgroundModule {}
