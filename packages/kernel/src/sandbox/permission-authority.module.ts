import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import { PermissionInstanceWrites } from "./permission-instance-writes.js";
import { PermissionRuntimeReports } from "./permission-runtime-reports.js";
import { PermissionTransitions } from "./permission-transitions.js";
@Module({
  imports: [EventLogModule],
  providers: [
    PermissionTransitions,
    PermissionInstanceWrites,
    PermissionRuntimeReports,
    PermissionConfigPublication,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
  exports: [
    PermissionTransitions,
    PermissionInstanceWrites,
    PermissionRuntimeReports,
    PermissionConfigPublication,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
})
export class PermissionAuthorityModule {}
