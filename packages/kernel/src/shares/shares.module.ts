import { Module } from "@nestjs/common";
import { ConversationsModule } from "../conversations/conversations.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { StorageModule } from "../storage/storage.module.js";
import { ShareLivenessModule } from "./liveness.js";
import { ShareObjectsModule } from "./share-objects.js";
import { SharesService } from "./shares.service.js";

/**
 * File sharing (file sharing spec): creating, refreshing, revoking and listing shares
 * ({@link SharesService}), the live check the open routes use (`ShareLiveness`) and the snapshot
 * deletion the maintenance worker runs (`ShareObjects`).
 */
@Module({
  imports: [
    ConversationsModule,
    StorageModule,
    OrgLockModule,
    ShareLivenessModule,
    ShareObjectsModule,
  ],
  providers: [SharesService],
  exports: [SharesService, ShareLivenessModule, ShareObjectsModule],
})
export class SharesModule {}
