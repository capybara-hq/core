import { Module } from "@nestjs/common";
import { Credentials } from "./credentials.js";

/**
 * Connector credentials ({@link Credentials}) on their own: they need only the global infra
 * (database, keyring, logger, config, locks, Redis), so the git gateway (`GitModule`) can use them
 * without importing `ToolsModule` (whose tool code imports `GitModule`). `ToolsModule` re-exports it.
 */
@Module({
  providers: [Credentials],
  exports: [Credentials],
})
export class CredentialsModule {}
