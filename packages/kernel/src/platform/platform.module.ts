import { Module } from "@nestjs/common";
import { PlatformActor } from "./actor.js";
import { AgentDocs } from "./agent-docs.js";
import { PlatformOperations } from "./registry.js";
import { SealedInputs } from "./sealed-inputs.js";
import { SealedReveals } from "./sealed-reveals.js";

/**
 * The `Platform` tool's core (Platform tool spec §3, §6, §7): the operation registry, the actor
 * facts, the agent docs, the sealed person inputs (platform web parity spec §4.3) and the sealed
 * reveals (invitation links, §7.2). It imports
 * no domain module (ruling P2), so `ToolsModule` can import it without a cycle; domain providers
 * register their operations into `PlatformOperations` from `onModuleInit`.
 */
@Module({
  providers: [PlatformOperations, PlatformActor, AgentDocs, SealedInputs, SealedReveals],
  exports: [PlatformOperations, PlatformActor, AgentDocs, SealedInputs, SealedReveals],
})
export class PlatformModule {}
