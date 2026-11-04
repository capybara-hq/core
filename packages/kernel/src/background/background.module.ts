import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { BackgroundTaskFinisher } from "./finish.js";
import { BackgroundTaskStopper } from "./stop.js";
import { BackgroundStoreModule } from "./store.module.js";
import { BackgroundWake } from "./wake.js";

/**
 * Background Bash (spec 2026-11-05-background-bash-design): the task store (from
 * {@link BackgroundStoreModule}, which `SandboxModule` imports too), the finish of a task with its
 * event ({@link BackgroundTaskFinisher}), the stops ({@link BackgroundTaskStopper}) and the wake
 * of an idle conversation ({@link BackgroundWake}). The poll and prune jobs
 * (`BackgroundTaskPollJob`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [BackgroundStoreModule, SandboxModule, EventLogModule],
  providers: [BackgroundTaskFinisher, BackgroundTaskStopper, BackgroundWake],
  exports: [BackgroundStoreModule, BackgroundTaskFinisher, BackgroundTaskStopper, BackgroundWake],
})
export class BackgroundModule {}
