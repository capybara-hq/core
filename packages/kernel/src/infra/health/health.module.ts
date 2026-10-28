import { Module } from "@nestjs/common";
import { TerminusModule } from "@nestjs/terminus";

/**
 * The terminus machinery behind `/healthz` and `/readyz`. The controller
 * ({@link HealthController}) is registered by the root module, which also provides
 * `HEALTH_CHECKS` and `SHUTDOWN_STATE`: the shutdown state belongs to the root module's
 * lifecycle service, which a child module cannot see. Terminus' own error logging is off: the
 * controller logs a failed check once, with the redacted error, and never puts it in the body.
 */
@Module({
  imports: [TerminusModule.forRoot({ logger: false })],
  exports: [TerminusModule],
})
export class HealthModule {}
