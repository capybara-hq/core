import {
  assertValidDeclarations,
  type ExtensionPointRef,
  type ModelInfoV1,
  type ModelParameter,
  type ModelProvider,
  type ModelProviderV1,
  type ModelRequest,
  type ModelRequestV1,
  type ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ApiError } from "../../src/errors.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { ProviderListError, type ProviderRegistry } from "../../src/runtime/providers.js";
import { fakeBCalls, MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { providerRegistryFor } from "../helpers/runtime.js";

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
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  redis = new Redis(rd.url);
  registry = providerRegistryFor(k.host, redis);
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

  it("listModels 结果缓存在 Redis cache:capk:models:<provider>:v<契约主版本>，EX 600；第二次不再访问供应商", async () => {
    const before = fakeBCalls(k.host);
    await registry.list();
    await registry.list();
    expect(fakeBCalls(k.host) - before).toBe(1);
    const [keyB] = await redis.keys("cache:capk:models:model-fake-b:v2:*");
    const [keyA] = await redis.keys("cache:capk:models:model-fake:v2:*");
    const ttl = await redis.ttl(keyB as string);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await redis.ttl(keyA as string)).toBeGreaterThan(590);
  });

  it("缓存键带插件版本与部署配置摘要（cache:capk:models:<provider>:v<主版本>:<版本>:<摘要>），不含配置明文", async () => {
    await registry.list();
    const entry = k.host.list("model-provider").find((p) => p.plugin === "model-fake-b");
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(entry?.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(await redis.keys("cache:capk:models:model-fake-b:*")).toEqual([
      `cache:capk:models:model-fake-b:v2:${entry?.version}:${entry?.configHash}`,
    ]);
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

  describe("供应商 listModels 失败", () => {
    const broken: ModelProvider = {
      async listModels() {
        throw new Error("upstream down");
      },
      stream() {
        throw new Error("unused");
      },
    };
    const warns: { msg: string; fields: unknown }[] = [];
    const withBroken = () =>
      providerRegistryFor(
        {
          list: (cap: string) => [
            ...k.host.list(cap),
            { plugin: "broken", capability: "model-provider@2" as const, impl: broken },
          ],
        },
        redis,
        {
          warn: (msg: string, fields?: Record<string, unknown>) => {
            warns.push({ msg, fields });
          },
        },
      );

    it("list 跳过失败的供应商并记 warn，其余照常列出", async () => {
      warns.length = 0;
      const providers = await withBroken().list();
      expect(providers.map((p) => p.provider)).toEqual(["model-fake", "model-fake-b"]);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toMatch(/listModels failed/);
    });

    it("resolve 时供应商失败 → ProviderListError（仍是 agent.model_unavailable，带 cause）", async () => {
      const err = await withBroken()
        .resolve({ provider: "broken", model: "x" })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderListError);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("agent.model_unavailable");
      expect((err as ProviderListError).provider).toBe("broken");
      expect(((err as ProviderListError).cause as Error).message).toBe("upstream down");
    });

    it("卡住的供应商按时限算失败，不拖住列表；列表视图短时间内不再请求它，resolve 照常请求", async () => {
      let calls = 0;
      const hung: ModelProvider = {
        listModels() {
          calls++;
          return new Promise(() => {});
        },
        stream() {
          throw new Error("unused");
        },
      };
      const reg = providerRegistryFor(
        {
          list: (cap: string) => [
            ...k.host.list(cap),
            { plugin: "hung", capability: "model-provider@2" as const, impl: hung },
          ],
        },
        redis,
        undefined,
        { listTimeoutMs: 200 },
      );
      const started = Date.now();
      const first = await reg.listWithStatus();
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(first.map((p) => [p.provider, p.status])).toEqual([
        ["model-fake", "ok"],
        ["model-fake-b", "ok"],
        ["hung", "error"],
      ]);
      expect(calls).toBe(1);
      expect((await reg.listWithStatus()).find((p) => p.provider === "hung")?.status).toBe("error");
      expect(calls).toBe(1);
      expect(await redis.ttl("capk:models-failed:hung:v2:-:-")).toBeGreaterThan(0);
      const err = await reg.resolve({ provider: "hung", model: "x" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderListError);
      expect(calls).toBe(2);
    });
  });
});

describe("model-provider@1 / @2", () => {
  const v1Info = (id: string, effort: boolean): ModelInfoV1 => ({
    id,
    displayName: id,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: effort,
      caching: false,
      midConversationSystem: false,
      effort,
    },
  });
  const done: ModelStreamEvent = {
    type: "message_complete",
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  };
  const v1 = (models: ModelInfoV1[]) => {
    const seen: ModelRequestV1[] = [];
    const impl: ModelProviderV1 = {
      async listModels() {
        return models;
      },
      async *stream(req) {
        seen.push(req);
        yield done;
      },
    };
    return { impl, seen };
  };
  const v2Params: ModelParameter[] = [
    {
      key: "effort",
      standard: "effort",
      schema: { type: "string", enum: ["low", "high"] },
      default: "low",
      label: { zh: "思考深度", en: "Effort" },
    },
    { key: "p2.style", schema: { type: "boolean" }, label: { zh: "风格", en: "Style" } },
  ];
  const v2 = (parameters: ModelParameter[] = v2Params) => {
    const seen: ModelRequest[] = [];
    let calls = 0;
    const impl: ModelProvider = {
      async listModels() {
        calls++;
        const { capabilities, ...rest } = v1Info("v2-model", false);
        const { effort: _deprecated, ...caps } = capabilities;
        return [{ ...rest, capabilities: caps, parameters }];
      },
      async *stream(req) {
        seen.push(req);
        yield done;
      },
    };
    return { impl, seen, calls: () => calls };
  };
  const reg = (
    entries: {
      plugin: string;
      capability: ExtensionPointRef;
      impl: unknown;
      version?: string;
      configHash?: string;
    }[],
    warns: unknown[] = [],
  ) =>
    providerRegistryFor({ list: () => entries }, redis, {
      warn: (msg: string) => {
        warns.push(msg);
      },
    });
  const req = (params: ModelRequest["params"]): ModelRequest => ({
    model: "m",
    system: [],
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    tools: [],
    maxOutputTokens: 100,
    params,
  });
  const signal = () => ({ signal: new AbortController().signal });
  const drain = async (it: AsyncIterable<ModelStreamEvent>) => {
    for await (const _ of it);
  };

  it("ExtensionHost.list carries the extension point ref (with major version)", () => {
    const entries = k.host.list("model-provider");
    expect(entries.map((e) => [e.plugin, e.capability])).toEqual([
      ["model-fake", "model-provider@2"],
      ["model-fake-b", "model-provider@2"],
    ]);
  });

  it("@1 适配：capabilities.effort 为真 → parameters 含五档 effort（不给默认值），否则为空", async () => {
    const { impl } = v1([v1Info("e", true), v1Info("n", false)]);
    const r = reg([{ plugin: "old", capability: "model-provider@1", impl }]);
    const [entry] = await r.list();
    const [e, n] = entry?.models ?? [];
    expect(e?.parameters).toEqual([
      {
        key: "effort",
        standard: "effort",
        schema: { type: "string", enum: ["low", "medium", "high", "xhigh", "max"] },
        label: { zh: "思考深度", en: "Effort" },
      },
    ]);
    expect(n?.parameters).toEqual([]);
    expect(() => assertValidDeclarations("old", e?.parameters ?? [])).not.toThrow();
    const resolved = await r.resolve({ provider: "old", model: "e" });
    expect(resolved.info.parameters).toEqual(e?.parameters);
  });

  it("@1 适配：stream 把 params.effort 映射为 req.effort，其余参数丢弃", async () => {
    const { impl, seen } = v1([v1Info("e", true)]);
    const r = reg([{ plugin: "old", capability: "model-provider@1", impl }]);
    const { provider } = await r.resolve({ provider: "old", model: "e" });
    await drain(provider.stream(req({ effort: "low", "old.x": 1 }), signal()));
    expect(seen).toHaveLength(1);
    expect(seen[0]?.effort).toBe("low");
    expect(seen[0]).not.toHaveProperty("params");
    // 没有 params.effort 时保留请求自带的 effort（Task 20 之前内核仍直接设置 req.effort）
    await drain(provider.stream({ ...req({}), effort: "max" }, signal()));
    expect(seen[1]?.effort).toBe("max");
    expect(seen[1]).not.toHaveProperty("params");
    // @1 没有 toolChoice：不传给旧插件
    await drain(provider.stream({ ...req({}), toolChoice: "none" }, signal()));
    expect(seen[2]).not.toHaveProperty("toolChoice");
  });

  it("@2：模型信息与请求原样透传", async () => {
    const p = v2();
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const { provider, info } = await r.resolve({ provider: "p2", model: "v2-model" });
    expect(info.parameters).toEqual(v2Params);
    const sent = req({ effort: "high", "p2.style": true });
    await drain(provider.stream(sent, signal()));
    expect(p.seen).toEqual([sent]);
  });

  it("同一插件同时提供 @1 与 @2 时用 @2", async () => {
    const old = v1([v1Info("legacy", true)]);
    const p = v2();
    const r = reg([
      { plugin: "p2", capability: "model-provider@1", impl: old.impl },
      { plugin: "p2", capability: "model-provider@2", impl: p.impl },
    ]);
    const providers = await r.list();
    expect(providers.map((x) => [x.provider, x.models.map((m) => m.id)])).toEqual([
      ["p2", ["v2-model"]],
    ]);
    const { provider } = await r.resolve({ provider: "p2", model: "v2-model" });
    await drain(provider.stream(req({}), signal()));
    expect(p.seen).toHaveLength(1);
    expect(old.seen).toHaveLength(0);
  });

  it("@2 声明不合规：list 跳过并记 warn；resolve → agent.model_unavailable（不可重试）；不写缓存", async () => {
    const bad = v2([
      { key: "style", schema: { type: "boolean" }, label: { zh: "风格", en: "Style" } },
    ]);
    const warns: unknown[] = [];
    const r = reg(
      [
        { plugin: "p2", capability: "model-provider@2", impl: bad.impl },
        { plugin: "old", capability: "model-provider@1", impl: v1([v1Info("b", false)]).impl },
      ],
      warns,
    );
    expect((await r.list()).map((x) => x.provider)).toEqual(["old"]);
    expect(warns).toHaveLength(1);
    const err = await r.resolve({ provider: "p2", model: "v2-model" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ProviderListError);
    expect((err as ApiError).code).toBe("agent.model_unavailable");
    expect(((err as ApiError).cause as Error).message).toMatch(/"style"/);
    expect(await redis.exists("cache:capk:models:p2:v2:-:-")).toBe(0);
  });

  it("an older kernel's entry under the pre-@Cacheable key is ignored: the list is cached under the new key", async () => {
    // what an older kernel wrote (a raw `@1` shape, under its old key)
    await redis.set("capk:models:p2:v2:-:-", JSON.stringify([{ id: "stale" }]), "EX", 600);
    const p = v2();
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const [entry] = await r.list();
    expect(entry?.models.map((m) => m.id)).toEqual(["v2-model"]);
    expect(p.calls()).toBe(1);
    // cached under the new key (`@Cacheable`), which the next list reads
    const cached = JSON.parse((await redis.get("cache:capk:models:p2:v2:-:-")) ?? "null");
    expect(cached.map((m: { id: string }) => m.id)).toEqual(["v2-model"]);
    expect(await redis.ttl("cache:capk:models:p2:v2:-:-")).toBeGreaterThan(0);
    await r.list();
    expect(p.calls()).toBe(1);
    // the old key is neither read nor rewritten
    expect(JSON.parse((await redis.get("capk:models:p2:v2:-:-")) ?? "null")).toEqual([
      { id: "stale" },
    ]);
  });

  it("插件从 @1 升级到 @2：不读 @1 时写入的缓存（键带契约主版本）", async () => {
    const old = reg([
      { plugin: "p2", capability: "model-provider@1", impl: v1([v1Info("v2-model", true)]).impl },
    ]);
    const [before] = await old.list();
    expect(before?.models[0]?.parameters.map((d) => d.key)).toEqual(["effort"]);
    expect(await redis.exists("cache:capk:models:p2:v1:-:-")).toBe(1);
    const p = v2();
    const upgraded = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const [after] = await upgraded.list();
    expect(after?.models[0]?.parameters).toEqual(v2Params);
    expect(p.calls()).toBe(1);
  });

  it("插件版本或部署配置变化 → 缓存未命中，重新列模型（升级后不按旧声明校验）", async () => {
    const p = v2();
    const at = (version: string, configHash: string) =>
      reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl, version, configHash }]);
    await at("1.0.0", "aaaa").list();
    expect(p.calls()).toBe(1);
    await at("1.0.0", "aaaa").list();
    expect(p.calls()).toBe(1);
    await at("1.1.0", "aaaa").list();
    expect(p.calls()).toBe(2);
    await at("1.1.0", "bbbb").list();
    expect(p.calls()).toBe(3);
  });

  it("不支持的主版本被忽略并记 warn", async () => {
    const warns: unknown[] = [];
    const r = reg([{ plugin: "future", capability: "model-provider@3", impl: v2().impl }], warns);
    expect(await r.list()).toEqual([]);
    expect(warns.length).toBeGreaterThan(0);
    expect(await codeOf(r.resolve({ provider: "future", model: "v2-model" }))).toBe(
      "agent.model_unavailable",
    );
  });
});
