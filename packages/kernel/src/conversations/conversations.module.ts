import { Module } from "@nestjs/common";
import { AgentLookupModule } from "../agents/agent-lookup.js";
import { BackgroundModule } from "../background/background.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { ProvidersModule } from "../runtime/providers.js";
import { RuntimeModule } from "../runtime/runtime.module.js";
import { SkillsModule } from "../skills/skills.module.js";
import { StorageModule } from "../storage/storage.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ConversationAccessModule } from "./access.js";
import { ConversationArtifacts } from "./artifacts.js";
import { AttachmentsModule } from "./attachments.module.js";
import { ConversationsService } from "./conversations.service.js";
import { ConversationDeviceStatus } from "./device-status.js";
import { EventLogModule } from "./event-log.js";
import { ConversationFiles } from "./files.js";
import { ConversationOutputs } from "./outputs-read.js";
import { ConversationQueue } from "./queue.service.js";

/**
 * Conversations: the one {@link ConversationsService} (messages, model switches, skill
 * invocations, sub-agent views, abort), the queue, the file / artifact / output reads and the
 * conversation's device. The event log, the access check and the attachments are their own modules (the
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
    // the device a conversation is bound to, and its view
    DevicesModule,
    // the stop of a deleted conversation's background tasks
    BackgroundModule,
  ],
  providers: [
    ConversationsService,
    ConversationQueue,
    ConversationOutputs,
    ConversationArtifacts,
    ConversationFiles,
    ConversationDeviceStatus,
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
    ConversationDeviceStatus,
  ],
})
export class ConversationsModule {}
