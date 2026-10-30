import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import type { CallHandler, ExecutionContext, NestInterceptor } from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeKernelApp, createKernelApp } from "../../src/app.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelHttpApp } from "../../src/http/app.js";
import { KernelLifecycle } from "../../src/lifecycle/kernel-lifecycle.js";
import { createLogger } from "../../src/log.js";

/**
 * 公开路由清单（`METHOD /path`）：不带凭据也不会得到 401 `auth.required` 的路由。
 * 新增公开路由（`@Public()`）时必须同时改这份清单——这道元测试保证全局 AuthGuard 默认拒绝。
 */
const PUBLIC_ROUTES = new Set([
  "GET /healthz",
  "GET /readyz",
  "POST /api/v1/auth/login",
  "POST /api/v1/auth/refresh",
  "POST /api/v1/auth/logout",
  "GET /api/v1/invitations/:token",
  "POST /api/v1/invitations/:token/accept",
  "GET /api/v1/setup",
  "POST /api/v1/setup",
  "GET /api/v1/oauth/callback",
  "GET /api/v1/auth/sources",
  "GET /api/v1/auth/sso/:plugin/start",
  "GET /api/v1/auth/sso/:plugin/callback",
  // Gateway role: raw Fastify route outside Nest (P-4); the channel plugin verifies signatures
  "POST /channels/webhook/:connectionId",
]);

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";
const PROBE_HEADER = "x-probe-id";

/** 错误信封里的 code；body 不是 JSON（如 204 空 body）时为 undefined。 */
function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } } | null)?.error?.code;
  } catch {
    return undefined;
  }
}

/**
 * 探针拦截器（`APP_INTERCEPTOR`）：拦截器只在全部守卫放行后、handler 之前执行。
 * 记下每个请求是否走到了 handler，以及当时 `req.principal` 是否已由 AuthGuard 写入。
 * 不带凭据的请求走到了非公开路由的 handler，说明守卫没有拒绝——即使 handler 自己抛了 `auth.required`
 * （响应看起来和守卫拒绝一样），也要判失败。
 */
const reached = new Map<string, { principal: boolean }>();
const probe: NestInterceptor = {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    const req = ctx.switchToHttp().getRequest<FastifyRequest>();
    const id = req.headers[PROBE_HEADER];
    if (typeof id === "string") reached.set(id, { principal: req.principal !== undefined });
    return next.handle();
  },
};

let pgc: TestContainer;
let rd: TestContainer;
let app: NestFastifyApplication;
let probed: KernelHttpApp;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  // The kernel application itself (every role: the API, and the gateway's webhook route), with the
  // probe as an application interceptor
  app = await createKernelApp(
    KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey,
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    {
      env: {},
      logger: createLogger("error", { write: () => {} }),
      overrides: [{ provide: APP_INTERCEPTOR, useValue: probe }],
    },
  );
  probed = app.get(KernelLifecycle).http;
}, 120_000);
afterAll(async () => {
  if (app) await closeKernelApp(app);
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const apiRoutes = (routes: { method: string; url: string }[]) =>
  routes
    .filter((r) => !r.url.startsWith("/plugins/") && r.method !== "HEAD" && r.method !== "OPTIONS")
    .map((r) => `${r.method} ${r.url}`)
    .sort();

describe("默认拒绝：公开路由清单", () => {
  it("内核注册了 API 与网关的 webhook 路由", () => {
    const routes = apiRoutes(probed.routes());
    expect(routes).toContain("GET /api/v1/setup");
    expect(routes).toContain("POST /channels/webhook/:connectionId");
  });

  it("清单外的路由不带凭据 → 守卫拒绝（401 auth.required 且 handler 未执行）；清单内的不是 401", async () => {
    const routes = apiRoutes(probed.routes());
    // 至少要覆盖到内核 API，否则这道测试形同虚设
    expect(routes.some((r) => r.includes(" /api/v1/"))).toBe(true);
    const violations: string[] = [];
    const publicReached: string[] = [];
    let n = 0;
    for (const key of routes) {
      const [method, path] = key.split(" ") as [string, string];
      const id = String(n++);
      const res = await probed.inject({
        method: method as "GET",
        url: path.replace(/:[^/]+/g, ZERO_UUID),
        headers: { "x-capybara-csrf": "1", [PROBE_HEADER]: id },
      });
      const code = errorCode(res.body);
      const denied = res.statusCode === 401 && code === "auth.required";
      const hit = reached.get(id);
      if (PUBLIC_ROUTES.has(key)) {
        if (hit) publicReached.push(key);
        if (denied) violations.push(`${key}: listed as public but returned 401 auth.required`);
        continue;
      }
      if (hit) {
        violations.push(
          `${key}: not in PUBLIC_ROUTES but AuthGuard let it through (handler ran, principal ${
            hit.principal ? "set" : "missing"
          }); returned ${res.statusCode} ${code ?? ""}`,
        );
      } else if (!denied) {
        violations.push(
          `${key}: not in PUBLIC_ROUTES but returned ${res.statusCode} ${code ?? ""}`,
        );
      }
    }
    for (const p of PUBLIC_ROUTES) {
      if (!routes.includes(p)) violations.push(`${p}: listed in PUBLIC_ROUTES but no such route`);
    }
    expect(violations).toEqual([]);
    // 探针确实挂上了（否则「handler 未执行」的判断形同虚设）
    expect(publicReached).toContain("GET /api/v1/setup");
  });
});
