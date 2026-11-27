import { Module } from "@nestjs/common";
import { QueueModule } from "../infra/queue/queue.module.js";
import { TOOL_WATCH_QUEUE } from "./tool-watch-queue.js";

const TOOL_WATCH_QUEUE_REGISTRATION = QueueModule.registerQueue(TOOL_WATCH_QUEUE);

/**
 * The watched-wait poll queue, registered once and shared: imported by `ToolsModule` (every role
 * owes the first poll with a watched ask) and by the admin module (the health overview counts
 * it). The consumer is `ToolWatchWorkersModule`, worker role only.
 */
@Module({
  imports: [TOOL_WATCH_QUEUE_REGISTRATION],
  exports: [TOOL_WATCH_QUEUE_REGISTRATION],
})
export class ToolWatchQueueModule {}
