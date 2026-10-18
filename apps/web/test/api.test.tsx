import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiClientError, apiFetch } from "../src/lib/api";

type Call = { url: string; method: string; headers: Headers; body: unknown };

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const expired = () => json(401, { error: { code: "auth.token_expired", message: "expired" } });

/** 按顺序返回预设响应的 fetch 桩，记录每次调用。 */
function stubFetch(...responses: Response[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: new Headers(init?.headers),
        body: init?.body,
      });
      const r = responses.shift();
      if (r === undefined) throw new Error(`unexpected fetch ${String(input)}`);
      return r;
    }),
  );
  return calls;
}

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

describe("apiFetch", () => {
  it("POST 自动带 X-Capybara-Csrf: 1，JSON body 带 content-type", async () => {
    const calls = stubFetch(json(200, { ok: true }));
    await expect(
      apiFetch<{ ok: boolean }>("/api/v1/thing", { method: "POST", body: "{}" }),
    ).resolves.toEqual({ ok: true });
    expect(calls[0]?.headers.get("x-capybara-csrf")).toBe("1");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
  });

  it("GET 不带 CSRF 头", async () => {
    const calls = stubFetch(json(200, { a: 1 }));
    await apiFetch("/api/v1/me");
    expect(calls[0]?.headers.has("x-capybara-csrf")).toBe(false);
  });

  it("204 -> undefined", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(apiFetch("/api/v1/x", { method: "PUT" })).resolves.toBeUndefined();
  });

  it("401 auth.token_expired -> refresh 一次后重试成功", async () => {
    const calls = stubFetch(expired(), new Response(null, { status: 204 }), json(200, { me: 1 }));
    await expect(apiFetch("/api/v1/me")).resolves.toEqual({ me: 1 });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET /api/v1/me",
      "POST /api/v1/auth/refresh",
      "GET /api/v1/me",
    ]);
    expect(calls[1]?.headers.get("x-capybara-csrf")).toBe("1");
  });

  it("401 auth.required（cap_at Cookie 已随过期被浏览器丢弃）-> 同样先 refresh", async () => {
    const calls = stubFetch(
      json(401, { error: { code: "auth.required", message: "x" } }),
      new Response(null, { status: 204 }),
      json(200, { me: 1 }),
    );
    await expect(apiFetch("/api/v1/me")).resolves.toEqual({ me: 1 });
    expect(calls).toHaveLength(3);
  });

  it("认证端点自身的 401 不触发 refresh", async () => {
    const calls = stubFetch(json(401, { error: { code: "auth.required", message: "x" } }));
    await expect(apiFetch("/api/v1/auth/logout", { method: "POST" })).rejects.toMatchObject({
      code: "auth.required",
    });
    expect(calls).toHaveLength(1);
  });

  it("并发请求同时过期 -> 共用一次 refresh", async () => {
    const calls = stubFetch(
      expired(),
      expired(),
      new Response(null, { status: 204 }),
      json(200, { n: 1 }),
      json(200, { n: 2 }),
    );
    await Promise.all([apiFetch("/api/v1/a"), apiFetch("/api/v1/b")]);
    expect(calls.filter((c) => c.url === "/api/v1/auth/refresh")).toHaveLength(1);
  });

  it("refresh 失败 -> 抛 ApiClientError（带状态码与错误码），不再重试", async () => {
    const calls = stubFetch(
      expired(),
      json(401, { error: { code: "auth.refresh_invalid", message: "bad refresh" } }),
    );
    const err = await apiFetch("/api/v1/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiClientError);
    expect(err).toMatchObject({ status: 401, code: "auth.refresh_invalid" });
    expect(calls).toHaveLength(2);
  });

  it("重试后仍 token_expired -> 只 refresh 一次，抛错", async () => {
    const calls = stubFetch(expired(), new Response(null, { status: 204 }), expired());
    await expect(apiFetch("/api/v1/me")).rejects.toMatchObject({
      status: 401,
      code: "auth.token_expired",
    });
    expect(calls).toHaveLength(3);
  });

  it("其它错误 -> ApiClientError { status, code, message }", async () => {
    stubFetch(json(401, { error: { code: "auth.invalid_credentials", message: "Invalid" } }));
    await expect(apiFetch("/api/v1/auth/login", { method: "POST" })).rejects.toMatchObject({
      status: 401,
      code: "auth.invalid_credentials",
      message: "Invalid",
    });
  });

  it("非 JSON 错误响应 -> code http_error", async () => {
    stubFetch(new Response("<html>bad gateway</html>", { status: 502 }));
    await expect(apiFetch("/api/v1/me")).rejects.toMatchObject({
      status: 502,
      code: "http_error",
    });
  });

  it("网络错误 -> code network，status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(apiFetch("/api/v1/me")).rejects.toMatchObject({ status: 0, code: "network" });
  });
});
