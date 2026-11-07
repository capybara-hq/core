import { Module } from "@nestjs/common";
import { SandboxModule } from "../sandbox/sandbox.module.js";
import { EnvironmentAccess } from "./access.js";
import { ConversationEnvironments } from "./conversation-environments.js";
import { EnvironmentsService } from "./environments.service.js";

/**
 * Environments (spec 2026-11-07-environments-design): a person's environments
 * ({@link EnvironmentsService}), who may use one ({@link EnvironmentAccess}) and the one a
 * conversation works in ({@link ConversationEnvironments}). The instances and file systems are the
 * {@link SandboxModule}'s.
 */
@Module({
  imports: [SandboxModule],
  providers: [EnvironmentAccess, EnvironmentsService, ConversationEnvironments],
  exports: [EnvironmentAccess, EnvironmentsService, ConversationEnvironments],
})
export class EnvironmentsModule {}
