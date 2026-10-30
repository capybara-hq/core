import { type DynamicModule, Global, Module, Scope } from "@nestjs/common";
import { INQUIRER } from "@nestjs/core";
import type { KernelConfig } from "../../config/schema.js";
import type { KernelLogger } from "../../log.js";
import { createConfiguredLogger } from "../../log-config.js";
import { KERNEL_LOGGER, KERNEL_ROOT_LOGGER } from "../tokens.js";

export interface LoggingModuleOptions {
  /** An existing logger (tests, embedders); default: the one the config describes. */
  logger?: KernelLogger;
}

/**
 * Provides the process logger as `KERNEL_ROOT_LOGGER` and, as `KERNEL_LOGGER`, one child per injecting
 * class with `context` = the class name (the `[context=…]` of the pretty output; octok's
 * per-class Nest logger context). The logger is created before the Nest context (it must exist for
 * startup errors), so it is passed in or derived from the startup config here.
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
      providers: [
        { provide: KERNEL_ROOT_LOGGER, useValue: logger },
        {
          provide: KERNEL_LOGGER,
          scope: Scope.TRANSIENT,
          inject: [KERNEL_ROOT_LOGGER, INQUIRER],
          useFactory: (root: KernelLogger, inquirer: unknown) => contextLogger(root, inquirer),
        },
      ],
      exports: [KERNEL_ROOT_LOGGER, KERNEL_LOGGER],
    };
  }
}

/** The child of `root` for the class instance `inquirer`; `root` itself for a factory provider. */
function contextLogger(root: KernelLogger, inquirer: unknown): KernelLogger {
  const name = (inquirer as { constructor?: { name?: unknown } } | undefined)?.constructor?.name;
  return typeof name === "string" && name !== "" && name !== "Object"
    ? root.child({ context: name })
    : root;
}
