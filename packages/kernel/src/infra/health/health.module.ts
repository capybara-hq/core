import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

/**
 * The terminus machinery behind `/healthz` and `/readyz`. The controller
 * ({@link HealthController}) is registered by the root module, which also provides
 * `HEALTH_CHECKS`; `SHUTDOWN_STATE` is the global `GracefulShutdown`. Terminus' own error logging
 * is off: the
 * controller logs a failed check once, with the redacted error, and never puts it in the body.
 */
@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  exports: [TerminusModule],
})
export class HealthModule {}
