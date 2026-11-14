import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { BackgroundModule } from "../background/background.module.js";
import { BackgroundWake } from "../background/wake.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { TitlesModule } from "../conversations/titles.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { GitModule } from "../git/git.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { LockService } from "../infra/lock/lock.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { REDIS } from "../infra/tokens.js";
import { ScheduledTaskTrackerModule } from "../schedules/run-tracker.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { RunAbort } from "./abort.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { CompactionService } from "./compaction.service.js";
import { CompactionProgressService } from "./compaction-progress.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { ConversationLock } from "./conversation-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { PluginContextService } from "./plugin-context.service.js";
import { ProvidersModule } from "./providers.js";
import { EVAL_QUOTA, EVAL_QUOTA_PREFIX, OrgQuota, RUN_QUOTA, RUN_QUOTA_PREFIX } from "./quota.js";
import { RunContextService } from "./run-context.service.js";
import { RunControl } from "./run-control.js";
import { RunDrafts } from "./run-drafts.js";
import { RunFinish } from "./run-finish.js";
import { RunJobsModule } from "./run-jobs.js";
import { RunQueue } from "./run-queue.js";
import { AgentLoops, RunSteps } from "./run-steps.js";
import { RunWorker } from "./run-worker.js";
import { StepLogModule } from "./step-log.js";
import { ConversationStreams } from "./stream.js";
import { SubagentsModule } from "./subagents/subagents.service.js";
import { UsageReportModule } from "./usage-report.js";
import { Waits } from "./waits.js";

/**
 * The run runtime: the conversation run lock, this process's event streams, the run queue and its
 * worker (consumed through `RuntimeWorkersModule`'s processors), the waits (a run nobody runs is
 * the worker role's `RunOrphanCheck`'s to repair), run stops, the checkpoints, the org quotas, the step writes and the agent loops. The model provider
 * registry, the sub-agent dispatch, `usage.report` and the titles have modules of their own (the
 * tools, models and conversations domains import them without the runtime).
 */
@Module({
  imports: [
    EventLogModule,
    ConversationAccessModule,
    AttachmentsModule,
    ExtensionsModule,
    IdentityModule,
    SkillsModule,
    ToolsModule,
    GitModule,
    ProvidersModule,
    RunJobsModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
    StepLogModule,
    BackgroundModule,
    // a scheduled task's run follows its kernel run's end (`RunFinish`)
    ScheduledTaskTrackerModule,
    // the maintenance queue's handle: the outbox delivers the `wait-timeout` jobs the waits owe
    // (`MaintenanceProcessor` consumes them)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    ConversationLock,
    ConversationStreams,
    RunAbort,
    KyselyCheckpointSaver,
    RunFinish,
    RunQueue,
    Waits,
    RunControl,
    RunDrafts,
    AgentLoops,
    RunSteps,
    RunContextService,
    PluginContextService,
    RunWorker,
    // the org's effective compaction settings, one read per model step
    CompactionSettingsService,
    // ephemeral compaction progress for the conversation SSE (spec 2026-11-14 §4.6)
    CompactionProgressService,
    // the manual compaction execution of a compact run (spec 2026-11-14 §4.7)
    CompactionService,
    // a finished background task wakes an idle conversation (background Bash spec §3)
    BackgroundWake,
    // one quota per key prefix (the org run quota, the org eval quota)
    {
      provide: RUN_QUOTA,
      inject: [REDIS, LockService],
      useFactory: (redis: Redis, locks: LockService) =>
        new OrgQuota(redis, RUN_QUOTA_PREFIX, locks),
    },
    {
      provide: EVAL_QUOTA,
      inject: [REDIS, LockService],
      useFactory: (redis: Redis, locks: LockService) =>
        new OrgQuota(redis, EVAL_QUOTA_PREFIX, locks),
    },
  ],
  exports: [
    ConversationLock,
    ConversationStreams,
    RunAbort,
    KyselyCheckpointSaver,
    RunFinish,
    StepLogModule,
    RunQueue,
    Waits,
    RunControl,
    RunDrafts,
    AgentLoops,
    RunSteps,
    RunWorker,
    CompactionSettingsService,
    CompactionService,
    RUN_QUOTA,
    EVAL_QUOTA,
    ProvidersModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
  ],
})
export class RuntimeModule {}
