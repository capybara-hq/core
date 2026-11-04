import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { BackgroundTaskFinisher } from "./finish.js";
import { BackgroundTaskStopper } from "./stop.js";
import { BackgroundStoreModule } from "./store.module.js";

/**
 * Background Bash (spec 2026-11-05-background-bash-design): the task store (from
 * {@link BackgroundStoreModule}, which `SandboxModule` imports too), the finish of a task with its
 * event ({@link BackgroundTaskFinisher}) and the stops ({@link BackgroundTaskStopper}). The wake of
 * an idle conversation (`BackgroundWake`) is the runtime's (`RuntimeModule`): it needs the run
 * queue, and the runtime imports this module. The poll and prune jobs
 * (`BackgroundTaskPollJob`) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [BackgroundStoreModule, SandboxModule, EventLogModule],
  providers: [BackgroundTaskFinisher, BackgroundTaskStopper],
  exports: [BackgroundStoreModule, BackgroundTaskFinisher, BackgroundTaskStopper],
})
export class BackgroundModule {}
