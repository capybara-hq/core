import { randomUUID } from "node:crypto";
import {
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  MODEL_PROVIDER_CAPABILITY_V2 as V2,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { COMPACTION_MARKER } from "../../src/runtime/context/compaction.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import {
  type ModelStepDeps,
  RunError,
  runFinalWrapUp,
  runModelStep,
  type StreamSink,
  TOOLS_UNSUPPORTED_REMINDER,
  WRAP_UP_REMINDER,
} from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { toolSearchTool } from "../../src/tools/builtins/tool-search.js";
import { type ResolvedTool, specHash } from "../../src/tools/registry.js";
import { truncateTables } from "../helpers/db.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let deps: ModelStepDeps;
let baseConfig: KernelConfig;
let runtimeOverrides: Partial<KernelConfig["runtime"]> = {};

const silent = createLogger("error", { write: () => {} });

/** 这些用例不涉及插话：所有 user_message 都视为已吸收。 */
const ALL_ABSORBED = 1_000_000_000;

// ---- 测试内的模型供应商桩：精确控制调用次数与返回内容 ----

const stubInfo = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  displayName: id,
  contextWindow: 32_000,
  maxOutputTokens: 4096,
  capabilities: {
    tools: false,
    vision: false,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
    effort: false,
  },
  parameters: [],
  ...extra,
});

interface Stub extends ModelProvider {
  calls: ModelRequest[];
}

/** `respond` 返回文本即流式输出该文本（每 4 字符一个增量）；usage 的输入 token 与内核估算一致（校正比例为 1）。 */
/** `respond` 抛错即该次调用失败；`usage` 可覆盖默认用量（默认整段输入都算未命中缓存）。 */
function stub(
  models: ModelInfo[],
  respond: (req: ModelRequest) => string,
  usageOf?: (req: ModelRequest, estimate: number) => ModelUsage,
): Stub {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async listModels() {
      return models;
    },
    async *stream(req): AsyncGenerator<ModelStreamEvent> {
      calls.push(req);
      const text = respond(req);
      for (let i = 0; i < text.length; i += 4) {
        yield { type: "text_delta", text: text.slice(i, i + 4) };
      }
      yield {
        type: "message_complete",
        content: [{ type: "text", text }],
        stopReason: "end_turn",
        usage: usageOf?.(req, estimateTokens(req.messages, req.system)) ?? {
          inputTokens: estimateTokens(req.messages, req.system),
          outputTokens: Math.ceil(text.length / 4),
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      };
    },
  };
}

let stubImpl: ModelProvider = stub([stubInfo("ok")], () => "ok");

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  baseConfig = KernelConfigSchema.parse({
    db: { url: pgc.url, poolMax: 5 },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
    http: { port: 0 },
    plugins: [MODEL_FAKE],
    pluginPermissions: { autoApprove: true },
    pluginConfig: {
      "model-fake": {
        models: [
          { id: "fake-1" },
          { id: "fake-stall", streamIdleTimeoutMs: 200 },
          { id: "fake-think", streamIdleTimeoutMs: 5000 },
          { id: "fake-small", contextWindow: 2000 },
        ],
      },
    },
  });
  k = await createKernel(baseConfig, { env: {}, logger: silent });
  await k.start();
  raw = createDb(pgc.url, 10);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = new EventLog(db, createBus(redis, sub, "kernel"));
  const registry = new ProviderRegistry(
    {
      list: (cap: string) => [
        ...k.host.list(cap),
        { plugin: "stub", capability: V2, impl: stubImpl },
      ],
    },
    redis,
  );
  deps = {
    db,
    eventLog,
    registry,
    config: () => ({ ...baseConfig, runtime: { ...baseConfig.runtime, ...runtimeOverrides } }),
    tools: k.tools.registry,
    log: silent,
  };
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let conversationId: string;
let accountId: string;
let runId: string;
let orgId: string;

beforeEach(async () => {
  await redis.flushdb();
  runtimeOverrides = {};
  stubImpl = stub([stubInfo("ok")], () => "ok");
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  accountId = randomUUID();
  orgId = randomUUID();
  const agentId = randomUUID();
  conversationId = randomUUID();
  runId = randomUUID();
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${accountId}, 'U')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${orgId}, ${`o-${orgId.slice(0, 8)}`}, 'O', ${accountId})`.execute(raw);
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agentId}, ${orgId}, ${accountId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
});

const agentWith = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  tools: [],
  toolPolicies: {},
  ...over,
});

const say = async (text: string) => {
  await eventLog.append(conversationId, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text }], authorAccountId: accountId },
    },
  ]);
};

const answer = async (text: string) => {
  await eventLog.append(conversationId, [
    {
      type: "assistant_message",
      runId: "old-run",
      payload: { step: 1, content: [{ type: "text", text }], stopReason: "end_turn" },
    },
  ]);
};

type Delta = Parameters<StreamSink>[0];

function collector(): { deltas: Delta[]; sink: StreamSink } {
  const deltas: Delta[] = [];
  return { deltas, sink: (d) => deltas.push(d) };
}

const step = (
  over: { step?: number; agent?: AgentDefinition; signal?: AbortSignal; sink?: StreamSink } = {},
) =>
  runModelStep(deps, {
    orgId,
    conversationId,
    runId,
    step: over.step ?? 1,
    agent: over.agent ?? agentWith(),
    agentVersion: 1,
    absorbedUpToSeq: ALL_ABSORBED,
    signal: over.signal ?? new AbortController().signal,
    sink: over.sink ?? (() => {}),
  });

const all = () => eventLog.readAfter(conversationId, 0, 10_000);
const ofType = async <T extends ConversationEvent["type"]>(type: T) =>
  (await all()).filter((e) => e.type === type) as (ConversationEvent & {
    type: T;
    payload: EventPayload<T>;
  })[];

const runErrorCode = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof RunError) return e.code;
    throw e;
  }
  throw new Error("expected RunError");
};

describe("runModelStep", () => {
  it("流式增量经 sink 拼起来等于最终文本；写 model_call、assistant_message、usage 各一条", async () => {
    await say("echo:hello streaming world");
    const { deltas, sink } = collector();
    const r = await step({ sink });
    expect(r).toMatchObject({ reused: false, aborted: false, stopReason: "end_turn" });
    expect(r.content).toEqual([{ type: "text", text: "hello streaming world" }]);
    expect(r.usage?.inputTokens).toBeGreaterThan(0);
    const text = deltas
      .filter((d) => d.kind === "text")
      .map((d) => d.text)
      .join("");
    expect(text).toBe("hello streaming world");
    expect(deltas.every((d) => d.runId === runId && d.step === 1)).toBe(true);

    const calls = await ofType("model_call");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      step: 1,
      attempt: 1,
      provider: "model-fake",
      model: "fake-1",
      fallback: false,
      request: { maxOutputTokens: 4096, params: {}, summarySeq: null, reminderSeqs: [] },
    });
    expect(calls[0]?.payload.request).not.toHaveProperty("droppedParams");
    expect(calls[0]?.payload.request).not.toHaveProperty("effort");
    expect(calls[0]?.payload.request.estimatedInputTokens).toBeGreaterThan(0);
    const msgs = await ofType("assistant_message");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.payload).toEqual({ step: 1, content: r.content, stopReason: "end_turn" });
    expect(msgs[0]?.runId).toBe(runId);
    const usage = await ofType("usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]?.payload).toMatchObject({ step: 1, provider: "model-fake", model: "fake-1" });
  });

  it("maxOutputTokens 取模型上限与 runtime.maxOutputTokens 的较小者", async () => {
    runtimeOverrides = { maxOutputTokens: 1000 };
    await say("echo:x");
    await step();
    const [call] = await ofType("model_call");
    expect(call?.payload.request.maxOutputTokens).toBe(1000);
  });

  describe("模型参数", () => {
    const EFFORT_LH: ModelParameter = {
      key: "effort",
      standard: "effort",
      schema: { type: "string", enum: ["low", "high"] },
      default: "low",
      label: { zh: "思考深度", en: "Effort" },
    };
    const MAX_OUT: ModelParameter = {
      key: "maxOutputTokens",
      standard: "maxOutputTokens",
      schema: { type: "integer", minimum: 1, maximum: 100_000 },
      label: { zh: "输出上限", en: "Max output tokens" },
    };
    const STYLE: ModelParameter = {
      key: "stub.style",
      schema: { type: "string", enum: ["plain", "shout"] },
      default: "plain",
      label: { zh: "风格", en: "Style" },
    };

    it("参数经 sanitize 后进 ModelRequest.params，并记录在 model_call.request.params", async () => {
      const s = stub([stubInfo("p", { parameters: [EFFORT_LH, STYLE] })], () => "ok");
      stubImpl = s;
      await say("hi");
      await step({
        agent: agentWith({
          model: { provider: "stub", model: "p" },
          modelParams: { effort: "high" },
        }),
      });
      expect(s.calls[0]?.params).toEqual({ effort: "high", "stub.style": "plain" });
      const [call] = await ofType("model_call");
      expect(call?.payload.request.params).toEqual({ effort: "high", "stub.style": "plain" });
      expect(call?.payload.request).not.toHaveProperty("droppedParams");
    });

    it("已保存的参数不再合法（插件升级）→ 丢弃并用默认值，droppedParams 记录键，运行成功（Review Focus 2）", async () => {
      const s = stub([stubInfo("p", { parameters: [EFFORT_LH, STYLE] })], () => "still fine");
      stubImpl = s;
      await say("hi");
      const r = await step({
        agent: agentWith({
          model: { provider: "stub", model: "p" },
          // effort 的值域变窄（max 不再合法），stub.removed 已被移除
          modelParams: { effort: "max", "stub.removed": true, "stub.style": "shout" },
        }),
      });
      expect(r.content).toEqual([{ type: "text", text: "still fine" }]);
      expect(s.calls[0]?.params).toEqual({ effort: "low", "stub.style": "shout" });
      const [call] = await ofType("model_call");
      expect(call?.payload.request.params).toEqual({ effort: "low", "stub.style": "shout" });
      expect(call?.payload.request.droppedParams).toEqual(["effort", "stub.removed"]);
    });

    it("兜底尝试使用兜底模型自己的 fallbackParams（经 sanitize），不沿用主模型参数", async () => {
      const s = stub(
        [
          stubInfo("main", { parameters: [EFFORT_LH] }),
          stubInfo("fb", { parameters: [EFFORT_LH, STYLE] }),
        ],
        (req) => {
          if (req.model === "main") throw new ModelError("server", "down");
          return "from fallback";
        },
      );
      stubImpl = s;
      await say("hi");
      const r = await step({
        agent: agentWith({
          model: { provider: "stub", model: "main" },
          modelParams: { effort: "high" },
          fallback: { provider: "stub", model: "fb" },
          fallbackParams: { "stub.style": "shout", "stub.gone": 1 },
        }),
      });
      expect(r.content).toEqual([{ type: "text", text: "from fallback" }]);
      const calls = await ofType("model_call");
      expect(calls.map((c) => [c.payload.model, c.payload.request.params])).toEqual([
        ["main", { effort: "high" }],
        ["main", { effort: "high" }],
        ["fb", { effort: "low", "stub.style": "shout" }],
      ]);
      expect(calls[2]?.payload.request.droppedParams).toEqual(["stub.gone"]);
      expect(calls[0]?.payload.request).not.toHaveProperty("droppedParams");
      expect(s.calls.map((c) => c.params)).toEqual([
        { effort: "high" },
        { effort: "high" },
        { effort: "low", "stub.style": "shout" },
      ]);
    });

    it("maxOutputTokens 旋钮覆盖 runtime.maxOutputTokens，但不超过模型上限", async () => {
      const s = stub([stubInfo("p", { parameters: [MAX_OUT] })], () => "ok");
      stubImpl = s;
      runtimeOverrides = { maxOutputTokens: 1000 };
      await say("hi");
      await step({
        agent: agentWith({
          model: { provider: "stub", model: "p" },
          modelParams: { maxOutputTokens: 2000 },
        }),
      });
      await step({
        step: 2,
        agent: agentWith({
          model: { provider: "stub", model: "p" },
          modelParams: { maxOutputTokens: 9000 },
        }),
      });
      await step({ step: 3, agent: agentWith({ model: { provider: "stub", model: "p" } }) });
      expect(s.calls.map((c) => c.maxOutputTokens)).toEqual([2000, 4096, 1000]);
      const calls = await ofType("model_call");
      expect(calls.map((c) => c.payload.request.maxOutputTokens)).toEqual([2000, 4096, 1000]);
    });

    it("较早保存的定义没有 modelParams / fallbackParams 字段 → 按空参数处理", async () => {
      const s = stub([stubInfo("p", { parameters: [EFFORT_LH] })], () => "ok");
      stubImpl = s;
      await say("hi");
      const {
        modelParams: _m,
        fallbackParams: _f,
        ...legacy
      } = agentWith({
        model: { provider: "stub", model: "p" },
      });
      await step({ agent: legacy as AgentDefinition });
      expect(s.calls[0]?.params).toEqual({ effort: "low" });
    });
  });

  it("同一 (run, step) 调用两次 → 第二次 reused，供应商只被调用一次", async () => {
    const s = stub([stubInfo("ok")], () => "only once");
    stubImpl = s;
    await say("hi");
    const agent = agentWith({ model: { provider: "stub", model: "ok" } });
    const first = await step({ agent });
    const second = await step({ agent });
    expect(s.calls).toHaveLength(1);
    expect(first.reused).toBe(false);
    expect(second).toMatchObject({
      reused: true,
      aborted: false,
      stopReason: "end_turn",
      content: [{ type: "text", text: "only once" }],
    });
    expect(second.usage).toEqual(first.usage);
    expect(await ofType("assistant_message")).toHaveLength(1);
  });

  it("看门狗：stall 模型 200ms 后重试、再 stall、切兜底并成功（3 条 model_call，2 次 step_reset，< 2s）", async () => {
    stubImpl = stub([stubInfo("ok")], () => "fallback answer");
    await say("stall");
    const { deltas, sink } = collector();
    const t0 = Date.now();
    const r = await step({
      sink,
      agent: agentWith({
        model: { provider: "model-fake", model: "fake-stall" },
        fallback: { provider: "stub", model: "ok" },
      }),
    });
    const elapsed = Date.now() - t0;
    expect(r.content).toEqual([{ type: "text", text: "fallback answer" }]);
    // Without the watchdog the stalled stream never ends; 4 s leaves room for CI load.
    expect(elapsed).toBeLessThan(4000);
    expect(elapsed).toBeGreaterThanOrEqual(400);
    const calls = await ofType("model_call");
    expect(calls.map((c) => [c.payload.attempt, c.payload.model, c.payload.fallback])).toEqual([
      [1, "fake-stall", false],
      [2, "fake-stall", false],
      [3, "ok", true],
    ]);
    expect(deltas.filter((d) => d.kind === "step_reset")).toHaveLength(2);
    const [usage] = await ofType("usage");
    expect(usage?.payload).toMatchObject({ provider: "stub", model: "ok" });
  });

  it("看门狗：streamIdleTimeoutMs 5000 的推理模型 300ms 的间隔不触发", async () => {
    runtimeOverrides = { streamIdleMs: 100 };
    await say("slow:300:abcdefgh");
    const r = await step({
      agent: agentWith({ model: { provider: "model-fake", model: "fake-think" } }),
    });
    expect(r.content).toEqual([{ type: "text", text: "abcdefgh" }]);
    expect(await ofType("model_call")).toHaveLength(1);
  });

  it("fail:auth → 不重试，抛 RunError(model.auth)", async () => {
    await say("fail:auth");
    expect(await runErrorCode(step())).toBe("model.auth");
    expect(await ofType("model_call")).toHaveLength(1);
    expect(await ofType("assistant_message")).toHaveLength(0);
  });

  it("fail:rate_limited 且没有兜底 → 重试一次后抛 RunError(model.rate_limited)", async () => {
    await say("fail:rate_limited");
    const { deltas, sink } = collector();
    expect(await runErrorCode(step({ sink }))).toBe("model.rate_limited");
    expect((await ofType("model_call")).map((c) => c.payload.attempt)).toEqual([1, 2]);
    expect(deltas.filter((d) => d.kind === "step_reset")).toHaveLength(1);
  });

  it("retryAfterMs 超过上限（10s）→ 跳过同模型重试，直接切兜底", async () => {
    stubImpl = stub([stubInfo("limited"), stubInfo("ok")], (req) => {
      if (req.model === "limited") {
        throw new ModelError("rate_limited", "slow down", { retryAfterMs: 600_000 });
      }
      return "from fallback";
    });
    await say("hi");
    const { deltas, sink } = collector();
    const t0 = Date.now();
    const r = await step({
      sink,
      agent: agentWith({
        model: { provider: "stub", model: "limited" },
        fallback: { provider: "stub", model: "ok" },
      }),
    });
    // Honouring the suggested 600 s wait is the alternative; 5 s leaves room for CI load.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(r.content).toEqual([{ type: "text", text: "from fallback" }]);
    const calls = await ofType("model_call");
    expect(calls.map((c) => [c.payload.attempt, c.payload.model, c.payload.fallback])).toEqual([
      [1, "limited", false],
      [2, "ok", true],
    ]);
    expect(deltas.filter((d) => d.kind === "step_reset")).toHaveLength(1);
  });

  it("retryAfterMs 超过上限且没有兜底 → 立即抛 RunError，不等待", async () => {
    stubImpl = stub([stubInfo("limited")], () => {
      throw new ModelError("rate_limited", "slow down", { retryAfterMs: 600_000 });
    });
    await say("hi");
    const t0 = Date.now();
    const code = await runErrorCode(
      step({ agent: agentWith({ model: { provider: "stub", model: "limited" } }) }),
    );
    expect(code).toBe("model.rate_limited");
    // Honouring the suggested 600 s wait is the alternative; 5 s leaves room for CI load.
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(await ofType("model_call")).toHaveLength(1);
  });

  it("retryAfterMs 在上限内 → 按建议等待后在同一模型上重试", async () => {
    let n = 0;
    stubImpl = stub([stubInfo("flaky")], () => {
      if (++n === 1) throw new ModelError("overloaded", "busy", { retryAfterMs: 2_000 });
      return "second try";
    });
    await say("hi");
    const t0 = Date.now();
    const r = await step({ agent: agentWith({ model: { provider: "stub", model: "flaky" } }) });
    const elapsed = Date.now() - t0;
    expect(r.content).toEqual([{ type: "text", text: "second try" }]);
    // 2 s suggested vs the 1 s default delay: the lower bound tells them apart, so the upper
    // bound only has to stay loose enough for CI load.
    expect(elapsed).toBeGreaterThanOrEqual(1_900);
    expect(elapsed).toBeLessThan(4_500);
    expect((await ofType("model_call")).map((c) => c.payload.attempt)).toEqual([1, 2]);
  });

  it("模型不存在 → RunError(run.model_unavailable)", async () => {
    await say("hi");
    const code = await runErrorCode(
      step({ agent: agentWith({ model: { provider: "model-fake", model: "nope" } }) }),
    );
    expect(code).toBe("run.model_unavailable");
  });

  it("供应商 listModels 失败按可重试处理：重试后切兜底成功", async () => {
    let n = 0;
    const flaky: ModelProvider = {
      async listModels() {
        n++;
        throw new Error("provider down");
      },
      stream() {
        throw new Error("unused");
      },
    };
    const registry = new ProviderRegistry(
      {
        list: (cap: string) => [
          ...k.host.list(cap),
          { plugin: "flaky", capability: V2, impl: flaky },
          { plugin: "stub", capability: V2, impl: stubImpl },
        ],
      },
      redis,
    );
    await say("hi");
    const { deltas, sink } = collector();
    const r = await runModelStep(
      { ...deps, registry },
      {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith({
          model: { provider: "flaky", model: "x" },
          fallback: { provider: "stub", model: "ok" },
        }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink,
      },
    );
    expect(r.content).toEqual([{ type: "text", text: "ok" }]);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(deltas.filter((d) => d.kind === "step_reset")).toHaveLength(2);
    // 解析失败的尝试没有请求可记，只有成功解析的兜底尝试写 model_call。
    const calls = await ofType("model_call");
    expect(calls.map((c) => [c.payload.attempt, c.payload.fallback])).toEqual([[3, true]]);
  });

  it("供应商 listModels 失败且没有兜底 → RunError(run.provider_unavailable)", async () => {
    const broken: ModelProvider = {
      async listModels() {
        throw new Error("provider down");
      },
      stream() {
        throw new Error("unused");
      },
    };
    const registry = new ProviderRegistry(
      {
        list: (cap: string) => [
          ...k.host.list(cap),
          { plugin: "broken", capability: V2, impl: broken },
        ],
      },
      redis,
    );
    await say("hi");
    const p = runModelStep(
      { ...deps, registry },
      {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith({ model: { provider: "broken", model: "x" } }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
      },
    );
    expect(await runErrorCode(p)).toBe("run.provider_unavailable");
  });

  it("中止：slow 流到一半 abort → assistant_message 为已流出部分、stopReason aborted；不再写 model_call", async () => {
    await say("slow:100:abcdefghijklmnopqrstuvwxyz");
    const ac = new AbortController();
    let n = 0;
    const r = await step({
      signal: ac.signal,
      sink: (d) => {
        if (d.kind === "text" && ++n === 2) ac.abort();
      },
    });
    expect(r).toMatchObject({ aborted: true, stopReason: "aborted", usage: null });
    expect(r.content).toEqual([{ type: "text", text: "abcdefgh" }]);
    const [msg] = await ofType("assistant_message");
    expect(msg?.payload).toEqual({
      step: 1,
      content: [{ type: "text", text: "abcdefgh" }],
      stopReason: "aborted",
    });
    expect(await ofType("model_call")).toHaveLength(1);
    expect(await ofType("usage")).toHaveLength(0);
  });

  it("中止：尚未流出文本时 abort → content 为 []", async () => {
    await say("stall");
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const r = await step({ signal: ac.signal });
    expect(r).toMatchObject({ aborted: true, content: [] });
    const [msg] = await ofType("assistant_message");
    expect(msg?.payload.content).toEqual([]);
  });

  it("中止：重试等待期间 abort → 立即返回 aborted，不再尝试", async () => {
    // A 5 s suggested wait (the default is 1 s) so "returned immediately" has a wide margin.
    stubImpl = stub([stubInfo("busy")], () => {
      throw new ModelError("overloaded", "busy", { retryAfterMs: 5_000 });
    });
    await say("hi");
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    const r = await step({
      signal: ac.signal,
      agent: agentWith({ model: { provider: "stub", model: "busy" } }),
    });
    expect(Date.now() - t0).toBeLessThan(2_500);
    expect(r).toMatchObject({ aborted: true, content: [] });
    expect(await ofType("model_call")).toHaveLength(1);
  });

  describe("压缩", () => {
    /** 每条 ~400 个 ASCII 字符 ≈ 100 token。 */
    const filler = (n: number) => `turn ${n} `.padEnd(400, "x");

    it("超过阈值 → 先写 compaction_summary，再写 model_call（summarySeq 指向摘要）；下一步不再压缩", async () => {
      for (let i = 0; i < 8; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      await say("echo:after compaction");
      const agent = agentWith({ model: { provider: "model-fake", model: "fake-small" } });
      const r = await step({ agent });
      expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);

      const events = await all();
      const summary = events.find((e) => e.type === "compaction_summary");
      const call = events.find((e) => e.type === "model_call");
      expect(summary).toBeDefined();
      expect(call).toBeDefined();
      expect((summary as ConversationEvent).seq).toBeLessThan((call as ConversationEvent).seq);
      expect(
        ((call as ConversationEvent).payload as EventPayload<"model_call">).request.summarySeq,
      ).toBe(summary?.seq);

      await step({ agent, step: 2 });
      expect(await ofType("compaction_summary")).toHaveLength(1);
      expect(await ofType("model_call")).toHaveLength(2);
    });

    it("校正按总输入（未缓存 + 缓存读 + 缓存写）计算：大量缓存命中时仍会触发压缩", async () => {
      // 供应商把绝大部分输入报为缓存读，inputTokens 只是未缓存部分；三者之和等于真实输入。
      stubImpl = stub(
        [stubInfo("cached", { contextWindow: 2000 })],
        (req) =>
          req.system.some((x) => x.text.includes(COMPACTION_MARKER))
            ? `Summary: ${"s".repeat(300)}`
            : "answer",
        (_req, estimate) => ({
          inputTokens: 20,
          outputTokens: 2,
          cacheReadTokens: Math.max(0, estimate - 30),
          cacheWriteTokens: 10,
        }),
      );
      const agent = agentWith({ model: { provider: "stub", model: "cached" } });
      await say("hi");
      await step({ agent });
      expect(await ofType("compaction_summary")).toHaveLength(0);

      for (let i = 0; i < 8; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      await say("go");
      runId = randomUUID();
      const r = await step({ agent });
      expect(r.content).toEqual([{ type: "text", text: "answer" }]);
      expect(await ofType("compaction_summary")).toHaveLength(1);
      expect(await ofType("compaction_failed")).toHaveLength(0);
    });

    it("摘要过短 → 写 compaction_failed（attempt 1），本步仍完成；下一轮因退避跳过；退避期满再失败 attempt 2", async () => {
      const s = stub([stubInfo("small", { contextWindow: 2000 })], (req) =>
        req.system.some((x) => x.text.includes(COMPACTION_MARKER)) ? "too short" : "answer",
      );
      stubImpl = s;
      for (let i = 0; i < 8; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      await say("go");
      const agent = agentWith({ model: { provider: "stub", model: "small" } });
      const r = await step({ agent });
      expect(r.content).toEqual([{ type: "text", text: "answer" }]);
      const failed = await ofType("compaction_failed");
      expect(failed.map((f) => f.payload.attempt)).toEqual([1]);
      expect(await ofType("compaction_summary")).toHaveLength(0);
      const compactionCalls = () =>
        s.calls.filter((c) => c.system.some((x) => x.text.includes(COMPACTION_MARKER))).length;
      expect(compactionCalls()).toBe(1);

      // 下一轮（失败后新增 1 个 user 轮次 < 2^1）：跳过压缩。
      await say("again");
      runId = randomUUID();
      await step({ agent });
      expect(await ofType("compaction_failed")).toHaveLength(1);
      expect(compactionCalls()).toBe(1);

      // 再一轮（新增 2 个 user 轮次）：再次尝试并失败，attempt 递增为 2。
      await say("third");
      runId = randomUUID();
      await step({ agent });
      expect((await ofType("compaction_failed")).map((f) => f.payload.attempt)).toEqual([1, 2]);
      expect(compactionCalls()).toBe(2);
    });
  });

  it("提醒：maxSteps 3 时 step 1 写 reminder，且 model_call.request.reminderSeqs 包含它", async () => {
    runtimeOverrides = { maxSteps: 3 };
    await say("echo:hi");
    await step({ step: 1 });
    const [reminder] = await ofType("reminder");
    expect(reminder).toBeDefined();
    expect(reminder?.payload.step).toBe(1);
    const [call] = await ofType("model_call");
    expect(call?.payload.request.reminderSeqs).toContain(reminder?.seq);
  });

  it("提醒：远离步数上限时不写 reminder", async () => {
    await say("echo:hi");
    await step({ step: 1 });
    expect(await ofType("reminder")).toHaveLength(0);
  });

  it("收尾：runFinalWrapUp 的请求 tools 为空，且末尾是收尾提醒（并已写入日志）", async () => {
    const s = stub([stubInfo("ok")], () => "summary for user");
    stubImpl = s;
    await say("hi");
    const r = await runFinalWrapUp(deps, {
      orgId,
      conversationId,
      runId,
      step: 51,
      agent: agentWith({ model: { provider: "stub", model: "ok" } }),
      agentVersion: 1,
      absorbedUpToSeq: ALL_ABSORBED,
      signal: new AbortController().signal,
      sink: () => {},
    });
    expect(r.content).toEqual([{ type: "text", text: "summary for user" }]);
    expect(s.calls).toHaveLength(1);
    const req = s.calls[0] as ModelRequest;
    expect(req.tools).toEqual([]);
    expect(req.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    expect(WRAP_UP_REMINDER).toBe(
      "Step limit reached. Do not call tools. Summarize what you found and what remains for the user.",
    );
    const reminders = await ofType("reminder");
    expect(reminders.map((x) => x.payload.text)).toEqual([WRAP_UP_REMINDER]);
    // 没有工具时也不发 toolChoice
    expect(req.toolChoice).toBeUndefined();
  });

  describe("工具与 toolChoice", () => {
    const toolsModel = () =>
      stubInfo("tooly", { capabilities: { ...stubInfo("x").capabilities, tools: true } });
    const withTools = () =>
      agentWith({
        model: { provider: "stub", model: "tooly" },
        tools: [{ kind: "builtin", name: "read_tool_output" }],
      });
    const wrapUp = (agent: AgentDefinition) =>
      runFinalWrapUp(deps, {
        orgId,
        conversationId,
        runId,
        step: 51,
        agent,
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
      });

    it("收尾调用照常带工具（历史里的工具调用需要声明工具），toolChoice 为 none，记在 model_call", async () => {
      const s = stub([toolsModel()], () => "summary");
      stubImpl = s;
      await say("hi");
      await wrapUp(withTools());
      const req = s.calls[0] as ModelRequest;
      expect(req.tools.map((t) => t.name)).toEqual(["read_tool_output"]);
      expect(req.toolChoice).toBe("none");
      const [call] = await ofType("model_call");
      expect(call?.payload.request.toolChoice).toBe("none");
      expect(call?.payload.request.tools?.map((t) => t.key)).toEqual(["read_tool_output"]);
      expect(req.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    });

    it("普通步骤不发 toolChoice（由模型决定），model_call 也不记", async () => {
      const s = stub([toolsModel()], () => "ok");
      stubImpl = s;
      await say("hi");
      await step({ agent: withTools() });
      const req = s.calls[0] as ModelRequest;
      expect(req.tools.map((t) => t.name)).toEqual(["read_tool_output"]);
      expect(req.toolChoice).toBeUndefined();
      const [call] = await ofType("model_call");
      expect(call?.payload.request).not.toHaveProperty("toolChoice");
    });

    it("模型不支持工具（capabilities.tools = false）→ 不发工具与 toolChoice，并写提醒说明本次没有工具", async () => {
      const s = stub([stubInfo("plain")], () => "ok");
      stubImpl = s;
      await say("hi");
      await wrapUp({ ...withTools(), model: { provider: "stub", model: "plain" } });
      const req = s.calls[0] as ModelRequest;
      expect(req.tools).toEqual([]);
      expect(req.toolChoice).toBeUndefined();
      const [call] = await ofType("model_call");
      expect(call?.payload.request.tools).toEqual([]);
      expect(call?.payload.request).not.toHaveProperty("toolChoice");
      const texts = (await ofType("reminder")).map((r) => r.payload.text);
      expect(texts).toContain(TOOLS_UNSUPPORTED_REMINDER);
      expect(req.messages).toContainEqual({ role: "system", content: TOOLS_UNSUPPORTED_REMINDER });
      // 收尾提醒仍在末尾
      expect(req.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    });

    it("model_call 里的每个工具定义按指纹存进 capybara.tool_specs（内容寻址，可还原请求）", async () => {
      stubImpl = stub([toolsModel()], () => "ok");
      await say("hi");
      await step({ agent: withTools() });
      await step({ step: 2, agent: withTools() });
      const [call] = await ofType("model_call");
      const hash = call?.payload.request.tools?.[0]?.specHash as string;
      const rows = await db
        .selectFrom("tool_specs")
        .selectAll()
        .where("spec_hash", "=", hash)
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]?.spec).toMatchObject({ name: "read_tool_output" });
    });

    it("tool_search 生效：请求只带内置工具，目录进 system 第二块；model_call 记录 catalog，目录里的定义也存进 tool_specs", async () => {
      const s = stub([toolsModel()], () => "ok");
      stubImpl = s;
      const search = toolSearchTool();
      const mk = (key: string): ResolvedTool => {
        const spec = {
          name: key.split("__")[1] as string,
          description: `Do ${key}.`,
          inputSchema: { type: "object" },
        };
        return {
          key,
          source: { kind: "plugin", plugin: "p", name: spec.name },
          spec,
          specHash: specHash(spec),
          defaultPolicy: "allow",
        };
      };
      const searchTool: ResolvedTool = {
        key: "tool_search",
        source: { kind: "builtin", name: "tool_search" },
        spec: search.spec,
        specHash: specHash(search.spec),
        defaultPolicy: "allow",
      };
      const tools = [mk("p__zeta"), mk("p__alpha"), searchTool];
      const searchDeps: ModelStepDeps = {
        ...deps,
        tools: { forAgent: async () => ({ tools, unavailable: [], toolSearch: true }) },
      };
      await say("hi");
      await runModelStep(searchDeps, {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: withTools(),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
      });
      const req = s.calls[0] as ModelRequest;
      expect(req.tools.map((t) => t.name)).toEqual(["tool_search"]);
      expect(req.system).toHaveLength(2);
      expect(req.system[1]?.text).toContain("- p__alpha: Do p__alpha.\n- p__zeta: Do p__zeta.");
      const [call] = await ofType("model_call");
      expect(call?.payload.request.tools?.map((t) => t.key)).toEqual(["tool_search"]);
      expect(call?.payload.request.catalog?.map((t) => t.key)).toEqual(["p__alpha", "p__zeta"]);
      const stored = await db
        .selectFrom("tool_specs")
        .select("spec_hash")
        .where(
          "spec_hash",
          "in",
          tools.map((t) => t.specHash),
        )
        .execute();
      expect(stored).toHaveLength(3);
    });
  });
});

describe("model.request hooks", () => {
  it("sticky: a logged denial for this attempt fails the step again without running the hooks or the model", async () => {
    await say("hello");
    await eventLog.append(conversationId, [
      {
        type: "hook_denied",
        runId,
        idemKey: `hook_denied:${runId}:1:1`,
        payload: {
          mount: "model.request",
          plugin: "guard",
          reason: "recorded reason",
          cause: "deny",
          step: 1,
          attempt: 1,
        },
      },
    ]);
    const runs: string[] = [];
    const hooked: ModelStepDeps = {
      ...deps,
      hooks: {
        has: () => true,
        run: async (mount) => {
          runs.push(mount);
          return { allowed: true };
        },
      },
    };
    let err: unknown;
    try {
      await runModelStep(hooked, {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith(),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
        agentId: randomUUID(),
        accountId,
        conversationKind: "chat",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunError);
    expect((err as RunError).code).toBe("run.hook_denied");
    expect((err as RunError).message).toContain('"guard"');
    expect((err as RunError).message).toContain("recorded reason");
    expect(runs).toEqual([]);
    expect(await ofType("model_call")).toEqual([]);
  });
});
