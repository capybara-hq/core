import type { ArgumentsHost } from "@nestjs/common";
import { HttpException } from "@nestjs/common";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/errors.js";
import { ErrorFilter } from "../../src/http/error.filter.js";
import { createLogger } from "../../src/log.js";

function run(exception: unknown): { status: number; body: { error: { code: string } } } {
  const out = { status: 0, body: undefined as unknown as { error: { code: string } } };
  const reply = {
    code(s: number) {
      out.status = s;
      return reply;
    },
    send(b: { error: { code: string } }) {
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
  new ErrorFilter(createLogger("info", { write: () => {} })).catch(exception, host);
  return out;
}

describe("ErrorFilter 通用错误码", () => {
  it.each([
    [400, "validation_failed"],
    [401, "auth.required"],
    [403, "forbidden"],
    [404, "not_found"],
    [409, "internal"],
    [413, "internal"],
    [503, "internal"],
  ])("HttpException %i → %s，状态码保留", (status, code) => {
    const r = run(new HttpException("x", status));
    expect(r.status).toBe(status);
    expect(r.body.error.code).toBe(code);
  });

  it("ApiError 保留自己的错误码", () => {
    const r = run(new ApiError("auth.refresh_race", "race"));
    expect(r.status).toBe(401);
    expect(r.body.error.code).toBe("auth.refresh_race");
  });
});
