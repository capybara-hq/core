import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { PreviewerRegistry } from "./previewers.js";

/** File previewers (`file-preview@1`): which previewers take a file, the org's order, rendering. */
@Module({
  imports: [ExtensionsModule, ConversationsModule, StorageModule],
  providers: [PreviewerRegistry],
  exports: [PreviewerRegistry],
})
export class FilesModule {}
