import { Module } from "@nestjs/common";
import { BackgroundModule } from "../background/background.module.js";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { ModelsModule } from "../models/models.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { PlatformModule } from "../platform/platform.module.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { StepLogModule } from "../runtime/step-log.js";
import { SubagentsModule } from "../runtime/subagents/subagents.service.js";
import { UsageReportModule } from "../runtime/usage-report.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ApprovalsService } from "./approvals.service.js";
import { Breaker } from "./breaker.js";
import { BuiltinTools } from "./builtins/builtin-tools.js";
import { WebPages } from "./builtins/web/page-cache.js";
import { ConnectorContent } from "./connector-content.js";
import { ConnectorsService } from "./connectors.service.js";
import { Credentials } from "./credentials.js";
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
    // the builtin sandbox and skill tools run in the conversation's sandbox
    SandboxModule,
    // `Bash` with run_in_background records its task; TaskOutput / TaskStop finish and stop it
    BackgroundModule,
    // the conversation page's tool metadata reads only what the viewer may see
    ConversationAccessModule,
    // the WebFetch extraction call: its purpose, usage report and step writes
    ModelsModule,
    UsageReportModule,
    StepLogModule,
    // the `Platform` tool's operations, actor facts and agent docs (imports no domain module)
    PlatformModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
    Credentials,
    ToolOutputs,
    BuiltinTools,
    WebPages,
    ToolRegistry,
    ApprovalsService,
    QuestionsService,
    ToolDrift,
    Breaker,
    ConnectorContent,
    ToolPipeline,
    ConnectorsService,
    OAuthFlow,
    ConversationToolInfo,
    OrgExtensionTools,
    OrgToolSwitches,
  ],
  exports: [
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
    OAuthFlow,
    ConversationToolInfo,
    OrgExtensionTools,
    OrgToolSwitches,
  ],
})
export class ToolsModule {}
