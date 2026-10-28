import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Body, Controller, Get, HttpCode, type INestApplication, Post } from "@nestjs/common";
import { APP_FILTER, NestFactory } from "@nestjs/core";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/config/load.js";
import { createKernelAdapter } from "../../src/http/adapter.js";
import { ErrorFilter } from "../../src/http/error.filter.js";
import { ConfigModule } from "../../src/infra/config/config.module.js";
import { LoggingModule } from "../../src/infra/logging/logging.module.js";
import { RedisModule } from "../../src/infra/redis/redis.module.js";
import { NAMED_THROTTLERS, throttlerKey } from "../../src/infra/throttler/named-throttlers.js";
import { RedisThrottlerStorage } from "../../src/infra/throttler/redis-throttler-storage.js";
import { Throttled } from "../../src/infra/throttler/throttler.guard.js";
import { KernelThrottlerModule } from "../../src/infra/throttler/throttler.module.js";
import { KERNEL_LOGGER, REDIS } from "../../src/infra/tokens.js";
import { createLogger, type KernelLogger } from "../../src/log.js";

let rd: TestContainer;
beforeAll(async () => {
  rd = await startTestRedis();
}, 120_000);
afterAll(async () => {
  await rd?.stop();
}, 120_000);

@Controller()
class TestController {
  @Post("login")
  @HttpCode(200)
  @Throttled("login", "login-ip", "login-account")
  login(@Body() _b: unknown) {
    return { ok: true };
  }

  @Post("invitations/:token/accept")
  @HttpCode(200)
  @Throttled("invitation", "invitation-ip")
  accept() {
    return { ok: true };
  }

  @Post("setup")
  @HttpCode(200)
  @Throttled("setup-token", "setup-ip")
  setup() {
    return { ok: true };
  }

  @Get("free")
  free() {
    return { ok: true };
  }
}

async function boot(trustProxy: boolean | string[] = false) {
  const config = resolveConfig(
    {
      db: { url: "postgres://unused/unused" },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 1).toString("base64"),
    },
    {},
  );
  const logger = createLogger("error") as KernelLogger;
  const warn = vi.spyOn(logger, "warn");
  const error = vi.spyOn(logger, "error");
  class Root {}
  const app = await NestFactory.create<NestFastifyApplication>(
    {
      module: Root,
      imports: [
        LoggingModule.forRoot(config, { logger }),
        ConfigModule.forRoot(config),
        RedisModule,
        KernelThrottlerModule,
      ],
      controllers: [TestController],
      providers: [{ provide: APP_FILTER, useClass: ErrorFilter }],
    },
    createKernelAdapter(trustProxy),
    { logger: false, abortOnError: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  const redis = app.get<Redis>(REDIS);
  await redis.flushall();
  return { app: app as INestApplication & NestFastifyApplication, redis, warn, error };
}

type Booted = Awaited<ReturnType<typeof boot>>;
const post = (
  r: Booted,
  url: string,
  payload: unknown,
  remoteAddress = "10.0.0.1",
  headers: Record<string, string> = {},
) => r.app.inject({ method: "POST", url, payload: payload as object, remoteAddress, headers });

describe("named throttlers on the Redis storage", () => {
  it("login: the 11th attempt of one (login, IP) is 429 with today's body and retry-after", async () => {
    const r = await boot();
    try {
      for (let i = 0; i < 10; i++) {
        expect((await post(r, "/login", { login: "alice" })).statusCode).toBe(200);
      }
      const res = await post(r, "/login", { login: "alice" });
      expect(res.statusCode).toBe(429);
      expect(res.json()).toEqual({
        error: {
          code: "auth.rate_limited",
          message: "Too many failed login attempts; try again later",
        },
      });
      const retry = Number(res.headers["retry-after"]);
      expect(retry).toBeGreaterThan(0);
      expect(retry).toBeLessThanOrEqual(900);
      // no x-ratelimit headers: the kernel sends none today
      expect(Object.keys(res.headers).filter((h) => h.startsWith("x-ratelimit"))).toEqual([]);
      // the success path of a limited request still answers the same
      expect((await post(r, "/login", { login: "alice" })).statusCode).toBe(429);
    } finally {
      await r.app.close();
    }
  });

  it("separate (login, IP) pairs are counted separately; case and space variants share a count", async () => {
    const r = await boot();
    try {
      for (let i = 0; i < 10; i++) await post(r, "/login", { login: "alice" }, "10.0.0.1");
      expect((await post(r, "/login", { login: "alice" }, "10.0.0.1")).statusCode).toBe(429);
      // the owner from another IP, and another login from the same IP, are unaffected (R25)
      expect((await post(r, "/login", { login: "alice" }, "10.0.0.2")).statusCode).toBe(200);
      expect((await post(r, "/login", { login: "bob" }, "10.0.0.1")).statusCode).toBe(200);
      // variants of the login are the same pair
      expect((await post(r, "/login", { login: "  ALICE " }, "10.0.0.1")).statusCode).toBe(429);
    } finally {
      await r.app.close();
    }
  });

  it("login-ip (50 per IP) and login-account (100 per login across IPs) also limit", async () => {
    const r = await boot();
    try {
      for (let i = 0; i < 50; i++) {
        expect((await post(r, "/login", { login: `user${i}` }, "10.0.0.9")).statusCode).toBe(200);
      }
      expect((await post(r, "/login", { login: "fresh" }, "10.0.0.9")).statusCode).toBe(429);
      expect((await post(r, "/login", { login: "fresh" }, "10.0.0.8")).statusCode).toBe(200);
      // one login from 100 different IPs
      const r2 = await Promise.all(
        Array.from({ length: 101 }, (_, i) =>
          post(r, "/login", { login: "victim" }, `10.1.0.${i + 1}`),
        ),
      );
      expect(r2.filter((x) => x.statusCode === 429)).toHaveLength(1);
    } finally {
      await r.app.close();
    }
  });

  it("a rejected attempt does not count; concurrent attempts never pass the limit", async () => {
    const r = await boot();
    try {
      const rs = await Promise.all(
        Array.from({ length: 30 }, () => post(r, "/login", { login: "alice" })),
      );
      expect(rs.filter((x) => x.statusCode === 200)).toHaveLength(10);
      expect(rs.filter((x) => x.statusCode === 429)).toHaveLength(20);
      const key = `throttler:{${throttlerKey("login", NAMED_THROTTLERS[0]?.getTracker({ body: { login: "alice" }, ip: "10.0.0.1" } as never) ?? "")}}:login`;
      expect(await r.redis.get(key)).toBe("10");
    } finally {
      await r.app.close();
    }
  });

  it("counters carry the window TTL and every key has a hash tag", async () => {
    const r = await boot();
    try {
      await post(r, "/login", { login: "alice" });
      const keys = await r.redis.keys("throttler:*");
      expect(keys).toHaveLength(3);
      for (const k of keys) {
        expect(k).toMatch(/^throttler:\{[0-9a-f]{64}\}:login(-ip|-account)?$/);
        const ttl = await r.redis.pttl(k);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(900_000);
      }
    } finally {
      await r.app.close();
    }
  });

  it("invitation, setup: route params and constants; other routes are never counted", async () => {
    const r = await boot();
    try {
      for (let i = 0; i < 10; i++) await post(r, "/invitations/tok-a/accept", {});
      const limited = await post(r, "/invitations/tok-a/accept", {});
      expect(limited.statusCode).toBe(429);
      expect(limited.json().error.message).toBe("Too many invitation attempts; try again later");
      expect((await post(r, "/invitations/tok-b/accept", {})).statusCode).toBe(200);
      for (let i = 0; i < 10; i++) await post(r, "/setup", {});
      const s = await post(r, "/setup", {});
      expect(s.statusCode).toBe(429);
      expect(s.json().error.message).toBe("Too many setup attempts; try again later");
      const before = await r.redis.dbsize();
      for (let i = 0; i < 5; i++) {
        expect((await r.app.inject({ method: "GET", url: "/free" })).statusCode).toBe(200);
      }
      expect(await r.redis.dbsize()).toBe(before);
    } finally {
      await r.app.close();
    }
  });

  it("trackers read request.ip: the socket address, or the forwarded one behind a trusted proxy", async () => {
    const direct = await boot(false);
    try {
      for (let i = 0; i < 10; i++) {
        await post(direct, "/login", { login: "a" }, "10.0.0.1", {
          "x-forwarded-for": `9.9.9.${i}`,
        });
      }
      // untrusted x-forwarded-for cannot dodge the limit
      expect(
        (
          await post(direct, "/login", { login: "a" }, "10.0.0.1", {
            "x-forwarded-for": "9.9.9.99",
          })
        ).statusCode,
      ).toBe(429);
    } finally {
      await direct.app.close();
    }
    const proxied = await boot(["10.0.0.1"]);
    try {
      for (let i = 0; i < 10; i++) {
        await post(proxied, "/login", { login: "a" }, "10.0.0.1", { "x-forwarded-for": "9.9.9.1" });
      }
      const h = { "x-forwarded-for": "9.9.9.1" };
      expect((await post(proxied, "/login", { login: "a" }, "10.0.0.1", h)).statusCode).toBe(429);
      expect(
        (
          await post(proxied, "/login", { login: "a" }, "10.0.0.1", {
            "x-forwarded-for": "9.9.9.2",
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await proxied.app.close();
    }
  });

  it("a body without a login still counts (per IP); no body does not crash", async () => {
    const r = await boot();
    try {
      expect((await post(r, "/login", undefined)).statusCode).toBe(200);
      expect((await post(r, "/login", { login: 42 })).statusCode).toBe(200);
    } finally {
      await r.app.close();
    }
  });

  it("Redis down: the request is allowed and a warning (not an error) is logged", async () => {
    const r = await boot();
    try {
      const spy = vi.spyOn(r.redis, "eval").mockRejectedValue(new Error("connection lost"));
      for (let i = 0; i < 15; i++) {
        expect((await post(r, "/login", { login: "alice" })).statusCode).toBe(200);
      }
      expect(r.warn).toHaveBeenCalledWith(
        expect.stringContaining("fail-open"),
        expect.objectContaining({ throttler: "login" }),
      );
      expect(r.error).not.toHaveBeenCalled();
      spy.mockRestore();
    } finally {
      await r.app.close();
    }
  });
});

describe("named throttler table", () => {
  it("the change-password tracker counts per account (principal), not per IP", () => {
    const t = NAMED_THROTTLERS.find((x) => x.name === "change-password");
    const req = (id: string, ip: string) => ({ principal: { account: { id } }, ip }) as never;
    expect(t?.getTracker(req("a1", "10.0.0.1"))).toBe(t?.getTracker(req("a1", "10.0.0.2")));
    expect(t?.getTracker(req("a1", "10.0.0.1"))).not.toBe(t?.getTracker(req("a2", "10.0.0.1")));
  });

  it("mirrors today's limits and windows, in check order", () => {
    expect(NAMED_THROTTLERS.map((x) => [x.name, x.limit, x.ttl])).toEqual([
      ["login", 10, 900_000],
      ["login-ip", 50, 900_000],
      ["login-account", 100, 900_000],
      ["change-password", 10, 900_000],
      ["change-password-ip", 50, 900_000],
      ["setup-token", 100, 900_000],
      ["setup-ip", 10, 900_000],
      ["invitation", 10, 900_000],
      ["invitation-ip", 20, 900_000],
    ]);
  });
});

describe("RedisThrottlerStorage reset / refund", () => {
  it("reset deletes the counter, refund gives one attempt back and never goes below zero", async () => {
    const r = await boot();
    try {
      const log = createLogger("error") as KernelLogger;
      const s = new RedisThrottlerStorage(r.redis, log);
      for (let i = 0; i < 3; i++) await s.increment("k", 60_000, 10, 0, "t");
      await s.refund("k", "t");
      expect((await s.increment("k", 60_000, 10, 0, "t")).totalHits).toBe(3);
      await s.reset("k", "t");
      expect(await r.redis.exists("throttler:{k}:t")).toBe(0);
      await s.refund("k", "t");
      expect(await r.redis.exists("throttler:{k}:t")).toBe(0);
      // the counter always has a TTL, even after a refund
      await s.increment("k", 60_000, 10, 0, "t");
      await s.refund("k", "t");
      await s.refund("k", "t");
      expect(await r.redis.exists("throttler:{k}:t")).toBe(0);
    } finally {
      await r.app.close();
    }
  });
});
