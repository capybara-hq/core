import { startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { createLogger } from "../../src/log.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";

let rd: TestContainer;
let redisA: Redis;
let redisB: Redis;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const quiet = createLogger("error", { write: () => {} });
/** The run lock over one Redis client (the provider the kernel injects). */
const lockOn = (redis: Redis) => new ConversationLock(new LockService(redis, quiet));

beforeAll(async () => {
  rd = await startTestRedis({ shared: true });
  redisA = new Redis(rd.url);
  redisB = new Redis(rd.url);
});
afterAll(async () => {
  redisA?.disconnect();
  redisB?.disconnect();
  await rd?.stop();
});
beforeEach(async () => {
  await redisA.flushdb();
});

describe("ConversationLock", () => {
  it("A 持有时 B acquire 返回 null；holder 为 A 的 runId；release 后 B 能拿到", async () => {
    const a = lockOn(redisA);
    const b = lockOn(redisB);
    const lease = await a.acquire("c1", "run-a");
    expect(lease).not.toBeNull();
    expect(await redisA.get("capk:conv-run:c1")).toBe("run-a");
    const ttl = await redisA.pttl("capk:conv-run:c1");
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30_000);
    expect(await b.holder("c1")).toBe("run-a");
    expect(await b.acquire("c1", "run-b")).toBeNull();
    await lease?.release();
    expect(await b.holder("c1")).toBeNull();
    const lb = await b.acquire("c1", "run-b");
    expect(lb).not.toBeNull();
    await lb?.release();
  });

  it("A「崩溃」（停止续租）后 TTL 到期，B 拿到锁；A 之后 release 不影响 B", async () => {
    const a = lockOn(redisA);
    const b = lockOn(redisB);
    const lease = await a.acquire("c2", "run-a", 300);
    expect(lease).not.toBeNull();
    lease?.abandon();
    await sleep(450);
    const lb = await b.acquire("c2", "run-b", 300);
    expect(lb).not.toBeNull();
    await lease?.release();
    expect(await b.holder("c2")).toBe("run-b");
    await lb?.release();
  });

  it("持有期间本地续租：超过 TTL 仍持有", async () => {
    const a = lockOn(redisA);
    const b = lockOn(redisB);
    const lease = await a.acquire("c3", "run-a", 300);
    await sleep(900);
    expect(await b.acquire("c3", "run-b", 300)).toBeNull();
    expect(await b.holder("c3")).toBe("run-a");
    expect(lease?.lost).toBe(false);
    await lease?.release();
    expect(await b.holder("c3")).toBeNull();
  });

  it("续租发现锁已被他人持有 → lost 为 true，停止续租；release 不删别人的锁", async () => {
    const a = lockOn(redisA);
    const lease = await a.acquire("c4", "run-a", 300);
    await redisB.set("capk:conv-run:c4", "run-x", "PX", 5000);
    await sleep(250);
    expect(lease?.lost).toBe(true);
    await lease?.release();
    expect(await a.holder("c4")).toBe("run-x");
  });
});
