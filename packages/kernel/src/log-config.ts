import type { KernelConfig } from "./config/schema.js";
import { createLogger, type KernelLogger, type LoggerOptions } from "./log.js";

/**
 * Logger options from the kernel config: the console format, `role` (the process's roles joined
 * by `,`) on every record, and the Loki output when `log.loki.url` is set. `extra` overrides (tests).
 */
export function loggerOptionsFromConfig(
  config: KernelConfig,
  extra: Partial<LoggerOptions> = {},
): LoggerOptions {
  const role = config.roles.join(",");
  const { url, username, password, labels } = config.log.loki;
  return {
    format: config.log.format,
    base: { role },
    ...(url !== undefined && {
      loki: {
        url,
        labels,
        role,
        ...(username !== undefined && { username }),
        ...(password !== undefined && { password }),
      },
    }),
    ...extra,
  };
}

/** The process logger as configured by `log.*` and `roles`. */
export function createConfiguredLogger(config: KernelConfig): KernelLogger {
  return createLogger(config.log.level, loggerOptionsFromConfig(config));
}
