import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { ExtensionRegistryModule } from "../extensions/registry.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { ProvidersModule } from "../runtime/providers.js";
import { ScheduleToolsPort } from "../tools/builtins/schedules.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ScheduledTasksService } from "./scheduled-tasks.service.js";
import { ScheduledTaskStoreModule } from "./store.module.js";

/**
 * Scheduled tasks for people (spec 2026-11-11): the service the HTTP API, the Platform operations
 * and the schedule tools share. ToolsModule: grants resolve the agent's tools (`ToolRegistry`);
 * ExtensionRegistryModule: a group chat target needs its channel's `features.threads`. At start
 * it binds the service into the schedule tools' port (`ScheduleToolsPort`): the tools cannot
 * inject it, since this module imports theirs.
 */
@Module({
  imports: [
    ScheduledTaskStoreModule,
    OrgLockModule,
    AgentLookupModule,
    ConversationAccessModule,
    ExtensionRegistryModule,
    ToolsModule,
    // a new-conversation task's model must resolve for the org
    ProvidersModule,
    // "run now" enqueues the fire job
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [ScheduledTasksService],
  exports: [ScheduledTasksService, ScheduledTaskStoreModule],
})
export class SchedulesModule implements OnModuleInit {
  constructor(
    @Inject(ScheduleToolsPort) private readonly port: ScheduleToolsPort,
    @Inject(ScheduledTasksService) private readonly service: ScheduledTasksService,
  ) {}

  onModuleInit(): void {
    this.port.bind(this.service);
  }
}
