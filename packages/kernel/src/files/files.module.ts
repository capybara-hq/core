import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { PreviewerRegistry } from "./previewers.js";

/**
 * File previewers (`file-preview@1`): which previewers take a file (a conversation file, a share's
 * snapshot, a skill file), the org's order, rendering.
 */
@Module({
  imports: [ExtensionsModule, ConversationsModule, SkillsModule, StorageModule],
  providers: [PreviewerRegistry],
  exports: [PreviewerRegistry],
})
export class FilesModule {}
