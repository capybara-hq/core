import type { Logger } from "@capybara-hq/plugin-sdk";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { createKernelAdapter } from "../../src/http/adapter.js";
import {
  type CreateHttpAppOptions,
  createHttpApp,
  type KernelHttpApp,
} from "../../src/http/app.js";
import { ErrorFilterModule } from "../../src/http/error-filter.module.js";
import { NestLogAdapter } from "../../src/http/nest-logger.js";
import { HealthController } from "../../src/infra/health/health.controller.js";
import { HealthModule } from "../../src/infra/health/health.module.js";
import { HEALTH_CHECKS, type ReadinessCheck } from "../../src/infra/health/health.options.js";
import { SHUTDOWN_STATE } from "../../src/infra/health/shutdown-state.js";
import { KERNEL_LOGGER } from "../../src/infra/tokens.js";

/**
 * The kernel's HTTP plumbing (`createHttpApp`: request ids and the access log, `/plugins/*`
 * dispatch, the replica header) on a small Nest application with only the health endpoints and the
 * error filter, for tests of that plumbing without a database or Redis. Initialized; `close()`
 * closes the whole application.
 */
export async function testHttpApp(
  opts: Omit<CreateHttpAppOptions, "log"> & {
    log: Logger;
    /** The readiness checks (default pg and redis, both ready). */
    checks?: Record<string, ReadinessCheck>;
  },
): Promise<KernelHttpApp> {
  const { checks, ...httpOpts } = opts;
  @Module({})
  class TestHttpRoot {}
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: TestHttpRoot,
      // global: the error filter's module reads the logger from here
      global: true,
      imports: [HealthModule, ErrorFilterModule],
      controllers: [HealthController],
      providers: [
        { provide: KERNEL_LOGGER, useValue: opts.log },
        {
          provide: HEALTH_CHECKS,
          useValue: checks ?? { pg: async () => {}, redis: async () => {} },
        },
        { provide: SHUTDOWN_STATE, useValue: { isShuttingDown: () => false } },
      ],
      exports: [KERNEL_LOGGER],
    },
    createKernelAdapter(false),
    { logger: new NestLogAdapter(opts.log), abortOnError: false },
  );
  const http = await createHttpApp(httpOpts, app);
  await app.init();
  return {
    ...http,
    close: async () => {
      await http.close();
      await app.close();
    },
  };
}
