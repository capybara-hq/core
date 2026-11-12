import { Module } from "@nestjs/common";
import { BackgroundModule } from "../background/background.module.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { DevicesModule } from "../devices/devices.module.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { LocalDevicesModule } from "../local-devices/local-devices.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { PlatformModule } from "../platform/platform.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { RunJobsModule } from "../runtime/run-jobs.js";
import { StepLogModule } from "../runtime/step-log.js";
import { SubagentsModule } from "../runtime/subagents/subagents.service.js";
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
import { ConnectorsService } from "./connectors.service.js";
import { Credentials } from "./credentials.js";
import { DeviceOpResolver } from "./device-op-resolver.js";
import { ToolDrift } from "./drift.js";
import { ConversationToolInfo, OrgExtensionTools } from "./info.js";
import { OAuthFlow } from "./oauth/flow.js";
import { OrgToolSwitches } from "./org-tool-switches.js";
import { ToolOutputs } from "./outputs.js";
import { ToolPipeline } from "./pipeline.js";
import { QuestionsService } from "./questions.service.js";
import { ToolRegistry } from "./registry.js";

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
    EventLogModule,
    AttachmentsModule,
    ExtensionsModule,
    StorageModule,
    SkillsModule,
    OrgLockModule,
    // the `Agent` tool's dispatch
    SubagentsModule,
    // the builtin sandbox and skill tools run in the conversation's device
    SandboxModule,
    DevicesModule,
    // 「这台设备一直允许」 changes the device's local policy (network asks)
    LocalDevicesModule,
    // `Bash` with run_in_background records its task; TaskOutput / TaskStop finish and stop it
    BackgroundModule,
    // the conversation page's tool metadata reads only what the viewer may see
    ConversationAccessModule,
    // the WebFetch extraction call: its purpose and step writes (its usage report owed with them)
    ModelsModule,
    StepLogModule,
    // a decision resumes its waiting run in the decision's transaction (`RunResume`)
    RunJobsModule,
    // the `Platform` tool's operations, actor facts and agent docs (imports no domain module)
    PlatformModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
    // a trial run's approvals become its scheduled task's grants (scheduled tasks spec §7)
    ScheduledTaskStoreModule,
  ],
  providers: [
    Credentials,
    ToolOutputs,
    BuiltinTools,
    // `ScheduleUpdate`'s write in one transaction (scheduled tasks spec §11)
    ScheduleUpdates,
    // where `SchedulesModule` binds the task service for the schedule tools (no provider cycle)
    ScheduleToolsPort,
    WebPages,
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
    // the `device-op-resolve` job's body (it may decide the network ask the op answers)
    DeviceOpResolver,
  ],
  exports: [
    ScheduleToolsPort,
    Credentials,
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
    DeviceOpResolver,
  ],
})
export class ToolsModule {}
