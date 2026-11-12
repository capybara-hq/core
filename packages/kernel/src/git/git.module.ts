import { Module } from "@nestjs/common";
import { GitTickets } from "./tickets.js";

/**
 * The git gateway (sandbox git credentials spec §5): run tickets ({@link GitTickets}). It needs
 * only the global infra (Redis, the database, the config), so the api role (the gateway route)
 * and the runtime and tool code (which issue tickets) can import it without a cycle.
 */
@Module({
  providers: [GitTickets],
  exports: [GitTickets],
})
export class GitModule {}
