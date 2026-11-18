import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { ShareLivenessModule } from "../shares/liveness.js";
import { StorageModule } from "../storage/storage.module.js";
import { HtmlDocumentService } from "./html-document.service.js";
import { HtmlTokensModule } from "./html-token.js";

/**
 * HTML files rendered as sandboxed documents (file sharing spec §4): the document tokens
 * (`HtmlTokens`) and the service that mints them and serves the document.
 */
@Module({
  imports: [ConversationsModule, ShareLivenessModule, StorageModule, HtmlTokensModule],
  providers: [HtmlDocumentService],
  exports: [HtmlDocumentService, HtmlTokensModule],
})
export class HtmlModule {}
