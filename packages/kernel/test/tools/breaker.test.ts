import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { Breaker, breakerKey, breakerOpenMessage } from "../../src/tools/breaker.js";
import { sleep } from "../helpers/runs.js";

let rd: TestContainer;
let redis: Redis;
let tools: Partial<KernelConfig["tools"]> = {};
const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => ({ ...base, tools: { ...base.tools, ...tools } });

beforeAll(async () => {
  rd = await startTestRedis();
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  redis?.disconnect();
  await rd?.stop();
});
beforeEach(async () => {
  tools = {};
  await redis.flushdb();
});

describe("Breaker", () => {
  it("键名为 capk:breaker:<orgId>:<connectorId>", () => {
    expect(breakerKey("o1", "a1")).toBe("capk:breaker:o1:a1");
  });

  it("连续第 5 次失败后打开；打开状态带 TTL；到期后恢复（允许探测）", async () => {
    tools = { breakerFailures: 5, breakerOpenSeconds: 1 };
    const b = new Breaker(redis, config);
    for (let i = 1; i <= 4; i++) {
      expect(await b.failure("o1", "a1")).toBe(i);
      expect((await b.check("o1", "a1")).open).toBe(false);
    }
    // 计数也带 TTL
    expect(await redis.pttl(breakerKey("o1", "a1"))).toBeGreaterThan(0);
    expect(await b.failure("o1", "a1")).toBe(5);
    const open = await b.check("o1", "a1");
    expect(open).toMatchObject({ open: true, failures: 5 });
    expect(open.open && open.retryAfterSeconds).toBe(1);
    expect(await redis.pttl(breakerKey("o1", "a1"))).toBeGreaterThan(0);
    // 另一个连接器不受影响
    expect((await b.check("o1", "a2")).open).toBe(false);
    await sleep(1100);
    expect((await b.check("o1", "a1")).open).toBe(false);
  });

  it("半开时探测失败立即重新打开；成功清零", async () => {
    tools = { breakerFailures: 2, breakerOpenSeconds: 1 };
    const b = new Breaker(redis, config);
    await b.failure("o1", "a1");
    await b.failure("o1", "a1");
    expect((await b.check("o1", "a1")).open).toBe(true);
    await sleep(1100);
    expect((await b.check("o1", "a1")).open).toBe(false);
    await b.failure("o1", "a1");
    expect(await b.check("o1", "a1")).toMatchObject({ open: true, failures: 3 });
    await b.success("o1", "a1");
    expect(await redis.exists(breakerKey("o1", "a1"))).toBe(0);
    expect(await b.failure("o1", "a1")).toBe(1);
  });

  it("成功调用清零连续失败计数", async () => {
    const b = new Breaker(redis, config);
    await b.failure("o1", "a1");
    await b.failure("o1", "a1");
    await b.success("o1", "a1");
    expect(await b.failure("o1", "a1")).toBe(1);
  });

  it("打开时给模型的英文说明", () => {
    expect(breakerOpenMessage("Docs", 5, 42)).toBe(
      "Tool temporarily unavailable: Docs failed 5 times in a row; retry after 42s.",
    );
  });
});
