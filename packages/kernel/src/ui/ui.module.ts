import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { FilesModule } from "../files/files.module.js";
import { EmbedTokensModule } from "./embed-token.js";
import { OrgMembership, OrgUiStreams } from "./ui-stream.js";
import { UiViews } from "./views.js";

/**
 * Extension UI on the kernel side: the views and actions (`ctx.ui`), the embed tokens
 * ({@link EmbedTokensModule}, re-exported; the extension host verifies them with the same
 * provider) and the org UI refresh stream.
 */
@Module({
  imports: [ExtensionsModule, ConversationsModule, FilesModule, EmbedTokensModule],
  providers: [UiViews, OrgMembership, OrgUiStreams],
  exports: [UiViews, OrgUiStreams, EmbedTokensModule],
})
export class UiModule {}
