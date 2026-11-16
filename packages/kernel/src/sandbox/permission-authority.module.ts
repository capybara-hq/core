import { Module } from "@nestjs/common";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
@Module({
  imports: [],
  providers: [PermissionAuthorityLock, PermissionAuthorityEpochStore],
  exports: [PermissionAuthorityLock, PermissionAuthorityEpochStore],
})
export class PermissionAuthorityModule {}
