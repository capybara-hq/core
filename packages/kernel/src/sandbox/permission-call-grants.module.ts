import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { PermissionProfileStoreModule } from "../conversations/permission-profile-store.module.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionAutoGrants } from "./permission-auto-grants.js";
import { PermissionCallGrants } from "./permission-call-grants.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
@Module({
  imports: [
    PermissionAuthorityModule,
    PermissionFactsModule,
    PermissionProfileStoreModule,
    EventLogModule,
  ],
  providers: [PermissionCallGrants, PermissionAutoGrants],
  exports: [PermissionCallGrants, PermissionAutoGrants],
})
export class PermissionCallGrantsModule {}
