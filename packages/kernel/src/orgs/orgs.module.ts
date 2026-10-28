import { Module } from "@nestjs/common";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { DirectorySync } from "./directory-sync.js";
import { InvitationsService } from "./invitations.service.js";
import { MembersService } from "./members.service.js";
import { Offboarding } from "./offboarding.js";
import { OrgLockModule } from "./org-lock.js";
import { OrgsService } from "./orgs.service.js";
import { OrgSettingsService } from "./settings.service.js";

/**
 * Organizations: orgs, org settings, members, invitations, offboarding (with its sweep cron) and
 * directory sync (the hourly scan cron, one-off syncs on the maintenance queue).
 */
@Module({
  imports: [
    IdentityModule,
    OrgLockModule,
    ExtensionsModule,
    // the producer side of directory-sync jobs (the maintenance worker consumes until Task 3.9)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    OrgsService,
    OrgSettingsService,
    MembersService,
    InvitationsService,
    Offboarding,
    DirectorySync,
  ],
  exports: [
    OrgLockModule,
    OrgsService,
    OrgSettingsService,
    MembersService,
    InvitationsService,
    Offboarding,
    DirectorySync,
  ],
})
export class OrgsModule {}
