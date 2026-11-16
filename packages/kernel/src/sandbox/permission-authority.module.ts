import { Module } from "@nestjs/common";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import { PermissionInstanceWrites } from "./permission-instance-writes.js";
import { PermissionRuntimeReports } from "./permission-runtime-reports.js";
@Module({
  imports: [],
  providers: [
    PermissionInstanceWrites,
    PermissionRuntimeReports,
    PermissionConfigPublication,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
  exports: [
    PermissionInstanceWrites,
    PermissionRuntimeReports,
    PermissionConfigPublication,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
})
export class PermissionAuthorityModule {}
