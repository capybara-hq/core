import { Module } from "@nestjs/common";
import { ConversationAccessModule } from "./access.js";
import { PermissionProfileStore } from "./permission-profile-store.js";
@Module({
  imports: [ConversationAccessModule],
  providers: [PermissionProfileStore],
  exports: [PermissionProfileStore],
})
export class PermissionProfileStoreModule {}
