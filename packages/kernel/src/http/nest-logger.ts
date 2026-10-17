import type { Logger } from "@capybara-hq/plugin-sdk";
import type { LoggerService } from "@nestjs/common";

/** 可选带 debug 的 logger（内核 logger 有 debug；插件契约的 Logger 没有）。 */
type MaybeDebugLogger = Logger & {
  debug?: (msg: string, fields?: Record<string, unknown>) => void;
};

/**
 * 把 Nest 自身的日志转给内核 logger：`log`（启动时的模块加载、路由映射等，每次启动几十行）降为 debug，
 * `warn` / `error` 原级别转发，`debug` / `verbose` 丢弃。logger 没有 debug 时 `log` 也丢弃。
 */
export class NestLogAdapter implements LoggerService {
  constructor(private readonly logger: MaybeDebugLogger) {}

  log(message: unknown, ...params: unknown[]): void {
    this.logger.debug?.(String(message), fields(params));
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
