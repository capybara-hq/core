import { Module } from "@nestjs/common";
import { ConversationAccessModule } from "../conversations/access.js";
import { EventLogModule } from "../conversations/event-log.js";
import { ConversationLock } from "./conversation-lock.js";
import { ConversationStreams } from "./stream.js";

/**
 * The run runtime's providers (Task 3.6a: the conversation run lock and this process's event
 * streams; Task 3.6b adds the run queue, the workers and the rest).
 */
@Module({
  imports: [EventLogModule, ConversationAccessModule],
  providers: [ConversationLock, ConversationStreams],
  exports: [ConversationLock, ConversationStreams],
})
export class RuntimeModule {}
