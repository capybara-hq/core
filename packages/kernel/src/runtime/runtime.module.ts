import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { AutomationTrackerModule } from "../automations/run-tracker.js";
import { BackgroundModule } from "../background/background.module.js";
import { BackgroundWake } from "../background/wake.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { PermissionProfileStoreModule } from "../conversations/permission-profile-store.module.js";
import { PromptSuggestionsModule } from "../conversations/prompt-suggestions.js";
import { TitlesModule } from "../conversations/titles.js";
import { DevicesModule } from "../devices/devices.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { LibraryReadModule } from "../files/library-read.module.js";
import { GitModule } from "../git/git.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { LockService } from "../infra/lock/lock.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { REDIS } from "../infra/tokens.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgSettingsModule } from "../orgs/settings.service.js";
import { OperationAuthorityModule } from "../sandbox/operation-authority.module.js";
import { PermissionAuthorityModule } from "../sandbox/permission-authority.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { RunAbort } from "./abort.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { CompactionService } from "./compaction.service.js";
import { CompactionProgressService } from "./compaction-progress.js";
import { CompactionSettingsService } from "./compaction-settings.service.js";
import { ConversationLock } from "./conversation-lock.js";
import { IdleArm } from "./idle-arm.js";
import { IdleCompactionJob } from "./idle-compaction.js";
import { IdleReturn } from "./idle-return.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { PermissionContextRecorder } from "./permission-context.service.js";
import { PluginContextService } from "./plugin-context.service.js";
import { ProjectKnowledgeService } from "./project/knowledge.service.js";
import { ProvidersModule } from "./providers.js";
import { EVAL_QUOTA, EVAL_QUOTA_PREFIX, OrgQuota, RUN_QUOTA, RUN_QUOTA_PREFIX } from "./quota.js";
import { RunContextService } from "./run-context.service.js";
import { RunControl } from "./run-control.js";
import { RunDeletion } from "./run-deletion.js";
import { RunDrafts } from "./run-drafts.js";
import { RunExecution } from "./run-execution.js";
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
import { WriteBaseService } from "./write-base.service.js";

/**
 * The run runtime: the conversation run lock, this process's event streams, the run queue and its
 * worker (consumed through `RuntimeWorkersModule`'s processors), the waits (a run nobody runs is
 * the worker role's `RunOrphanCheck`'s to repair), run stops, the checkpoints, the org quotas, the step writes and the agent loops. The model provider
 * registry, the sub-agent dispatch, `usage.report`, the titles and the prompt suggestions have modules of their own (the
 * tools, models and conversations domains import them without the runtime).
 */
@Module({
  imports: [
    EventLogModule,
    ConversationAccessModule,
    AttachmentsModule,
    // the run's media (`ConversationMedia`): library files the conversation refers to
    LibraryReadModule,
    ExtensionsModule,
    IdentityModule,
    SkillsModule,
    ToolsModule,
    // a bound conversation's device and project scope (project root spec §4.4)
    DevicesModule,
    SandboxModule,
    // the recorded permission context: the authority projection shared with admission, its locks
    // and publication, and the stored root
    OperationAuthorityModule,
    PermissionAuthorityModule,
    PermissionProfileStoreModule,
    GitModule,
    ProvidersModule,
    // the `compaction` purpose the run steps summarize with (compaction model spec §4.2)
    ModelsModule,
    RunJobsModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
    PromptSuggestionsModule,
    // the stream reads the org's prompt suggestion switch
    OrgSettingsModule,
    StepLogModule,
    BackgroundModule,
    // an automation's run follows its kernel run's end (`RunFinish`)
    AutomationTrackerModule,
    // the maintenance queue's handle: the outbox delivers the `wait-timeout` jobs the waits owe
    // (`MaintenanceProcessor` consumes them)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    ConversationLock,
    RunExecution,
    RunDeletion,
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
    PermissionContextRecorder,
    PluginContextService,
    ProjectKnowledgeService,
    // the display-only base of a streaming Write (streaming tool input spec §4.1)
    WriteBaseService,
    RunWorker,
    // the org's effective compaction settings, one read per model step
    CompactionSettingsService,
    // ephemeral compaction progress for the conversation SSE (spec 2026-11-14 §4.6)
    CompactionProgressService,
    // the manual compaction execution of a compact run (spec 2026-11-14 §4.7)
    CompactionService,
    // a chat run's finish decides whether it owes an idle compaction job (idle compaction spec §4.2)
    IdleArm,
    // a run start after a long idle gap logs `idle_return` (idle compaction spec S11)
    IdleReturn,
    // one delivery of the delayed idle compaction job (idle compaction spec §4.3; the maintenance
    // processor, worker role only, consumes it)
    IdleCompactionJob,
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
    RunExecution,
    RunDeletion,
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
    PermissionContextRecorder,
    CompactionSettingsService,
    CompactionService,
    IdleCompactionJob,
    RUN_QUOTA,
    EVAL_QUOTA,
    ProvidersModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
    PromptSuggestionsModule,
  ],
})
export class RuntimeModule {}
