import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { PermissionAuthorityEpochStore } from "./permission-authority-epochs.js";
import { PermissionAuthorityLock } from "./permission-authority-lock.js";
import { PermissionCeilingWrites } from "./permission-ceiling-writes.js";
import { PermissionConfigPublication } from "./permission-config-publication.js";
import { PermissionInstanceWrites } from "./permission-instance-writes.js";
import { PermissionRuntimeReports } from "./permission-runtime-reports.js";
import { PermissionTransitions } from "./permission-transitions.js";
/**
 * The writers that narrow or revoke authority (ceiling writes, transitions and their locks) without
 * the config publication: for modules that only revoke (an account disabled) and whose context
 * has no kernel config, such as the Redis-free CLI and contexts over a borrowed pool.
 */
@Module({
  imports: [EventLogModule],
  providers: [
    PermissionTransitions,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
  exports: [
    PermissionTransitions,
    PermissionCeilingWrites,
    PermissionAuthorityLock,
    PermissionAuthorityEpochStore,
  ],
})
export class PermissionCeilingWritesModule {}

@Module({
  imports: [EventLogModule, PermissionCeilingWritesModule],
  providers: [PermissionInstanceWrites, PermissionRuntimeReports, PermissionConfigPublication],
  exports: [
    PermissionCeilingWritesModule,
    PermissionInstanceWrites,
    PermissionRuntimeReports,
    PermissionConfigPublication,
  ],
})
export class PermissionAuthorityModule {}
