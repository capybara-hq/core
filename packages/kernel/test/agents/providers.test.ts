import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ApiError } from "../../src/errors.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { fakeBCalls, MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let redis: Redis;
let registry: ProviderRegistry;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  redis = new Redis(rd.url);
  registry = new ProviderRegistry(k.host, redis);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await redis.flushdb();
});

const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
    return undefined;
  } catch (e) {
    if (e instanceof ApiError) return e.code;
    throw e;
  }
};

describe("ProviderRegistry", () => {
  it("list 列出每个供应商及其模型", async () => {
    const providers = await registry.list();
    expect(providers.map((p) => [p.provider, p.models.map((m) => m.id)])).toEqual([
      ["model-fake", ["fake-1", "fake-2"]],
      ["model-fake-b", ["b-1", "b-2"]],
    ]);
  });

  it("listModels 结果缓存在 Redis capk:models:<provider>，EX 600；第二次不再访问供应商", async () => {
    const before = fakeBCalls(k.host);
    await registry.list();
    await registry.list();
    expect(fakeBCalls(k.host) - before).toBe(1);
    const ttl = await redis.ttl("capk:models:model-fake-b");
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await redis.ttl("capk:models:model-fake")).toBeGreaterThan(590);
  });

  it("resolve 返回供应商实现与模型信息", async () => {
    const r = await registry.resolve({ provider: "model-fake-b", model: "b-2" });
    expect(r.info.id).toBe("b-2");
    expect(typeof r.provider.listModels).toBe("function");
  });

  it("未安装的供应商或不存在的模型 → agent.model_unavailable", async () => {
    expect(await codeOf(registry.resolve({ provider: "nope", model: "fake-1" }))).toBe(
      "agent.model_unavailable",
    );
    expect(await codeOf(registry.resolve({ provider: "model-fake", model: "fake-9" }))).toBe(
      "agent.model_unavailable",
    );
  });
});
