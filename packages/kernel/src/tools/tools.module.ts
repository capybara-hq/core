import { Module } from "@nestjs/common";
import { ConversationAccessModule } from "../conversations/access.js";
import { AttachmentsModule } from "../conversations/attachments.module.js";
import { EventLogModule } from "../conversations/event-log.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { QueueModule } from "../infra/queue/queue.module.js";
import { OrgLockModule } from "../orgs/org-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../runtime/maintenance-queue.js";
import { SubagentsModule } from "../runtime/subagents/subagents.service.js";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ApprovalsService } from "./approvals.service.js";
import { Breaker } from "./breaker.js";
import { BuiltinTools } from "./builtins/builtin-tools.js";
import { ConnectorContent } from "./connector-content.js";
import { ConnectorsService } from "./connectors.service.js";
import { Credentials } from "./credentials.js";
import { ToolDrift } from "./drift.js";
import { ConversationToolInfo } from "./info.js";
import { ToolJobs } from "./jobs.js";
import { OAuthFlow } from "./oauth/flow.js";
import { ToolOutputs } from "./outputs.js";
import { ToolPipeline } from "./pipeline.js";
import { QuestionsService } from "./questions.service.js";
import { ToolRegistry } from "./registry.js";

/**
 * Tools and connectors: credentials, output archives, the builtin tools and the registry,
 * approvals and questions (their decisions are the domain events `approval.decided` /
 * `question.answered`), drift detection (the scan and cleanup jobs, and the producer of the
 * one-off `drift-connector` jobs the maintenance processor consumes), the
 * breaker, connector content, the execution pipeline, org connectors and the OAuth connect flow.
 */
@Module({
  imports: [
    EventLogModule,
    AttachmentsModule,
    ExtensionsModule,
    StorageModule,
    SkillsModule,
    OrgLockModule,
    // the `agent` tool's dispatch
    SubagentsModule,
    // the builtin sandbox and skill tools run in the conversation's sandbox
    SandboxModule,
    // the conversation page's tool metadata reads only what the viewer may see
    ConversationAccessModule,
    QueueModule.registerQueue(MAINTENANCE_QUEUE_NAME),
  ],
  providers: [
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
    ToolJobs,
    ConversationToolInfo,
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
  ],
})
export class ToolsModule {}
