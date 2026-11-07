import { Module } from "@nestjs/common";
import { PlatformActor } from "./actor.js";
import { AgentDocs } from "./agent-docs.js";
import { PlatformOperations } from "./registry.js";

/**
 * The `Platform` tool's core (Platform tool spec §3, §6, §7): the operation registry, the actor
 * facts and the agent docs. It imports no domain module (ruling P2), so `ToolsModule` can import it without a
 * cycle; domain providers register their operations into `PlatformOperations` from
 * `onModuleInit`.
 */
@Module({
  providers: [PlatformOperations, PlatformActor, AgentDocs],
  exports: [PlatformOperations, PlatformActor, AgentDocs],
})
export class PlatformModule {}
