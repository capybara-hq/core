import type { Logger } from "@capybara-hq/plugin-sdk";
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Inject,
} from "@nestjs/common";
import type { FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ERROR_CODES, type ErrorCode, errorBody } from "../errors.js";
import { KERNEL_LOG } from "./tokens.js";

const CODE_BY_STATUS = new Map<number, ErrorCode>(
  Object.entries(ERROR_CODES).map(([code, status]) => [status, code as ErrorCode]),
);

/** Nest `HttpException` 的状态码 → 错误码：已登记的状态直接对应，其余 4xx 归 `validation_failed`、5xx 归 `internal`。 */
function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS.get(status) ?? (status < 500 ? "validation_failed" : "internal");
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
