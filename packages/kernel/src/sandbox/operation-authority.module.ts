import { Module } from "@nestjs/common";
import { PermissionProfileStoreModule } from "../conversations/permission-profile-store.module.js";
import { NetworkGrantsModule } from "../local-devices/network-grants.module.js";
import { SandboxOperationAuthority } from "./operation-authority.js";
import { PermissionAuthorityModule } from "./permission-authority.module.js";
import { PermissionCallGrantsModule } from "./permission-call-grants.module.js";
import { PermissionFactsModule } from "./permission-facts.module.js";
@Module({
  imports: [
    PermissionFactsModule,
    PermissionCallGrantsModule,
    PermissionProfileStoreModule,
    PermissionAuthorityModule,
    NetworkGrantsModule,
  ],
  providers: [SandboxOperationAuthority],
  exports: [SandboxOperationAuthority],
})
export class OperationAuthorityModule {}
