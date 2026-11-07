import { Module } from "@nestjs/common";
import { PlatformActor } from "./actor.js";
import { PlatformOperations } from "./registry.js";

/**
 * The `Platform` tool's core (Platform tool spec §3, §6, §7): the operation registry and the actor
 * facts. It imports no domain module (ruling P2), so `ToolsModule` can import it without a
 * cycle; domain providers register their operations into `PlatformOperations` from
 * `onModuleInit`.
 */
@Module({
  providers: [PlatformOperations, PlatformActor],
  exports: [PlatformOperations, PlatformActor],
})
export class PlatformModule {}
