import { Module } from "@nestjs/common";
import { EventLogModule } from "../conversations/event-log.js";
import { EvalBudgetModule } from "../evals/budget.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { ToolsModule } from "../tools/tools.module.js";
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
    // offboarding publishes the events it cancelled
    EventLogModule,
    OrgLockModule,
    ExtensionsModule,
    // offboarding clears credentials and cancels approvals and questions
    ToolsModule,
    // offboarding stops the member's runs
    RuntimeModule,
    // offboarding enqueues the destruction of the member's sandboxes
    SandboxModule,
    // cancels the deleted org's eval runs
    EvalBudgetModule,
    // the producer side of directory-sync jobs (the maintenance processor consumes them)
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
