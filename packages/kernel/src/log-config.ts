import type { KernelConfig } from "./config/schema.js";
import { createLogger, type KernelLogger, type LoggerOptions } from "./log.js";

/**
 * Logger options from the kernel config: the console format and `role` (the process's roles
 * joined by `,`) on every record. `extra` overrides (tests).
 */
export function loggerOptionsFromConfig(
  config: KernelConfig,
  extra: Partial<LoggerOptions> = {},
): LoggerOptions {
  return {
    format: config.log.format,
    base: { role: config.roles.join(",") },
    ...extra,
  };
}

/** The process logger as configured by `log.*` and `roles`. */
export function createConfiguredLogger(config: KernelConfig): KernelLogger {
  return createLogger(config.log.level, loggerOptionsFromConfig(config));
}
