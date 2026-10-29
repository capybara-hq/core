import { Module } from "@nestjs/common";
import { StorageModule } from "../storage/storage.module.js";
import { ConversationAccessModule } from "./access.js";
import { AttachmentCleanupJob, AttachmentsService } from "./attachments.service.js";

/**
 * Conversation attachments and skill package uploads, with the hourly cleanup of expired unbound
 * ones (`attachment-cleanup`, `@LockedCron`). Its own module (no conversations dependency) so the
 * skills and the builtin tools can use it.
 */
@Module({
  imports: [StorageModule, ConversationAccessModule],
  providers: [AttachmentsService, AttachmentCleanupJob],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
