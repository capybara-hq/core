import type { Logger } from "@capybara-hq/plugin-sdk";
import type { LoggerService } from "@nestjs/common";

/** A logger with an optional debug (the kernel logger has one; the SDK Logger does not). */
type MaybeDebugLogger = Logger & {
  debug?: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * Forwards Nest's own log lines to the kernel logger, as octok does: `log` (module loading,
 * the `Mapped {/api/v1/…, GET} route` lines at startup) at info, `warn` / `error` as they are,
 * `debug` / `verbose` at debug. Nest's context name becomes the record's `context`.
 */
export class NestLogAdapter implements LoggerService {
  constructor(private readonly logger: MaybeDebugLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(String(message), fields(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(String(message), fields(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error(String(message), fields(params));
  }

  debug(message: unknown, ...params: unknown[]): void {
    this.logger.debug?.(String(message), fields(params));
  }

  verbose(message: unknown, ...params: unknown[]): void {
    this.logger.debug?.(String(message), fields(params));
  }
}

/**
 * Nest passes its context name (e.g. `RoutesResolver`) last and, for errors, the stack before it. The
 * name becomes `context` (the pretty `[context=…]`), anything else `nest`.
 */
function fields(params: unknown[]): Record<string, unknown> | undefined {
  const rest = params.filter((p) => p !== undefined);
  const last = rest.at(-1);
  const out: Record<string, unknown> = {};
  if (typeof last === "string" && /^[A-Za-z][\w.-]*$/.test(last)) {
    out.context = last;
    rest.pop();
  }
  if (rest.length > 0) out.nest = rest.length === 1 ? rest[0] : rest;
  return Object.keys(out).length > 0 ? out : undefined;
}
