import { Module } from "@nestjs/common";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ConversationMedia } from "./conversation-media.js";
import { LibraryFilesModule } from "./library.module.js";
import { LibraryQuery } from "./library-query.js";
import { ReferencedFiles } from "./referenced-files.js";

/**
 * How conversations read the file library (file library spec §2, §5): the files a conversation
 * refers to ({@link ReferencedFiles}) and the media request building resolves refs with
 * ({@link ConversationMedia}), and the Files page's reads ({@link LibraryQuery}). Re-exports
 * {@link LibraryFilesModule} (the send path attaches files through it). Its own module (no conversations dependency) so conversations, the runtime and the
 * tools can use it.
 */
@Module({
  imports: [StorageModule, LibraryFilesModule, AttachmentsModule],
  providers: [ReferencedFiles, ConversationMedia, LibraryQuery],
  exports: [ReferencedFiles, ConversationMedia, LibraryQuery, LibraryFilesModule],
})
export class LibraryReadModule {}
