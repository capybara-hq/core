import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
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
]);

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** 错误信封里的 code；body 不是 JSON（如 204 空 body）时为 undefined。 */
function errorCode(body: string): string | undefined {
  try {
    return (JSON.parse(body) as { error?: { code?: string } } | null)?.error?.code;
  } catch {
    return undefined;
  }
}

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
}, 120_000);
afterAll(async () => {
  await k?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("默认拒绝：公开路由清单", () => {
  it("清单外的路由不带凭据 → 401 auth.required；清单内的不是", async () => {
    const routes = k.http
      .routes()
      .filter(
        (r) => !r.url.startsWith("/plugins/") && r.method !== "HEAD" && r.method !== "OPTIONS",
      );
    // 至少要覆盖到内核 API，否则这道测试形同虚设
    expect(routes.some((r) => r.url.startsWith("/api/v1/"))).toBe(true);
    const seen = new Set<string>();
    const violations: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.url}`;
      seen.add(key);
      const url = r.url.replace(/:[^/]+/g, ZERO_UUID);
      const res = await k.http.inject({
        method: r.method as "GET",
        url,
        headers: { "x-capybara-csrf": "1" },
      });
      const code = errorCode(res.body);
      const denied = res.statusCode === 401 && code === "auth.required";
      if (PUBLIC_ROUTES.has(key) && denied) {
        violations.push(`${key}: listed as public but returned 401 auth.required`);
      }
      if (!PUBLIC_ROUTES.has(key) && !denied) {
        violations.push(
          `${key}: not in PUBLIC_ROUTES but returned ${res.statusCode} ${code ?? ""}`,
        );
      }
    }
    for (const p of PUBLIC_ROUTES) {
      if (!seen.has(p)) violations.push(`${p}: listed in PUBLIC_ROUTES but no such route`);
    }
    expect(violations).toEqual([]);
  });
});
