import { Module } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ConversationAccessModule } from "./access.js";
import { ConversationArtifacts } from "./artifacts.js";
import { AttachmentsModule } from "./attachments.module.js";
import { ConversationsService } from "./conversations.service.js";
import { EventLogModule } from "./event-log.js";
import { ConversationFiles } from "./files.js";
import { ConversationOutputs } from "./outputs-read.js";
import { ConversationQueue } from "./queue.service.js";
import { ConversationSandboxStatus } from "./sandbox-status.js";

/**
 * Conversations: the one {@link ConversationsService} (messages, model switches, skill
 * invocations, sub-agent views, abort), the queue, the file / artifact / output reads and the
 * sandbox status. The event log, the access check and the attachments are their own modules (the
 * skills and tools use them too) and are re-exported here.
 */
@Module({
  imports: [
    EventLogModule,
    ConversationAccessModule,
    AttachmentsModule,
    AgentLookupModule,
    StorageModule,
    SkillsModule,
    ToolsModule,
    // the run control (start a run after a message, stop runs) and the model provider registry
    RuntimeModule,
    ProvidersModule,
  ],
  providers: [
    ConversationsService,
    ConversationQueue,
    ConversationOutputs,
    ConversationArtifacts,
    ConversationFiles,
    ConversationSandboxStatus,
  ],
  exports: [
    EventLogModule,
    ConversationAccessModule,
    AttachmentsModule,
    ConversationsService,
    ConversationQueue,
    ConversationOutputs,
    ConversationArtifacts,
    ConversationFiles,
    ConversationSandboxStatus,
  ],
})
export class ConversationsModule {}
