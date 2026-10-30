import { Module } from "@nestjs/common";
import type { Redis } from "ioredis";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { TitlesModule } from "../conversations/titles.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { IdentityModule } from "../identity/identity.module.js";
import { LockService } from "../infra/lock/lock.service.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { REDIS } from "../infra/tokens.js";
import { SkillsModule } from "../skills/skills.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { RunAbort } from "./abort.js";
import { KyselyCheckpointSaver } from "./checkpointer.js";
import { ConversationLock } from "./conversation-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "./maintenance-queue.js";
import { ProvidersModule } from "./providers.js";
import { EVAL_QUOTA, EVAL_QUOTA_PREFIX, OrgQuota, RUN_QUOTA, RUN_QUOTA_PREFIX } from "./quota.js";
import { RunControl } from "./run-control.js";
import { RunFinish } from "./run-finish.js";
import { RunJobsModule } from "./run-jobs.js";
import { RunQueue } from "./run-queue.js";
import { AgentLoops, RunSteps } from "./run-steps.js";
import { RunWorker } from "./run-worker.js";
import { StepLog } from "./step-log.js";
import { ConversationStreams } from "./stream.js";
import { SubagentsModule } from "./subagents/subagents.service.js";
import { UsageReportModule } from "./usage-report.js";
import { DecisionResumer, Waits } from "./waits.js";

/**
 * The run runtime: the conversation run lock, this process's event streams, the run queue and its
 * worker (consumed through `RuntimeWorkersModule`'s processors), the waits (their sweep is the
 * worker role's `WaitSweepJob`), run
 * stops, the checkpoints, the org quotas, the step writes and the agent loops. The model provider
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
    ProvidersModule,
    RunJobsModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
    // the producer side of `wait-timeout` jobs (`MaintenanceProcessor` consumes them)
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    ConversationLock,
    ConversationStreams,
    RunAbort,
    KyselyCheckpointSaver,
    RunFinish,
    StepLog,
    RunQueue,
    Waits,
    DecisionResumer,
    RunControl,
    AgentLoops,
    RunSteps,
    RunWorker,
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
    StepLog,
    RunQueue,
    Waits,
    RunControl,
    AgentLoops,
    RunSteps,
    RunWorker,
    RUN_QUOTA,
    EVAL_QUOTA,
    ProvidersModule,
    SubagentsModule,
    UsageReportModule,
    TitlesModule,
  ],
})
export class RuntimeModule {}
