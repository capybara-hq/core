import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { ConversationAccessModule } from "./access.js";
import { AttachmentsService } from "./attachments.service.js";

/**
 * Conversation attachments and skill package uploads (the hourly cleanup of expired unbound ones,
 * `AttachmentCleanupJob`, is the worker role's: `WorkerModule`). Its own module (no conversations dependency) so the
 * skills and the builtin tools can use it.
 */
@Module({
  imports: [StorageModule, ConversationAccessModule],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
