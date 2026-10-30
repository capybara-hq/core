import { type DynamicModule, Global, Module } from "@nestjs/common";
import type { KernelConfig } from "../../config/schema.js";
import type { KernelLogger } from "../../log.js";
import { createConfiguredLogger } from "../../log-config.js";
import { KERNEL_LOGGER } from "../tokens.js";

export interface LoggingModuleOptions {
  /** An existing logger (tests, embedders); default: the one the config describes. */
  logger?: KernelLogger;
}

/**
 * Provides the process logger as `KERNEL_LOGGER`. The logger is created before the Nest context
 * (it must exist for startup errors), so it is passed in or derived from the startup config here.
 */
@Global()
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest dynamic module
export class LoggingModule {
  static forRoot(config: KernelConfig, opts: LoggingModuleOptions = {}): DynamicModule {
    return LoggingModule.forLogger(opts.logger ?? createConfiguredLogger(config));
  }

  /** Provides `logger` (a context without a config: `KernelCliModule.overPool`). */
  static forLogger(logger: KernelLogger): DynamicModule {
    return {
      module: LoggingModule,
      global: true,
      providers: [{ provide: KERNEL_LOGGER, useValue: logger }],
      exports: [KERNEL_LOGGER],
    };
  }
}
