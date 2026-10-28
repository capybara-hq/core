import type { Logger } from "@capybara-hq/plugin-sdk";
import { Controller, Get, Inject, Optional, Res } from "@nestjs/common";
import {
  HealthCheckService,
  type HealthIndicatorFunction,
  HealthIndicatorService,
} from "@nestjs/terminus";
import type { FastifyReply } from "fastify";
import { KERNEL_LOG } from "../../http/tokens.js";
import { Public } from "../../identity/principal.js";
import { HEALTH_CHECKS, HEALTH_TIMEOUT_MS, type ReadinessCheck } from "./health.options.js";
import { SHUTDOWN_STATE, type ShutdownState } from "./shutdown-state.js";

/** A dependency that hangs (Redis reconnecting, commands in the offline queue) must still give 503 fast. */
export const CHECK_TIMEOUT_MS = 2_000;

/**
 * `GET /healthz` (process alive, always 200) and `GET /readyz` (dependencies ready).
 * The readyz body only names each check as `"ok"` / `"error"`; the failure reason goes to the log
 * (redacted) and never into the response: driver errors can carry connection strings. Once a stop
 * has begun readyz answers 503 at once and runs no check. `@Public()`: the global auth guard
 * applies here too when the kernel API is mounted.
 */
@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(HealthCheckService) private readonly health: HealthCheckService,
    @Inject(HealthIndicatorService) private readonly indicators: HealthIndicatorService,
    @Inject(HEALTH_CHECKS) private readonly checks: Record<string, ReadinessCheck>,
    @Inject(SHUTDOWN_STATE) private readonly shutdown: ShutdownState,
    @Inject(KERNEL_LOG) private readonly log: Logger,
    @Optional() @Inject(HEALTH_TIMEOUT_MS) private readonly timeoutMs: number = CHECK_TIMEOUT_MS,
  ) {}

  @Get("healthz")
  healthz(): { ok: true } {
    return { ok: true };
  }

  @Get("readyz")
  async readyz(@Res({ passthrough: true }) reply: FastifyReply): Promise<Record<string, unknown>> {
    const stopping = () => {
      reply.code(503);
      return { ok: false, stopping: true };
    };
    if (this.shutdown.isShuttingDown()) return stopping();
    const names = Object.keys(this.checks);
    const logged = new Set<string>();
    const fns: HealthIndicatorFunction[] = names.map(
      (name) => () =>
        this.indicators
          .check(name)
          .attempt(async () => {
            try {
              await (this.checks[name] as ReadinessCheck)();
            } catch (err) {
              logged.add(name);
              this.log.warn("readiness check failed", { check: name, err });
              throw err;
            }
          })
          .withTimeout(this.timeoutMs),
    );
    // `check` throws a 503 exception carrying the same `details` when any indicator is down
    const details = await this.health.check(fns).then(
      (r) => r.details as Record<string, { status: string }>,
      (e: { getResponse?: () => { details?: Record<string, { status: string }> } }) => {
        const d = e.getResponse?.().details;
        if (d === undefined) throw e;
        return d;
      },
    );
    if (this.shutdown.isShuttingDown()) return stopping();
    const body: Record<string, unknown> = {};
    let ok = true;
    for (const name of names) {
      const up = details[name]?.status === "up";
      if (!up) {
        ok = false;
        // A timeout never reaches the wrapper's catch in time
        if (!logged.has(name))
          this.log.warn("readiness check failed", { check: name, err: details[name] });
      }
      body[name] = up ? "ok" : "error";
    }
    reply.code(ok ? 200 : 503);
    return { ok, ...body };
  }
}
