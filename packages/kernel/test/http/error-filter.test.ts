import type { ArgumentsHost } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { ErrorFilter, redactPath } from "../../src/http/error.filter.js";

type Body = { error: { code: string; message: string; details?: unknown[] } };

function run(
  exception: unknown,
  errors: { msg: string; fields?: Record<string, unknown> | undefined }[] = [],
): { status: number; body: Body } {
  const out = { status: 0, body: undefined as unknown as Body };
  const reply = {
    code(s: number) {
      out.status = s;
      return reply;
    },
    send(b: Body) {
      out.body = b;
      return reply;
    },
  };
  const host = {
    switchToHttp: () => ({
      getResponse: () => reply,
      getRequest: () => ({ method: "GET", url: "/x" }),
    }),
  } as unknown as ArgumentsHost;
  const log = {
    info() {},
    warn() {},
    error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }),
  };
  new ErrorFilter(log).catch(exception, host);
  return out;
}

describe("ErrorFilter 通用错误码", () => {
  it.each([
    [400, "validation_failed"],
    [401, "auth.required"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "conflict"],
    [413, "payload_too_large"],
    [415, "unsupported_media_type"],
    [429, "rate_limited"],
    [418, "internal"],
    [503, "internal"],
  ])("HttpException %i → %s，状态码保留", (status, code) => {
    const r = run(new HttpException("x", status));
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(code);
  });

  it("ApiError 带 details 时原样返回，4xx 不记 error", () => {
    const errors: { msg: string }[] = [];
    const details = [{ path: "name", message: "too short" }];
    const r = run(new ApiError("validation_failed", "Invalid body", details), errors);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({
      error: { code: "validation_failed", message: "Invalid body", details },
    });
    expect(errors).toEqual([]);
  });

  it("Nest HttpException(503) → internal，保留 503，记 error 且不回显信息", () => {
    const errors: { msg: string }[] = [];
    const r = run(new HttpException("upstream secret-detail", 503), errors);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe("internal");
    expect(r.body.error.message).not.toContain("secret-detail");
    expect(errors.map((e) => e.msg)).toEqual(["http handler failed"]);
  });

  it("未知异常 → 500 internal，记 error 且不回显信息", () => {
    const errors: { msg: string; fields?: Record<string, unknown> | undefined }[] = [];
    const r = run(new TypeError("secret-detail"), errors);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: { code: "internal", message: "Internal error" } });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.msg).toBe("http handler failed");
    expect(errors[0]?.fields?.err).toBeInstanceOf(TypeError);
  });

  it("ApiError 保留自己的错误码", () => {
    const r = run(new ApiError("auth.refresh_race", "race"));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.refresh_race");
  });
});

describe("ErrorFilter 日志脱敏", () => {
  it("5xx 日志里的邀请令牌被替换为 :token，查询串去掉", () => {
    const errors: { msg: string; fields?: Record<string, unknown> | undefined }[] = [];
    const log = {
      info() {},
      warn() {},
      error: (msg: string, fields?: Record<string, unknown>) => errors.push({ msg, fields }),
      child: () => log,
    };
    const reply = { code: () => reply, send: () => reply };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({
          method: "POST",
          url: "/api/v1/invitations/cap_inv_SECRETtoken123/accept?x=cap_inv_q",
        }),
      }),
    } as unknown as ArgumentsHost;
    new ErrorFilter(log as never).catch(new Error("boom"), host);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.fields?.path).toBe("/api/v1/invitations/:token/accept");
    expect(JSON.stringify(errors[0]?.fields?.path)).not.toContain("SECRET");
  });

  it.each([
    ["/api/v1/invitations/abc", "/api/v1/invitations/:token"],
    ["/api/v1/invitations/abc/accept", "/api/v1/invitations/:token/accept"],
    ["/api/v1/invitations/abc?y=1", "/api/v1/invitations/:token"],
    ["/api/v1/orgs/o1/invitations/i1", "/api/v1/orgs/o1/invitations/i1"],
    ["/api/v1/orgs/o1/x/cap_svc_abc", "/api/v1/orgs/o1/x/:redacted"],
    ["/api/v1/me", "/api/v1/me"],
  ])("redactPath(%s) → %s", (input, expected) => {
    expect(redactPath(input)).toBe(expected);
  });
});
