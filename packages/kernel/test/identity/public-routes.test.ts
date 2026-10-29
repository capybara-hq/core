import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import {
  type CallHandler,
  type ExecutionContext,
  Global,
  Module,
  type NestInterceptor,
} from "@nestjs/common";
import { APP_INTERCEPTOR } from "@nestjs/core";
import type { FastifyRequest } from "fastify";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { createKeyring } from "../../src/ctx/secrets.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiModule } from "../../src/http/api.module.js";
import { createHttpApp, type KernelHttpApp } from "../../src/http/app.js";
import { CacheService } from "../../src/infra/cache/cache.service.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import { KernelEvents } from "../../src/infra/events/kernel-events.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { QueueModule } from "../../src/infra/queue/queue.module.js";
import { CredentialThrottler } from "../../src/infra/throttler/credential-throttler.js";
import {
  KERNEL_BUS,
  KERNEL_LOGGER,
  KEYRING,
  REDIS,
  REDIS_SUBSCRIBER,
} from "../../src/infra/tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { LegacyPorts } from "../../src/lifecycle/legacy-ports.js";
import { KERNEL_APP_OPTIONS } from "../../src/lifecycle/tokens.js";
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
let k: Kernel;
let probed: KernelHttpApp;
let raw: ReturnType<typeof createDb>;
let redis: Redis;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const masterKey = Buffer.alloc(32, 7).toString("base64");
  const log = createLogger("error", { write: () => {} });
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey,
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    { env: {}, logger: log },
  );
  await k.start();
  // 同一套 ApiModule 再起一个带探针拦截器的 HTTP 应用（内核已完成迁移，共用插件宿主与组织插件配置）
  raw = createDb(pgc.url, 5);
  redis = new Redis(rd.url);
  const probeBus = { publish: async () => {} };
  class ProbeModule {}
  // The infra tokens the API and the converted domain modules read, global like the infra
  // modules in the kernel (the kernel's own instances: same pool, config and ports)
  const shared = [
    KernelDb,
    TransactionHost,
    XactLock,
    KernelConfigService,
    LockService,
    LegacyPorts,
    KernelEvents,
    CredentialThrottler,
    CacheService,
  ];
  Global()(ProbeModule);
  Module({
    // the BullMQ root configuration the orgs module's queue registration reads
    imports: [QueueModule.forRoot()],
    providers: [
      { provide: KERNEL_LOGGER, useValue: log },
      { provide: REDIS, useValue: redis },
      { provide: KERNEL_BUS, useValue: probeBus },
      { provide: KEYRING, useValue: k.app.get(KEYRING) },
      // the extensions module's own (unloaded) host reads these
      { provide: REDIS_SUBSCRIBER, useValue: k.app.get(REDIS_SUBSCRIBER) },
      { provide: KERNEL_APP_OPTIONS, useValue: {} },
      ...shared.map((c) => ({ provide: c, useValue: k.app.get(c as never) })),
    ],
    exports: [
      KERNEL_LOGGER,
      REDIS,
      REDIS_SUBSCRIBER,
      KERNEL_BUS,
      KEYRING,
      KERNEL_APP_OPTIONS,
      ...shared,
    ],
  })(ProbeModule);
  probed = await createHttpApp({
    log,
    health: { isStopping: () => false, log, checks: {} },
    serveApi: true,
    servePlugins: false,
    gateway: {
      webhooks: { handle: async () => ({ status: 404, body: "" }) },
      webhookMaxBodyBytes: 1024,
    },
    apiModule: {
      module: ProbeModule,
      imports: [
        ApiModule.register({
          db: kernelDb(raw),
          keyring: createKeyring(Buffer.from(masterKey, "base64"), []),
          config: () => k.config,
          log,
          channels: k.channels.connections,
          evalQueue: { enqueue: async () => {} },
        }),
      ],
      providers: [{ provide: APP_INTERCEPTOR, useValue: probe }],
    },
  });
}, 120_000);
afterAll(async () => {
  await probed?.close();
  redis?.disconnect();
  await raw?.destroy();
  await k?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const apiRoutes = (routes: { method: string; url: string }[]) =>
  routes
    .filter((r) => !r.url.startsWith("/plugins/") && r.method !== "HEAD" && r.method !== "OPTIONS")
    .map((r) => `${r.method} ${r.url}`)
    .sort();

describe("默认拒绝：公开路由清单", () => {
  it("探针应用与内核的路由集合一致", () => {
    expect(apiRoutes(probed.routes())).toEqual(apiRoutes(k.http.routes()));
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
