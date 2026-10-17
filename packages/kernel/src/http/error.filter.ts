import type { Logger } from "@capybara-hq/plugin-sdk";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, type ErrorCode, errorBody } from "../errors.js";
import { KERNEL_LOG } from "./tokens.js";

/**
 * Nest `HttpException`（框架自身抛出，如路由不存在、请求体解析失败）的状态码 → 通用错误码。
 * 显式列出而不是反查 `ERROR_CODES`：同一状态码下有多个业务码，反查会误取到业务码。
 * 表外的状态一律 `internal`（状态码本身保留）。
 */
const GENERIC_CODE_BY_STATUS: ReadonlyMap<number, ErrorCode> = new Map<number, ErrorCode>([
  [400, "validation_failed"],
  [401, "auth.required"],
  [403, "forbidden"],
  [404, "not_found"],
]);

function codeForStatus(status: number): ErrorCode {
  return GENERIC_CODE_BY_STATUS.get(status) ?? "internal";
}

/**
 * 全局错误过滤器：一切异常都转成错误信封 `{ error: { code, message, details? } }`。
 * `ApiError` 原样给出；Nest `HttpException`（含路由不存在的 404）按状态码映射；
 * 其他异常一律 500 `internal` 并记日志，不回显错误信息。
 */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  constructor(@Inject(KERNEL_LOG) private readonly log: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<FastifyReply>();
    const req = http.getRequest<FastifyRequest>();
    if (exception instanceof ApiError) {
      if (exception.status >= 500) this.logFailure(req, exception);
      reply
        .code(exception.status)
        .send(errorBody(exception.code, exception.message, exception.details));
      return;
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      if (status < 500) {
        reply.code(status).send(errorBody(codeForStatus(status), exception.message));
        return;
      }
      this.logFailure(req, exception);
      reply.code(status).send(errorBody(codeForStatus(status), "Internal error"));
      return;
    }
    this.logFailure(req, exception);
    reply.code(500).send(errorBody("internal", "Internal error"));
  }

  private logFailure(req: FastifyRequest, err: unknown): void {
    this.log.error("http handler failed", { method: req.method, path: req.url.split("?")[0], err });
  }
}
