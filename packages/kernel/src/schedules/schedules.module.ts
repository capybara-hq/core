import { Module } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ScheduledTasksService } from "./scheduled-tasks.service.js";
import { ScheduledTaskStoreModule } from "./store.module.js";

/**
 * Scheduled tasks for people (spec 2026-11-11): the service the HTTP API, the Platform operations
 * and the schedule tools share. ToolsModule: grants resolve the agent's tools (`ToolRegistry`);
 * ExtensionRegistryModule: a group chat target needs its channel's `features.threads`.
 */
@Module({
  imports: [
    ScheduledTaskStoreModule,
    OrgLockModule,
    AgentLookupModule,
    ConversationAccessModule,
    ExtensionRegistryModule,
    ToolsModule,
    // "run now" enqueues the fire job
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [ScheduledTasksService],
  exports: [ScheduledTasksService, ScheduledTaskStoreModule],
})
export class SchedulesModule {}
