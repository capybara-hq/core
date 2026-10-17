import type { Logger } from "@capybara-hq/plugin-sdk";
import type { LoggerService } from "@nestjs/common";

/** 把 Nest 自身的日志转给内核 logger：`log` / `warn` / `error` 转发，`debug` / `verbose` 丢弃。 */
export class NestLogAdapter implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.info(String(message), fields(params));
  }

  warn(message: unknown, ...params: unknown[]): void {
    this.logger.warn(String(message), fields(params));
  }

  error(message: unknown, ...params: unknown[]): void {
    this.logger.error(String(message), fields(params));
  }

  debug(): void {}

  verbose(): void {}
}

/** Nest 把上下文名（如 `RoutesResolver`）、错误堆栈作为额外参数传入。 */
function fields(params: unknown[]): Record<string, unknown> | undefined {
  const ctx = params.filter((p) => p !== undefined);
  if (ctx.length === 0) return undefined;
  return { nest: ctx.length === 1 ? ctx[0] : ctx };
}
