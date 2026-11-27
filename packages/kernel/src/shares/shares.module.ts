import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { FilesModule } from "../files/files.module.js";
import { LibraryReadModule } from "../files/library-read.module.js";
import { HtmlTokensModule } from "../html/html-token.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { ShareLivenessModule } from "./liveness.js";
import { ShareObjectsModule } from "./share-objects.js";
import { ShareOpenService } from "./share-open.service.js";
import { SharesService } from "./shares.service.js";

/**
 * File sharing (file sharing spec, file library spec §6): creating, refreshing, revoking and listing
 * shares ({@link SharesService}), the live check the open routes use (`ShareLiveness`), the public
 * open routes' service (`ShareOpenService`, streaming the share's blob) and the legacy snapshot
 * deletion the maintenance worker runs (`ShareObjects`).
 */
@Module({
  imports: [
    ConversationsModule,
    // the library files shares are made from and the blobs they point at
    LibraryReadModule,
    OrgLockModule,
    ShareLivenessModule,
    ShareObjectsModule,
    HtmlTokensModule,
    // the share page's extension previewers (file sharing spec §7)
    FilesModule,
  ],
  providers: [SharesService, ShareOpenService],
  exports: [SharesService, ShareOpenService, ShareLivenessModule, ShareObjectsModule],
})
export class SharesModule {}
