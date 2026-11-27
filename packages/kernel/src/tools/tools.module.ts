import { Module } from "@nestjs/common";
import { BackgroundModule } from "../background/background.module.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { ConversationApprovalProfileModule } from "../conversations/approval-profile.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { ConversationLeakCheckModule } from "../conversations/leak-check.js";
import { DevicesModule } from "../devices/devices.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { FileRefs } from "../platform/file-ref.js";
import { PlatformModule } from "../platform/platform.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RunJobsModule } from "../runtime/run-jobs.js";
import { StepLogModule } from "../runtime/step-log.js";
import { SubagentsModule } from "../runtime/subagents/subagents.service.js";
import { ManagedDeviceContextModule } from "../sandbox/managed-device-context.module.js";
import { NetworkGrantsModule } from "../sandbox/network-grants.module.js";
import { OperationAuthorityModule } from "../sandbox/operation-authority.module.js";
import { PermissionAuthorityModule } from "../sandbox/permission-authority.module.js";
import { PermissionCallGrantsModule } from "../sandbox/permission-call-grants.module.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { ScheduledTaskStoreModule } from "../schedules/store.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { AdminConnectors } from "./admin-connectors.js";
import { ApprovalsService } from "./approvals.service.js";
import { Breaker } from "./breaker.js";
import { BuiltinTools } from "./builtins/builtin-tools.js";
import { ScheduleToolsPort, ScheduleUpdates } from "./builtins/schedules.js";
import { WebPages } from "./builtins/web/page-cache.js";
import { ConnectorAccountPolicies } from "./connector-account-policies.js";
import { ConnectorContent } from "./connector-content.js";
import { ConnectorToolsQueueModule } from "./connector-tools-jobs.js";
import { ConnectorsService } from "./connectors.service.js";
import { CredentialsModule } from "./credentials.module.js";
import { ToolDrift } from "./drift.js";
import { ConversationToolInfo, OrgExtensionTools } from "./info.js";
import { OAuthFlow } from "./oauth/flow.js";
import { OrgToolSwitches } from "./org-tool-switches.js";
import { ToolOutputs } from "./outputs.js";
import { PermissionApprovalJobs } from "./permission-approval-jobs.js";
import { ToolPipeline } from "./pipeline.js";
import { QuestionsService } from "./questions.service.js";
import { ToolRegistry } from "./registry.js";
import { ToolAskReview } from "./tool-review.js";
import { ToolWatchQueueModule } from "./tool-watch-queue.module.js";
import { WatchedWaitsLock } from "./watched-waits-lock.js";

/**
 * Tools and connectors: credentials, output archives, the builtin tools and the registry,
 * approvals and questions (their decisions are the domain events `approval.decided` /
 * `question.answered`), drift detection (the producer of the one-off `drift-connector` jobs the
 * maintenance processor consumes), the breaker, connector content, the execution pipeline, org
 * connectors and the OAuth connect flow. The periodic jobs (`ToolJobs`: the drift scan and the
 * output cleanup) are the worker role's (`WorkerModule`).
 */
@Module({
  imports: [
    PermissionCallGrantsModule,
    PermissionAuthorityModule,
    OperationAuthorityModule,
    EventLogModule,
    // the profile that decides an ask addressed to the conversation's person (the profile step)
    ConversationApprovalProfileModule,
    // the approval decision's leak check of a person's card values
    ConversationLeakCheckModule,
    AttachmentsModule,
    ExtensionsModule,
    StorageModule,
    SkillsModule,
    OrgLockModule,
    // the `Agent` tool's dispatch
    SubagentsModule,
    // the builtin sandbox and skill tools run in the conversation's device
    SandboxModule,
    // the managed sandbox route's device context writer
    ManagedDeviceContextModule,
    DevicesModule,
    // network asks read the run tree's network grants
    NetworkGrantsModule,
    // `Bash` with run_in_background records its task; TaskOutput / TaskStop finish and stop it
    BackgroundModule,
    // the conversation page's tool metadata reads only what the viewer may see
    ConversationAccessModule,
    // the WebFetch extraction call: its purpose and step writes (its usage report owed with them)
    ModelsModule,
    // `GenerateImage`'s availability resolves the image purpose's model in the org
    ProvidersModule,
    StepLogModule,
    // a decision resumes its waiting run in the decision's transaction (`RunResume`)
    RunJobsModule,
    // the `Platform` tool's operations, actor facts and agent docs (imports no domain module)
    PlatformModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
    // the connector tool listings owed after a create or a setup (consumer: the worker role's
    // ConnectorToolsProcessor)
    ConnectorToolsQueueModule,
    ToolWatchQueueModule,
    // a trial run's approvals become its scheduled task's grants (scheduled tasks spec §7)
    ScheduledTaskStoreModule,
    // connector credentials (also the git gateway's, without importing this module)
    CredentialsModule,
  ],
  providers: [
    PermissionApprovalJobs,
    ToolOutputs,
    BuiltinTools,
    // a Platform write's file reference (a conversation file)
    FileRefs,
    // `ScheduleUpdate`'s write in one transaction (scheduled tasks spec §11)
    ScheduleUpdates,
    // where `SchedulesModule` binds the task service for the schedule tools (no provider cycle)
    ScheduleToolsPort,
    WebPages,
    ToolRegistry,
    ApprovalsService,
    QuestionsService,
    WatchedWaitsLock,
    ToolDrift,
    Breaker,
    ConnectorContent,
    ToolPipeline,
    // the review model's judgment of a tool ask under Approve for me (the `review` purpose)
    ToolAskReview,
    ConnectorsService,
    AdminConnectors,
    ConnectorAccountPolicies,
    OAuthFlow,
    ConversationToolInfo,
    OrgExtensionTools,
    OrgToolSwitches,
  ],
  exports: [
    PermissionApprovalJobs,
    ScheduleToolsPort,
    CredentialsModule,
    ToolOutputs,
    BuiltinTools,
    ToolRegistry,
    ApprovalsService,
    QuestionsService,
    ToolDrift,
    Breaker,
    ConnectorContent,
    ToolPipeline,
    ConnectorsService,
    AdminConnectors,
    ConnectorAccountPolicies,
    OAuthFlow,
    ConversationToolInfo,
    OrgExtensionTools,
    OrgToolSwitches,
  ],
})
export class ToolsModule {}
