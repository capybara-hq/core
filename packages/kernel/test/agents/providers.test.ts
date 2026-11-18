import type {
  ExtensionPointRef,
  ModelInfo,
  ModelParameter,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { ApiError } from "../../src/errors.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { ExtensionRegistry } from "../../src/extensions/registry.js";
import { createLogger } from "../../src/log.js";
import { ProviderListError, type ProviderRegistry } from "../../src/runtime/providers.js";
import { fakeBCalls, MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { providerRegistryFor } from "../helpers/runtime.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let redis: Redis;
let registry: ProviderRegistry;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
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
  redis = new Redis(rd.url);
  registry = providerRegistryFor(k.app.get(ExtensionRegistry), redis);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await redis.flushdb();
});

/** Every org follows the platform here (no copies): the registry's org view equals the platform's. */
const ORG = "org-1";

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
    const providers = await registry.list(ORG);
    expect(providers.map((p) => [p.provider, p.models.map((m) => m.id)])).toEqual([
      ["model-fake", ["fake-1", "fake-2"]],
      ["model-fake-b", ["b-1", "b-2"]],
    ]);
  });

  it("listModels 结果缓存在 Redis cache:capk:models:<provider>:f<格式>:…，EX 600；第二次不再访问供应商", async () => {
    const before = fakeBCalls(k.app.get(ExtensionHost));
    await registry.list(ORG);
    await registry.list(ORG);
    expect(fakeBCalls(k.app.get(ExtensionHost)) - before).toBe(1);
    const [keyB] = await redis.keys("cache:capk:models:model-fake-b:f2:*");
    const [keyA] = await redis.keys("cache:capk:models:model-fake:f2:*");
    const ttl = await redis.ttl(keyB as string);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
    expect(await redis.ttl(keyA as string)).toBeGreaterThan(590);
  });

  it("缓存键带插件版本与部署配置摘要（cache:capk:models:<provider>:f<格式>:<版本>:<摘要>），不含配置明文", async () => {
    await registry.list(ORG);
    const entry = k.app
      .get(ExtensionHost)
      .list("model-provider")
      .find((p) => p.plugin === "model-fake-b");
    expect(entry?.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(entry?.configHash).toMatch(/^[0-9a-f]{16}$/);
    expect(await redis.keys("cache:capk:models:model-fake-b:*")).toEqual([
      `cache:capk:models:model-fake-b:f2:${entry?.version}:${entry?.configHash}`,
    ]);
  });

  it("resolve 返回供应商实现与模型信息", async () => {
    const r = await registry.resolve(ORG, { provider: "model-fake-b", model: "b-2" });
    expect(r.info.id).toBe("b-2");
    expect(typeof r.provider.stream).toBe("function");
    expect(r.info.kind).toBe("chat");
  });

  it("未安装的供应商或不存在的模型 → agent.model_unavailable", async () => {
    expect(await codeOf(registry.resolve(ORG, { provider: "nope", model: "fake-1" }))).toBe(
      "agent.model_unavailable",
    );
    expect(await codeOf(registry.resolve(ORG, { provider: "model-fake", model: "fake-9" }))).toBe(
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
            ...k.app.get(ExtensionHost).list(cap),
            { plugin: "broken", capability: "model-provider@2" as const, impl: broken },
          ],
          current: (plugin: string) => k.app.get(ExtensionRegistry).current(plugin),
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
      const providers = await withBroken().list(ORG);
      expect(providers.map((p) => p.provider)).toEqual(["model-fake", "model-fake-b"]);
      expect(warns).toHaveLength(1);
      expect(warns[0]?.msg).toMatch(/listModels failed/);
    });

    it("resolve 时供应商失败 → ProviderListError（仍是 agent.model_unavailable，带 cause）", async () => {
      const err = await withBroken()
        .resolve(ORG, { provider: "broken", model: "x" })
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
            ...k.app.get(ExtensionHost).list(cap),
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
      expect(await redis.ttl("capk:models-failed:hung:-:-")).toBeGreaterThan(0);
      const err = await reg.resolve(ORG, { provider: "hung", model: "x" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ProviderListError);
      expect(calls).toBe(2);
    });
  });
});

describe("model-provider@2", () => {
  const chatInfo = (id: string): Omit<ModelInfo, "parameters"> => ({
    id,
    displayName: id,
    contextWindow: 8_000,
    maxOutputTokens: 1_000,
    capabilities: {
      tools: false,
      vision: false,
      reasoning: false,
      caching: false,
      midConversationSystem: false,
    },
  });
  const done: ModelStreamEvent = {
    type: "message_complete",
    content: [{ type: "text", text: "ok" }],
    stopReason: "end_turn",
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
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
        return [{ ...chatInfo("v2-model"), parameters }];
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
    const entries = k.app.get(ExtensionHost).list("model-provider");
    expect(entries.map((e) => [e.plugin, e.capability])).toEqual([
      ["model-fake", "model-provider@2"],
      ["model-fake-b", "model-provider@2"],
    ]);
  });

  it("@2 embedding model: listed with its kind when the provider implements embed; the bound embed carries the org", async () => {
    const seen: unknown[] = [];
    const embedding = { dimensions: [4], defaultDimensions: 4, maxInputTokens: 10, maxBatch: 2 };
    const base = { ...chatInfo("emb"), parameters: [] };
    const impl: ModelProvider = {
      async listModels() {
        return [{ ...base, kind: "embedding", embedding }];
      },
      stream() {
        throw new Error("unused");
      },
      async embed(r, opts) {
        seen.push({ orgId: opts.orgId, hasSignal: opts.signal instanceof AbortSignal });
        return { vectors: r.input.map(() => [0, 0, 0, 0]), usage: { inputTokens: 1 } };
      },
    };
    const r = reg([{ plugin: "e2", capability: "model-provider@2", impl }]);
    const { provider, info } = await r.resolve(
      ORG,
      { provider: "e2", model: "emb" },
      { kind: "embedding" },
    );
    expect(info.kind).toBe("embedding");
    expect(info.embedding).toEqual(embedding);
    const out = await provider.embed?.({ model: "emb", input: ["a"] }, signal());
    expect(out?.vectors).toEqual([[0, 0, 0, 0]]);
    expect(seen).toEqual([{ orgId: ORG, hasSignal: true }]);
    // the same model from a provider without embed is dropped
    const { embed: _embed, ...noEmbed } = impl;
    const warns: unknown[] = [];
    const r2 = reg([{ plugin: "e3", capability: "model-provider@2", impl: noEmbed }], warns);
    expect((await r2.list(ORG))[0]?.models).toEqual([]);
    expect(warns).toEqual(["model dropped from the provider's list"]);
  });

  it("@2 embedding model with malformed embedding info is dropped, one warn each; a valid one stays", async () => {
    const base = { ...chatInfo("emb"), parameters: [] };
    const good = { dimensions: [4, 8], defaultDimensions: 8, maxInputTokens: 10, maxBatch: 2 };
    const bad: Record<string, unknown> = {
      "no-dims": { ...good, dimensions: [] },
      "default-not-offered": { ...good, defaultDimensions: 16 },
      "zero-batch": { ...good, maxBatch: 0 },
      "fractional-batch": { ...good, maxBatch: 1.5 },
      "negative-tokens": { ...good, maxInputTokens: -1 },
      "fractional-dim": { ...good, dimensions: [4, 7.5], defaultDimensions: 4 },
      "zero-dim": { ...good, dimensions: [0, 8] },
      "string-batch": { ...good, maxBatch: "2" },
    };
    const impl: ModelProvider = {
      async listModels() {
        return [
          { ...base, id: "ok", kind: "embedding", embedding: good },
          ...Object.entries(bad).map(([id, embedding]) => ({
            ...base,
            id,
            kind: "embedding" as const,
            embedding: embedding as typeof good,
          })),
        ];
      },
      stream() {
        throw new Error("unused");
      },
      async embed(r) {
        return { vectors: r.input.map(() => [0, 0, 0, 0]), usage: { inputTokens: 1 } };
      },
    };
    const warns: unknown[] = [];
    const r = reg([{ plugin: "e4", capability: "model-provider@2", impl }], warns);
    expect((await r.list(ORG))[0]?.models.map((m) => m.id)).toEqual(["ok"]);
    expect(warns).toEqual(Object.keys(bad).map(() => "model dropped from the provider's list"));
  });

  const imageInfo = {
    sizes: [{ width: 1024, height: 1024 }],
    defaultSize: { width: 1024, height: 1024 },
    maxImages: 2,
    maxReferenceImages: 0,
    outputMediaTypes: ["image/png" as const],
  };
  const imageProvider = (
    models: ModelInfo[],
    withGenerate: boolean,
    seen: unknown[] = [],
  ): ModelProvider => ({
    async listModels() {
      return models;
    },
    stream() {
      throw new Error("unused");
    },
    ...(withGenerate && {
      async generateImage(r, opts) {
        seen.push({ orgId: opts.orgId, hasSignal: opts.signal instanceof AbortSignal });
        return {
          images: Array.from({ length: r.n }, () => ({
            mediaType: "image/png" as const,
            data: "AAAA",
          })),
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
        };
      },
    }),
  });

  it("an image model with info and generateImage resolves as image_generation", async () => {
    const seen: unknown[] = [];
    const m: ModelInfo = {
      ...chatInfo("img"),
      parameters: [],
      kind: "image_generation",
      imageGeneration: imageInfo,
    };
    const r = reg([
      { plugin: "i1", capability: "model-provider@2", impl: imageProvider([m], true, seen) },
    ]);
    const { provider, info } = await r.resolve(
      ORG,
      { provider: "i1", model: "img" },
      { kind: "image_generation" },
    );
    expect(info.kind).toBe("image_generation");
    expect(info.imageGeneration).toEqual(imageInfo);
    await provider.generateImage?.(
      { model: "img", prompt: "a cat", size: imageInfo.defaultSize, n: 1, params: {} },
      signal(),
    );
    expect(seen).toEqual([{ orgId: ORG, hasSignal: true }]);
    // a chat caller never gets it, a purpose check (callable) does
    expect(await codeOf(r.resolve(ORG, { provider: "i1", model: "img" }))).toBe(
      "agent.model_unavailable",
    );
    expect(
      (await r.resolve(ORG, { provider: "i1", model: "img" }, { kind: "callable" })).info.kind,
    ).toBe("image_generation");
  });

  it("an image model without generateImage stays listed and does not resolve", async () => {
    const m: ModelInfo = {
      ...chatInfo("img"),
      parameters: [],
      kind: "image_generation",
      imageGeneration: imageInfo,
    };
    const warns: unknown[] = [];
    const r = reg(
      [{ plugin: "i2", capability: "model-provider@2", impl: imageProvider([m], false) }],
      warns,
    );
    expect((await r.list(ORG))[0]?.models.map((x) => [x.id, x.kind])).toEqual([
      ["img", "image_generation"],
    ]);
    expect(warns).toEqual([]);
    expect(
      await codeOf(r.resolve(ORG, { provider: "i2", model: "img" }, { kind: "image_generation" })),
    ).toBe("agent.model_unavailable");
  });

  it("malformed imageGeneration is dropped with one warning", async () => {
    const base: ModelInfo = { ...chatInfo("img"), parameters: [], kind: "image_generation" };
    const warns: unknown[] = [];
    const r = reg(
      [
        {
          plugin: "i3",
          capability: "model-provider@2",
          impl: imageProvider(
            [
              { ...base, id: "ok", imageGeneration: imageInfo },
              { ...base, id: "bad", imageGeneration: { ...imageInfo, sizes: [] } },
            ],
            true,
          ),
        },
      ],
      warns,
    );
    expect((await r.list(ORG))[0]?.models.map((m) => m.id)).toEqual(["ok"]);
    expect(warns).toEqual(["model dropped from the provider's list"]);
  });

  it("@2：模型信息与请求原样透传", async () => {
    const p = v2();
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const { provider, info } = await r.resolve(ORG, { provider: "p2", model: "v2-model" });
    expect(info.parameters).toEqual(v2Params);
    const sent = req({ effort: "high", "p2.style": true });
    await drain(provider.stream(sent, signal()));
    expect(p.seen).toEqual([sent]);
  });

  it("a provider of another major (model-provider@1) is ignored with a warn", async () => {
    const p = v2();
    const warns: unknown[] = [];
    const r = reg(
      [
        { plugin: "old", capability: "model-provider@1", impl: p.impl },
        { plugin: "p2", capability: "model-provider@2", impl: p.impl },
      ],
      warns,
    );
    expect((await r.list(ORG)).map((x) => x.provider)).toEqual(["p2"]);
    expect(warns).toEqual(["unsupported model-provider major version; ignored"]);
  });

  it("@2 model with invalid declarations: only that model is dropped (one warn); resolve -> agent.model_unavailable (not retryable)", async () => {
    const bad = v2([
      { key: "style", schema: { type: "boolean" }, label: { zh: "风格", en: "Style" } },
    ]);
    const warns: unknown[] = [];
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: bad.impl }], warns);
    expect((await r.list(ORG)).map((x) => [x.provider, x.models.map((m) => m.id)])).toEqual([
      ["p2", []],
    ]);
    expect(warns).toEqual(["model dropped from the provider's list"]);
    const err = await r
      .resolve(ORG, { provider: "p2", model: "v2-model" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).not.toBeInstanceOf(ProviderListError);
    expect((err as ApiError).code).toBe("agent.model_unavailable");
    // the validated list (without the dropped model) is cached
    expect(await redis.exists("cache:capk:models:p2:f2:-:-")).toBe(1);
  });

  it("an older kernel's entry under the pre-@Cacheable key is ignored: the list is cached under the new key", async () => {
    // what an older kernel wrote (a raw shape, under its old key)
    await redis.set("capk:models:p2:v2:-:-", JSON.stringify([{ id: "stale" }]), "EX", 600);
    const p = v2();
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const [entry] = await r.list(ORG);
    expect(entry?.models.map((m) => m.id)).toEqual(["v2-model"]);
    expect(p.calls()).toBe(1);
    // cached under the new key (`@Cacheable`), which the next list reads
    const cached = JSON.parse((await redis.get("cache:capk:models:p2:f2:-:-")) ?? "null");
    expect(cached.map((m: { id: string }) => m.id)).toEqual(["v2-model"]);
    expect(await redis.ttl("cache:capk:models:p2:f2:-:-")).toBeGreaterThan(0);
    await r.list(ORG);
    expect(p.calls()).toBe(1);
    // the old key is neither read nor rewritten
    expect(JSON.parse((await redis.get("capk:models:p2:v2:-:-")) ?? "null")).toEqual([
      { id: "stale" },
    ]);
  });

  it("a format-1 list (no kind, written before model kinds) is ignored: the model still resolves", async () => {
    // what the previous kernel cached: the validated list without a normalised `kind`
    await redis.set("cache:capk:models:p2:-:-", JSON.stringify([{ id: "v2-model" }]), "EX", 600);
    const p = v2();
    const r = reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl }]);
    const { info } = await r.resolve(ORG, { provider: "p2", model: "v2-model" });
    expect(info.kind).toBe("chat");
    expect(p.calls()).toBe(1);
  });
  it("插件版本或部署配置变化 → 缓存未命中，重新列模型（升级后不按旧声明校验）", async () => {
    const p = v2();
    const at = (version: string, configHash: string) =>
      reg([{ plugin: "p2", capability: "model-provider@2", impl: p.impl, version, configHash }]);
    await at("1.0.0", "aaaa").list(ORG);
    expect(p.calls()).toBe(1);
    await at("1.0.0", "aaaa").list(ORG);
    expect(p.calls()).toBe(1);
    await at("1.1.0", "aaaa").list(ORG);
    expect(p.calls()).toBe(2);
    await at("1.1.0", "bbbb").list(ORG);
    expect(p.calls()).toBe(3);
  });

  it("the list time limit comes from models.listTimeoutMs", async () => {
    const hung: ModelProvider = {
      listModels: () => new Promise(() => {}),
      stream() {
        throw new Error("unused");
      },
    };
    const r = providerRegistryFor(
      { list: () => [{ plugin: "hung", capability: "model-provider@2" as const, impl: hung }] },
      redis,
      undefined,
      { configListTimeoutMs: 150 },
    );
    const started = Date.now();
    const err = await r.resolve(ORG, { provider: "hung", model: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderListError);
    expect(((err as ProviderListError).cause as Error).message).toBe(
      "listModels timed out after 150ms",
    );
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("不支持的主版本被忽略并记 warn", async () => {
    const warns: unknown[] = [];
    const r = reg([{ plugin: "future", capability: "model-provider@3", impl: v2().impl }], warns);
    expect(await r.list(ORG)).toEqual([]);
    expect(warns.length).toBeGreaterThan(0);
    expect(await codeOf(r.resolve(ORG, { provider: "future", model: "v2-model" }))).toBe(
      "agent.model_unavailable",
    );
  });
});
