import { Global, Module } from "@nestjs/common";
import { SHUTDOWN_STATE } from "../health/shutdown-state.js";
import { GracefulShutdown } from "./graceful-shutdown.service.js";

/**
 * Global: {@link GracefulShutdown}, also as the health endpoints' `SHUTDOWN_STATE`. The infra
 * modules that close resources at shutdown (Redis, the pool) import it for the shared stop budget.
 */
@Global()
@Module({
  providers: [GracefulShutdown, { provide: SHUTDOWN_STATE, useExisting: GracefulShutdown }],
  exports: [GracefulShutdown, SHUTDOWN_STATE],
})
export class GracefulShutdownModule {}
