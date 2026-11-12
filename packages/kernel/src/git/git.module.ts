import { Module } from "@nestjs/common";
import { CredentialsModule } from "../tools/credentials.module.js";
import { GitIdentities } from "./identity.js";
import { GitSources } from "./sources.js";
import { GitTickets } from "./tickets.js";

/**
 * The git gateway (sandbox git credentials spec §5, §6): run tickets ({@link GitTickets}), whose
 * connector serves a git host for an actor ({@link GitSources}) and the commit identity
 * ({@link GitIdentities}). It needs only the global infra and the connector credentials
 * (`CredentialsModule`, not `ToolsModule`), so the api role (the gateway route) and the runtime
 * and tool code (which issue tickets) can import it without a cycle.
 */
@Module({
  imports: [CredentialsModule],
  providers: [GitTickets, GitSources, GitIdentities],
  exports: [GitTickets, GitSources, GitIdentities],
})
export class GitModule {}
