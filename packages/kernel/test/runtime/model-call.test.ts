import { randomUUID } from "node:crypto";
import {
  ModelError,
  type ModelInfo,
  type ModelParameter,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type ModelUsage,
  type StopReason,
  MODEL_PROVIDER_EXTENSION_POINT_V2 as V2,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import type { IdleMode, KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { liveSnapshot } from "../../src/evals/snapshot.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import { createLogger } from "../../src/log.js";
import { compactionModelPort } from "../../src/runtime/compaction-model.js";
import { COMPACTION_SETTINGS } from "../../src/runtime/compaction-settings.service.js";
import type { MediaBytes, MediaInfo } from "../../src/runtime/context/build.js";
import {
  buildCompactionRequest,
  compactionPlan,
  compactionRequestOverhead,
  compactionRetryNote,
  openingSeqs,
  summarySavedTokens,
} from "../../src/runtime/context/compaction.js";
import { inContextInstruction } from "../../src/runtime/context/in-context-compaction.js";
import { estimateTokens } from "../../src/runtime/context/tokens.js";
import {
  BUDGET_WRAP_UP_REMINDER,
  type ModelStepDeps,
  type ModelStepInput,
  prepareCompaction,
  RunError,
  readAllEvents,
  resolveAgentTools,
  runCompaction,
  runFinalWrapUp,
  runModelStep,
  type StreamSink,
  stepToolsOf,
  TOOLS_UNSUPPORTED_REMINDER,
  WRAP_UP_REMINDER,
} from "../../src/runtime/model-call.js";
import { toolSearchTool } from "../../src/tools/builtins/tool-search.js";
import { type ResolvedTool, specHash, ToolRegistry } from "../../src/tools/registry.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { builtinsOff, onlyBuiltins } from "../helpers/disabled-tools.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";
import { providerRegistryFor, stepLogFor } from "../helpers/runtime.js";
import { stepSettingsStub } from "./context/fixtures.js";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let deps: ModelStepDeps;
let baseConfig: KernelConfig;
let runtimeOverrides: Partial<KernelConfig["runtime"]> = {};
/** The org's `promptCache.longTtl` the step deps resolve (off unless a test turns it on). */
let longTtl = false;

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
    midConversationSystem: true,
  },
  parameters: [],
  ...extra,
});

interface Stub extends ModelProvider {
  calls: ModelRequest[];
}

/** `respond` 返回文本即流式输出该文本（每 4 字符一个增量）；usage 的输入 token 与内核估算一致（校正比例为 1）。 */
/** `respond` 抛错即该次调用失败；`usage` 可覆盖默认用量（默认整段输入都算未命中缓存）。 */
/** `stopOf` sets the stop reason of a call (default `end_turn`), e.g. `max_tokens` for a cut-off summary. */
function stub(
  models: ModelInfo[],
  respond: (req: ModelRequest) => string,
  usageOf?: (req: ModelRequest, estimate: number) => ModelUsage,
  stopOf?: (req: ModelRequest) => StopReason,
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
        stopReason: stopOf?.(req) ?? "end_turn",
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
    marketplaces: { official: { enabled: false } },
    http: { port: 0 },
    // the budget tests below need a cap (the default is none)
    subagents: { maxTokensPerRun: 5_000_000 },
    extensions: [MODEL_FAKE],
    extensionPermissions: { autoApprove: true },
    extensionConfig: {
      "model-fake": {
        models: [
          { id: "fake-1" },
          { id: "fake-stall", streamIdleTimeoutMs: 200 },
          { id: "fake-think", streamIdleTimeoutMs: 5000 },
          { id: "fake-small", contextWindow: 2000 },
          { id: "fake-nocache", cache: "none" },
          // compaction model cases: a summarizer with a large window, and one too small (§4.3)
          { id: "fake-c", contextWindow: 200_000 },
          { id: "fake-c32", contextWindow: 32_000 },
        ],
      },
    },
  });
  k = await startKernel(baseConfig, { env: {}, logger: silent });
  raw = createDb(pgc.url, 10);
  db = legacyDbFor(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
  const registry = providerRegistryFor(
    {
      list: (cap: string) => [
        ...k.app.get(ExtensionHost).list(cap),
        { plugin: "stub", capability: V2, impl: stubImpl },
      ],
    },
    redis,
  );
  deps = {
    db,
    eventLog,
    stepLog: stepLogFor(db, eventLog),
    registry,
    config: {
      get: () => ({ ...baseConfig, runtime: { ...baseConfig.runtime, ...runtimeOverrides } }),
    },
    // a zero reserve: the small-window test models cannot hold the default 8000 alongside their
    // output cap, and a test that needs the reserve sets its own below
    compactionSettings: stepSettingsStub(
      () => ({ ...COMPACTION_SETTINGS.parse({}), reserveTokens: 0 }),
      () => ({ longTtl }),
    ),
    tools: k.app.get(ToolRegistry),
    log: silent,
  };
});

afterAll(async () => {
  await k?.close();
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let conversationId: string;
let agentId: string;
let accountId: string;
let runId: string;
let orgId: string;

beforeEach(async () => {
  await redis.flushdb();
  runtimeOverrides = {};
  longTtl = false;
  stubImpl = stub([stubInfo("ok")], () => "ok");
  await truncateTables(raw, "capybara.accounts, capybara.orgs");
  accountId = randomUUID();
  orgId = randomUUID();
  agentId = randomUUID();
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
  disabledTools: builtinsOff(),
  disabledSkills: [],
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
  over: {
    step?: number;
    agent?: AgentDefinition;
    signal?: AbortSignal;
    sink?: StreamSink;
    maxSteps?: number;
    deadline?: number;
  } = {},
) =>
  runModelStep(deps, {
    source: "web",
    orgId,
    conversationId,
    runId,
    step: over.step ?? 1,
    agent: over.agent ?? agentWith(),
    agentVersion: 1,
    absorbedUpToSeq: ALL_ABSORBED,
    signal: over.signal ?? new AbortController().signal,
    sink: over.sink ?? (() => {}),
    ...(over.maxSteps !== undefined && { maxSteps: over.maxSteps }),
    ...(over.deadline !== undefined && { deadline: over.deadline }),
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

  it("a step an earlier execution already sent to the model starts with step_reset; a fresh one does not", async () => {
    // an earlier execution streamed part of step 1 and ended without its assistant_message
    await say("slowfail:1:partial text");
    const first = collector();
    expect(await runErrorCode(step({ sink: first.sink }))).toBe("model.invalid_request");
    expect(first.deltas[0]?.kind).toBe("text");
    expect(first.deltas.some((d) => d.kind === "step_reset")).toBe(false);
    // a new execution of the same step: clients drop the old draft before the offset-0 deltas
    const again = collector();
    expect(await runErrorCode(step({ sink: again.sink }))).toBe("model.invalid_request");
    expect(again.deltas[0]).toEqual({ kind: "step_reset", runId, step: 1 });
    expect(again.deltas.filter((d) => d.kind === "step_reset")).toHaveLength(1);
    expect(again.deltas.slice(1).some((d) => d.kind === "text")).toBe(true);
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

  /**
   * Intercepts the retry-after wait (the only 30 s timer) so a test can fire it by hand: faking
   * every timer starves the database driver, and a real 30 s wait is a fixed sleep.
   */
  const captureRetryWait = () => {
    const waits: { fire: () => void; cleared: boolean }[] = [];
    const real = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const set = vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms !== 30_000) return real(fn, ms);
      const w = { fire: fn, cleared: false };
      waits.push(w);
      return w as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    const clear = vi.spyOn(globalThis, "clearTimeout").mockImplementation(((t: unknown) => {
      const w = waits.find((x) => x === t);
      if (w) w.cleared = true;
      else realClear(t as NodeJS.Timeout);
    }) as typeof clearTimeout);
    const arrived = async () => {
      await vi.waitFor(() => expect(waits).toHaveLength(1));
      return waits[0] as { fire: () => void; cleared: boolean };
    };
    return {
      arrived,
      restore: () => {
        set.mockRestore();
        clear.mockRestore();
      },
    };
  };

  it("retry-after of 30 s that fits the run deadline → waited out on the same model", async () => {
    let n = 0;
    stubImpl = stub([stubInfo("flaky")], () => {
      if (++n === 1) throw new ModelError("rate_limited", "slow", { retryAfterMs: 30_000 });
      return "after the wait";
    });
    await say("hi");
    const timers = captureRetryWait();
    try {
      const pending = step({
        agent: agentWith({ model: { provider: "stub", model: "flaky" } }),
        deadline: Date.now() + 120_000,
      });
      const wait = await timers.arrived();
      expect(n).toBe(1);
      wait.fire();
      const r = await pending;
      expect(n).toBe(2);
      expect(r.content).toEqual([{ type: "text", text: "after the wait" }]);
    } finally {
      timers.restore();
    }
  });

  it("no run deadline: a 30 s retry-after is waited out on the same model", async () => {
    let n = 0;
    stubImpl = stub([stubInfo("flaky")], () => {
      if (++n === 1) throw new ModelError("rate_limited", "slow", { retryAfterMs: 30_000 });
      return "after the wait";
    });
    await say("hi");
    const timers = captureRetryWait();
    try {
      const pending = step({ agent: agentWith({ model: { provider: "stub", model: "flaky" } }) });
      const wait = await timers.arrived();
      expect(n).toBe(1);
      wait.fire();
      const r = await pending;
      expect(n).toBe(2);
      expect(r.content).toEqual([{ type: "text", text: "after the wait" }]);
    } finally {
      timers.restore();
    }
  });

  it("no run deadline: a retry-after above 5 minutes is not waited out", async () => {
    stubImpl = stub([stubInfo("limited")], () => {
      throw new ModelError("rate_limited", "slow", { retryAfterMs: 5 * 60_000 + 1 });
    });
    await say("hi");
    const code = await runErrorCode(
      step({ agent: agentWith({ model: { provider: "stub", model: "limited" } }) }),
    );
    expect(code).toBe("model.rate_limited");
    expect(await ofType("model_call")).toHaveLength(1);
  });

  it("retry-after longer than the time left to the deadline → fails without waiting", async () => {
    stubImpl = stub([stubInfo("limited")], () => {
      throw new ModelError("rate_limited", "slow", { retryAfterMs: 30_000 });
    });
    await say("hi");
    const code = await runErrorCode(
      step({
        agent: agentWith({ model: { provider: "stub", model: "limited" } }),
        deadline: Date.now() + 5_000,
      }),
    );
    expect(code).toBe("model.rate_limited");
    expect(await ofType("model_call")).toHaveLength(1);
  });

  it("abort interrupts a retry-after wait that fits the deadline", async () => {
    stubImpl = stub([stubInfo("busy")], () => {
      throw new ModelError("rate_limited", "slow", { retryAfterMs: 30_000 });
    });
    await say("hi");
    const ac = new AbortController();
    const timers = captureRetryWait();
    try {
      const pending = step({
        signal: ac.signal,
        agent: agentWith({ model: { provider: "stub", model: "busy" } }),
        deadline: Date.now() + 120_000,
      });
      const wait = await timers.arrived();
      ac.abort();
      const r = await pending;
      expect(wait.cleared).toBe(true);
      expect(r).toMatchObject({ aborted: true, content: [] });
      expect(await ofType("model_call")).toHaveLength(1);
    } finally {
      timers.restore();
    }
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
    const registry = providerRegistryFor(
      {
        list: (cap: string) => [
          ...k.app.get(ExtensionHost).list(cap),
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
        source: "web",
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
    const registry = providerRegistryFor(
      {
        list: (cap: string) => [
          ...k.app.get(ExtensionHost).list(cap),
          { plugin: "broken", capability: V2, impl: broken },
        ],
      },
      redis,
    );
    await say("hi");
    const p = runModelStep(
      { ...deps, registry },
      {
        source: "web",
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
    // the stall emits no text: there is no delta to hook the abort onto, so it is timed.
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
    // the abort must land inside the retry wait, after the stub's throw has been handled; no
    // seam marks that point.
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

    /** Run `fn` with the given compaction settings in effect (restored afterwards). */
    const withSettings = async (
      over: Partial<ReturnType<typeof COMPACTION_SETTINGS.parse>>,
      fn: () => Promise<void>,
    ): Promise<void> => {
      const real = deps.compactionSettings;
      deps.compactionSettings = stepSettingsStub(
        () => ({ ...COMPACTION_SETTINGS.parse({}), ...over }),
        () => ({ longTtl }),
      );
      try {
        await fn();
      } finally {
        deps.compactionSettings = real;
      }
    };

    it("超过阈值 → 先写 compaction_summary，再写 model_call（summarySeq 指向摘要）；下一步不再压缩", async () => {
      // fake-small's 2000-token window cannot hold the model's 4096 output cap and the default
      // 8000 reserve: a zero reserve keeps the target reachable (the hard line still arms)
      await withSettings({ reserveTokens: 0 }, async () => {
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
    });

    it("a successful compaction records savedTokens (transcript estimate minus the summary estimate)", async () => {
      await withSettings({ reserveTokens: 0 }, async () => {
        for (let i = 0; i < 8; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("echo:after compaction");
        const agent = agentWith({ model: { provider: "model-fake", model: "fake-small" } });
        const r = await step({ agent });
        expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);

        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.savedTokens).toBeGreaterThan(0);
        // the stored text is the model's answer, not the analysis scratchpad
        expect(summary?.payload.text.startsWith("Summary: ")).toBe(true);
      });
    });

    it("校正按总输入（未缓存 + 缓存读 + 缓存写）计算：大量缓存命中时仍会触发压缩", async () => {
      // 供应商把绝大部分输入报为缓存读，inputTokens 只是未缓存部分；三者之和等于真实输入。
      stubImpl = stub(
        [stubInfo("cached", { contextWindow: 2000 })],
        (req) => (req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer"),
        (_req, estimate) => ({
          inputTokens: 20,
          outputTokens: 2,
          cacheReadTokens: Math.max(0, estimate - 30),
          cacheWriteTokens: 10,
        }),
      );
      const agent = agentWith({ model: { provider: "stub", model: "cached" } });
      await withSettings({ reserveTokens: 0 }, async () => {
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
    });

    it("hard fit guard: a request over the window is trimmed and sent with the full output cap", async () => {
      // W 3000, O 1000, R 500 -> target 1500; the ~4000-token latest turn is over W itself. The cap
      // is clamped after the plan, from the post-fit input, so it stays min(O, W - 1) = 1000
      // (clamping from the pre-trim estimate used to send the trimmed request with a cap of 1)
      const model = stubInfo("capped", { contextWindow: 3000, maxOutputTokens: 1000 });
      stubImpl = stub([model], () => "ok");
      const agent = agentWith({ model: { provider: "stub", model: "capped" } });
      await withSettings({ enabled: false, reserveTokens: 500 }, async () => {
        await say("x".repeat(16_000));
        const r = await step({ agent });
        expect(r.content).toEqual([{ type: "text", text: "ok" }]);
        const sent = (stubImpl as Stub).calls.at(-1) as ModelRequest;
        const input = estimateTokens(sent.messages, sent.system, sent.tools);
        expect(sent.maxOutputTokens).toBe(1000);
        expect(input + sent.maxOutputTokens).toBeLessThanOrEqual(3000 - 500);
        // the sent cap is what was recorded, and the trim is in the log
        const [call] = await ofType("model_call");
        expect(call?.payload.request.maxOutputTokens).toBe(1000);
        expect(call?.payload.request.fit?.truncated).toEqual([
          {
            messageIndex: 0,
            block: 0,
            note: "[content truncated to fit the model's context window]",
          },
        ]);
      });
    });

    it("hard fit guard: a request over W - O_p - R_p drops the oldest assistant text and records the plan", async () => {
      // W 3600, O 1000, R 600 -> R_p = min(600, W/8) = 450, target 2150; the hard line is
      // estimate + O_p > W (2600), and proactive compaction is off, so only the hard fit guard trims
      const model = stubInfo("fit", { contextWindow: 3600, maxOutputTokens: 1000 });
      stubImpl = stub([model], () => "ok");
      const agent = agentWith({ model: { provider: "stub", model: "fit" } });
      await withSettings({ enabled: false, reserveTokens: 600 }, async () => {
        await say("old");
        await answer("x".repeat(9000));
        await say("latest");
        const r = await step({ agent });
        expect(r.content).toEqual([{ type: "text", text: "ok" }]);
        // the provider received the trimmed request: the huge older answer is gone
        const sent = (stubImpl as Stub).calls[0] as ModelRequest;
        expect(JSON.stringify(sent.messages)).not.toContain("xxxxxxxxxx");
        // the plan and the post-fit estimate are in the log (the request replays from them)
        const [call] = await ofType("model_call");
        expect(call?.payload.request.fit).toEqual({ droppedMessageIndexes: [1], truncated: [] });
        expect(call?.payload.request.estimatedInputTokens).toBeLessThan(500);
      });
    });

    it("a model whose output cap is above its window plans with the bounds: no compaction, no fit, the cap the window leaves", async () => {
      // W 2000, O 4096, R 8000 (the default): O_p 1000, R_p 250, target 750. Before the planning
      // bounds the target was about one token, so every step compacted and trimmed (spec §4.1)
      const model = stubInfo("wide-out", { contextWindow: 2000, maxOutputTokens: 4096 });
      const s = stub([model], (req) =>
        req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "ok",
      );
      stubImpl = s;
      const agent = agentWith({ model: { provider: "stub", model: "wide-out" } });
      await withSettings({}, async () => {
        await say("question");
        await answer("short answer");
        await say("go");
        expect((await step({ agent })).content).toEqual([{ type: "text", text: "ok" }]);
        expect(s.calls).toHaveLength(1);
        expect(await ofType("compaction_summary")).toHaveLength(0);
        expect(await ofType("compaction_failed")).toHaveLength(0);
        const [call] = await ofType("model_call");
        expect(call?.payload.request.fit).toBeUndefined();
        const input = call?.payload.request.estimatedInputTokens as number;
        expect(call?.payload.request.maxOutputTokens).toBe(2000 - input - 250);
        expect(s.calls[0]?.maxOutputTokens).toBe(2000 - input - 250);
      });
    });

    it("hard fit guard: system prompt and latest turn over the target -> run.context_too_large before any call", async () => {
      // a 100-token window and a system prompt longer than it: neither the latest turn nor the
      // system text can be trimmed under the target
      const model = stubInfo("tiny", { contextWindow: 100, maxOutputTokens: 1000 });
      stubImpl = stub([model], () => "ok");
      const agent = agentWith({
        instructions: "x".repeat(400),
        model: { provider: "stub", model: "tiny" },
      });
      await withSettings({ reserveTokens: 0 }, async () => {
        await say("hi");
        expect(await runErrorCode(step({ agent }))).toBe("run.context_too_large");
        expect((stubImpl as Stub).calls).toHaveLength(0);
        expect(await ofType("model_call")).toHaveLength(0);
      });
    });

    it("a sub-agent's step and compaction usage both add to the parent run's counter, once (§8.3)", async () => {
      const parentRunId = randomUUID();
      await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
        VALUES (${parentRunId}, ${conversationId}, 'waiting', 1, ${accountId}, 1)`.execute(raw);
      for (let i = 0; i < 8; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      await say("echo:after compaction");
      const input = {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith({ model: { provider: "model-fake", model: "fake-small" } }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
        parentRunId,
      };
      await withSettings({ reserveTokens: 0 }, async () => {
        await runModelStep(deps, { ...input, source: "web" });
        const usage = await ofType("usage");
        expect(usage.map((u) => u.payload.purpose ?? "step")).toEqual(["compaction", "step"]);
        const sum = usage.reduce(
          (n, u) =>
            n +
            u.payload.inputTokens +
            u.payload.outputTokens +
            u.payload.cacheReadTokens +
            u.payload.cacheWriteTokens,
          0,
        );
        const counter = async () =>
          Number(
            (
              await db
                .selectFrom("runs")
                .select("subagent_tokens_used")
                .where("id", "=", parentRunId)
                .executeTakeFirstOrThrow()
            ).subagent_tokens_used,
          );
        expect(sum).toBeGreaterThan(0);
        expect(await counter()).toBe(sum);
        // the same step again (a resume after a crash) hits the log and counts nothing more
        await runModelStep(deps, { ...input, source: "web" });
        expect(await counter()).toBe(sum);
      });
    });

    it("a sub-agent whose compaction call uses up the budget makes no step request (review M5)", async () => {
      const parentRunId = randomUUID();
      // one token below the configured cap: the compaction call's usage crosses it
      await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, subagent_tokens_used)
        VALUES (${parentRunId}, ${conversationId}, 'waiting', 1, ${accountId}, 1, 4999999)`.execute(
        raw,
      );
      for (let i = 0; i < 8; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      await say("echo:after compaction");
      const input = {
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith({ model: { provider: "model-fake", model: "fake-small" } }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
        parentRunId,
      };
      const r = await runModelStep(deps, { ...input, source: "web" });
      expect(r.budget).toBe(true);
      expect((await ofType("usage")).map((u) => u.payload.purpose ?? "step")).toEqual([
        "compaction",
      ]);
      expect((await ofType("assistant_message")).filter((e) => e.runId === runId)).toHaveLength(0);
      // the loop then hands back in the budget wrap-up at the same step: the one call over the
      // cap, with the budget reminder logged last
      const w = await runFinalWrapUp(deps, { ...input, source: "web" }, "budget");
      expect(w.budget).toBeUndefined();
      expect((await ofType("assistant_message")).filter((e) => e.runId === runId)).toHaveLength(1);
      expect((await ofType("reminder")).at(-1)?.payload.text).toBe(BUDGET_WRAP_UP_REMINDER);
    });

    it("keeps raw context when a capped compaction stops inside analysis", async () => {
      const scratchpad = `<analysis>${"unfinished reasoning ".repeat(30)}`;
      const s = stub(
        [stubInfo("small", { contextWindow: 15_000, maxOutputTokens: 1000 })],
        (req) => (req.purpose === "compaction" ? scratchpad : "answer"),
      );
      stubImpl = {
        ...s,
        async *stream(req, options) {
          for await (const event of s.stream(req, options)) {
            yield event.type === "message_complete" && req.purpose === "compaction"
              ? { ...event, stopReason: "max_tokens" as const }
              : event;
          }
        },
      };
      const marker = "original context must survive";
      for (let i = 0; i < 8; i++) {
        await say(`${marker} turn ${i}`.padEnd(3000, "x"));
        await answer(`answer ${i}`.padEnd(3000, "x"));
      }
      await say("go");
      const cap = 200;
      const reserve = 15_000 - cap - (11_000 + Math.ceil(cap / 2) + compactionRequestOverhead());
      await withSettings({ reserveTokens: reserve, maxOutputTokens: cap }, async () => {
        const result = await step({
          agent: agentWith({ model: { provider: "stub", model: "small" } }),
        });
        expect(result.content).toEqual([{ type: "text", text: "answer" }]);
        expect(await ofType("compaction_summary")).toHaveLength(0);
        expect(await ofType("compaction_failed")).toHaveLength(1);
        const request = s.calls.find((c) => c.purpose !== "compaction");
        expect(JSON.stringify(request?.messages)).toContain(marker);
        expect(JSON.stringify(request?.messages)).not.toContain(scratchpad);
      });
    });

    describe("a summary cut off at the output token limit", () => {
      const CAP = 200;
      // one call's transcript (eight 3000-character turns ≈ 1505 tokens each) fits a single
      // 11000-token chunk: the reserve is what the 15k window leaves below that chunk and the cap
      const single = () => stubInfo("small", { contextWindow: 15_000, maxOutputTokens: 1000 });
      const history = async () => {
        for (let i = 0; i < 8; i++) {
          await say(`turn ${i}`.padEnd(3000, "x"));
          await answer(`answer ${i}`.padEnd(3000, "x"));
        }
        await say("go");
      };
      const reserve = () =>
        15_000 - CAP - (11_000 + Math.ceil(CAP / 2) + compactionRequestOverhead());
      /** The user message's blocks: a retry carries the note as a second text block. */
      const blocksOf = (req: ModelRequest) => {
        const c = req.messages[0]?.content;
        return Array.isArray(c) ? c : [];
      };
      const isRetry = (req: ModelRequest) => blocksOf(req).length > 1;
      const noteOf = (req: ModelRequest): string => {
        const block = blocksOf(req)[1];
        return block?.type === "text" ? block.text : "";
      };

      it("is asked again once for a shorter summary, and the retried summary is stored", async () => {
        const s = stub(
          [single()],
          (req) =>
            req.purpose !== "compaction"
              ? "answer"
              : isRetry(req)
                ? `Short summary: ${"s".repeat(300)}`
                : `<analysis>done</analysis><summary>Long summary: ${"l".repeat(300)}`,
          undefined,
          (req) => (req.purpose === "compaction" && !isRetry(req) ? "max_tokens" : "end_turn"),
        );
        stubImpl = s;
        await history();
        await withSettings({ reserveTokens: reserve(), maxOutputTokens: CAP }, async () => {
          const r = await step({
            agent: agentWith({ model: { provider: "stub", model: "small" } }),
          });
          expect(r.content).toEqual([{ type: "text", text: "answer" }]);
          const calls = s.calls.filter((c) => c.purpose === "compaction");
          expect(calls).toHaveLength(2);
          // the retry is the same request with the shorter-summary note after the transcript
          expect(calls[1]?.system).toEqual(calls[0]?.system);
          expect(calls[1]?.messages[0]?.content[0]).toEqual(calls[0]?.messages[0]?.content[0]);
          expect(calls[1]?.maxOutputTokens).toBe(CAP);
          expect(noteOf(calls[1] as ModelRequest)).toContain("output token limit");
          // the truncated text is never stored: only the retried one
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload.text).toBe(`Short summary: ${"s".repeat(300)}`);
          expect(await ofType("compaction_failed")).toEqual([]);
          // both calls are billed, each with its own usage event (its own idempotency key)
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage).toHaveLength(2);
        });
      });

      it("fails the compaction through compaction_failed when the retry is cut off too", async () => {
        const s = stub(
          [single()],
          (req) => (req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer"),
          undefined,
          (req) => (req.purpose === "compaction" ? "max_tokens" : "end_turn"),
        );
        stubImpl = s;
        await history();
        await withSettings({ reserveTokens: reserve(), maxOutputTokens: CAP }, async () => {
          const agent = agentWith({ model: { provider: "stub", model: "small" } });
          // the step continues with its raw context
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          expect(s.calls.filter((c) => c.purpose === "compaction")).toHaveLength(2);
          expect(await ofType("compaction_summary")).toEqual([]);
          const failed = await ofType("compaction_failed");
          expect(failed.map((f) => f.payload.attempt)).toEqual([1]);
          expect(failed[0]?.payload.reason).toBe(
            `summary cut off at the output token limit (${CAP} tokens), also when asked again for a shorter one`,
          );
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage).toHaveLength(2);
          // the backoff applies as after any failed compaction: the next turn makes no call
          await say("again");
          runId = randomUUID();
          await step({ agent });
          expect(s.calls.filter((c) => c.purpose === "compaction")).toHaveLength(2);
        });
      });

      it("model-fake: a scripted summary longer than the cap stops at max_tokens and fails the compaction", async () => {
        // model-fake cuts a reply at maxOutputTokens * 4 characters and reports max_tokens; its
        // compaction reply ("Summary: " + 200 characters) is over a 30-token cap both times
        await withSettings({ reserveTokens: 0, maxOutputTokens: 30 }, async () => {
          for (let i = 0; i < 8; i++) {
            await say(filler(i));
            await answer(filler(i));
          }
          await say("echo:after compaction");
          const agent = agentWith({ model: { provider: "model-fake", model: "fake-small" } });
          const r = await step({ agent });
          expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);
          expect(await ofType("compaction_summary")).toEqual([]);
          const failed = await ofType("compaction_failed");
          expect(failed).toHaveLength(1);
          expect(failed[0]?.payload.reason).toContain("output token limit (30 tokens)");
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage).toHaveLength(2);
        });
      });
    });

    it("a too-short summary writes compaction_failed (attempt 1) and the step completes; the next turn is skipped by the backoff; after it lapses attempt 2 fails again", async () => {
      // a window above the output cap (O = 1000) keeps the proactive trigger below the hard line,
      // where the backoff still applies
      const s = stub(
        [stubInfo("small", { contextWindow: 15_000, maxOutputTokens: 1000 })],
        (req) => (req.purpose === "compaction" ? "too short" : "answer"),
      );
      stubImpl = s;
      // 3000 ASCII characters per turn ≈ 1505 tokens, so one attempt's transcript (5 turns, and 7
      // on the third turn below) fits a single chunk and the counts stay one call per attempt
      const bigFiller = (n: number) => `turn ${n} `.padEnd(3000, "x");
      for (let i = 0; i < 8; i++) {
        await say(bigFiller(i));
        await answer(bigFiller(i));
      }
      await say("go");
      const agent = agentWith({ model: { provider: "stub", model: "small" } });
      // The chunk budget (§4.5) subtracts the summary allowance and the request's fixed overhead:
      // a 11000-token chunk needs B = 11000 + 100 + overhead, and the reserve is what the 15k
      // window leaves below B and the 200-token cap. The whole history (8 turns) estimates well
      // over B, so the proactive trigger fires below the hard line and the backoff applies.
      const CAP = 200;
      const CHUNK = 11_000;
      const reserve = 15_000 - CAP - (CHUNK + Math.ceil(CAP / 2) + compactionRequestOverhead());
      await withSettings({ reserveTokens: reserve, maxOutputTokens: CAP }, async () => {
        const r = await step({ agent });
        expect(r.content).toEqual([{ type: "text", text: "answer" }]);
        const failed = await ofType("compaction_failed");
        expect(failed.map((f) => f.payload.attempt)).toEqual([1]);
        expect(await ofType("compaction_summary")).toHaveLength(0);
        const compactionCalls = () => s.calls.filter((c) => c.purpose === "compaction").length;
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

    it("the hard line compacts even with enabled: false, and proactive compaction stays off below it (spec §4.1)", async () => {
      stubImpl = stub([stubInfo("tight", { contextWindow: 6000, maxOutputTokens: 1000 })], (req) =>
        req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer",
      );
      const agent = agentWith({ model: { provider: "stub", model: "tight" } });
      const original = deps.compactionSettings;
      // a zero reserve: a 6000-token window cannot hold the output cap plus the default 8000
      deps.compactionSettings = stepSettingsStub(
        () => ({ ...COMPACTION_SETTINGS.parse({}), enabled: false, reserveTokens: 0 }),
        () => ({ longTtl }),
      );
      try {
        // 15 turns ≈ 3000 tokens, below the hard line (6000 - 1000): proactive compaction is off
        for (let i = 0; i < 15; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
        await step({ agent });
        expect(await ofType("compaction_summary")).toHaveLength(0);

        // 15 more turns put the estimate over the hard line: it compacts even with enabled: false
        for (let i = 15; i < 30; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("again");
        runId = randomUUID();
        await step({ agent });
        expect(await ofType("compaction_summary")).toHaveLength(1);
      } finally {
        deps.compactionSettings = original;
      }
    });

    it("the hard line still attempts compaction during a backoff (spec §4.1)", async () => {
      stubImpl = stub([stubInfo("tight", { contextWindow: 6000, maxOutputTokens: 1000 })], (req) =>
        req.purpose === "compaction" ? "too short" : "answer",
      );
      const agent = agentWith({ model: { provider: "stub", model: "tight" } });
      for (let i = 0; i < 30; i++) {
        await say(filler(i));
        await answer(filler(i));
      }
      // the previous compaction failed and no user turn has arrived since: proactive compaction backs off
      await eventLog.append(conversationId, [
        {
          type: "compaction_failed",
          runId: "old-run",
          payload: { attempt: 1, reason: "too short", step: 0 },
        },
      ]);
      await say("go");
      // a zero reserve: a 6000-token window cannot hold the output cap plus the default 8000
      await withSettings({ reserveTokens: 0 }, async () => {
        await step({ agent });
      });
      // the hard line bypasses the backoff: another failure is written (attempt 2), not skipped
      expect((await ofType("compaction_failed")).map((f) => f.payload.attempt)).toEqual([1, 2]);
    });

    describe("reactive compaction (context overflow, spec §4.4)", () => {
      /** `history` turns of filler so the forced compaction has a transcript to summarise. */
      const history = async () => {
        for (let i = 0; i < 6; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
      };

      /** A fake media source that hands out one image's bytes (a vision model sends them). */
      const imageMedia = (data: Uint8Array): Pick<ModelStepDeps, "media"> => ({
        media: {
          info: async (_o, _c, ids) =>
            new Map(
              ids.map((id): [string, MediaInfo] => [
                id,
                {
                  size: data.byteLength,
                  pages: null,
                  uri: `capybara://attachments/${id}`,
                },
              ]),
            ),
          fetch: async (_o, _c, ids) =>
            new Map(ids.map((id): [string, MediaBytes] => [id, { mediaType: "image/png", data }])),
        },
      });

      const sayImage = async (attachmentId: string) => {
        await eventLog.append(conversationId, [
          {
            type: "user_message",
            payload: {
              content: [
                { type: "text", text: "look" },
                {
                  type: "image",
                  mediaType: "image/png",
                  source: { kind: "ref", fileId: attachmentId },
                  name: "pic.png",
                },
              ],
              authorAccountId: accountId,
            },
          },
        ]);
      };

      const vision = () =>
        stubInfo("vision", { capabilities: { ...stubInfo("x").capabilities, vision: true } });

      /** Whether a request carries an image content block (m.content may be a plain string). */
      const hasImage = (req: ModelRequest): boolean =>
        req.messages.some(
          (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image"),
        );

      const customStep = (d: ModelStepDeps, agent: AgentDefinition) =>
        runModelStep(d, {
          source: "web",
          orgId,
          conversationId,
          runId,
          step: 1,
          agent,
          agentVersion: 1,
          absorbedUpToSeq: ALL_ABSORBED,
          signal: new AbortController().signal,
          sink: () => {},
        });

      it("a context_overflow then success after forced compaction logs compaction_summary before the retried model_call", async () => {
        let stepCalls = 0;
        const s = stub([stubInfo("compact")], (req) => {
          if (req.purpose === "compaction") {
            return `Summary: ${"s".repeat(300)}`;
          }
          stepCalls++;
          if (stepCalls === 1) throw new ModelError("context_overflow", "too long");
          return "after compaction";
        });
        stubImpl = s;
        await history();
        await say("go");
        const agent = agentWith({ model: { provider: "stub", model: "compact" } });
        // proactive compaction off: only the reactive path may compact (spec §4.1/§4.4)
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect((await step({ agent })).content).toEqual([
            { type: "text", text: "after compaction" },
          ]);
          const events = await all();
          const summary = events.find((e) => e.type === "compaction_summary");
          const calls = events.filter((e) => e.type === "model_call");
          expect(summary).toBeDefined();
          expect(calls).toHaveLength(2);
          // the summary is written before the retried request and is what it carries
          expect((summary as ConversationEvent).seq).toBeLessThan(
            (calls[1] as ConversationEvent).seq,
          );
          const second = calls[1] as Extract<ConversationEvent, { type: "model_call" }>;
          expect(second.payload.request.summarySeq).toBe(summary?.seq);
          expect(await ofType("media_excluded")).toEqual([]);
        });
      });

      it("a media-carrying overflow writes media_excluded and retries the same step with a placeholder", async () => {
        const id = randomUUID();
        const s = stub([vision()], (req) => {
          if (hasImage(req)) throw new ModelError("context_overflow", "too many bytes");
          return "without media";
        });
        stubImpl = s;
        await sayImage(id);
        const agent = agentWith({ model: { provider: "stub", model: "vision" } });
        const r = await customStep({ ...deps, ...imageMedia(new Uint8Array([1, 2, 3])) }, agent);
        expect(r.content).toEqual([{ type: "text", text: "without media" }]);
        const excluded = await ofType("media_excluded");
        expect(excluded.map((e) => e.payload.attachmentIds)).toEqual([[id]]);
        expect(await ofType("model_call")).toHaveLength(2);
        // the retry was rebuilt from the log: the image is a "rejected" placeholder, no bytes
        const second = s.calls[1] as ModelRequest;
        expect(hasImage(second)).toBe(false);
        expect(JSON.stringify(second.messages)).toContain("was rejected by the model provider");
      });

      it("a fallback rung with a smaller window compacts against the fallback model", async () => {
        let fallbackStepCalls = 0;
        const s = stub([stubInfo("main"), stubInfo("fb", { contextWindow: 4000 })], (req) => {
          if (req.model === "main") throw new ModelError("server", "down", { retryAfterMs: 1 });
          if (req.purpose === "compaction") {
            return `Summary: ${"s".repeat(300)}`;
          }
          fallbackStepCalls++;
          if (fallbackStepCalls === 1) throw new ModelError("context_overflow", "too long");
          return "fb answer";
        });
        stubImpl = s;
        await history();
        await say("go");
        const agent = agentWith({
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "fb answer" }]);
          const compactionCalls = s.calls.filter((c) => c.purpose === "compaction");
          expect(compactionCalls).toHaveLength(1);
          expect(compactionCalls[0]?.model).toBe("fb");
        });
      });

      it("consecutive overflows: media exclusion, forced compaction, then no trim when nothing is left to trim (spec §4.3 point 6)", async () => {
        const id = randomUUID();
        let compactionCalls = 0;
        const s = stub([vision()], (req) => {
          if (req.purpose === "compaction") {
            compactionCalls++;
            return `Summary: ${"s".repeat(300)}`;
          }
          throw new ModelError("context_overflow", "always too long");
        });
        stubImpl = s;
        await history();
        await sayImage(id);
        const agent = agentWith({ model: { provider: "stub", model: "vision" } });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect(
            await runErrorCode(
              customStep({ ...deps, ...imageMedia(new Uint8Array([9, 9, 9])) }, agent),
            ),
          ).toBe("model.context_overflow");
          // media exclusion and forced compaction: three attempts; the compacted request already
          // fits 70% of the fit target, so a trim would resend it unchanged: no fourth attempt
          expect(await ofType("model_call")).toHaveLength(3);
          expect(compactionCalls).toBe(1);
          expect(await ofType("media_excluded")).toHaveLength(1);
        });
      });

      it("a reactive trim really shrinks a request the estimate thought fit (records a fit plan)", async () => {
        // W 2000, output cap 100: a ~1700 estimate stays below the hard line (1900), so proactive
        // compaction never runs, yet the provider rejects it. The trim retry must actually drop
        // history rather than leave the optimistic request unchanged.
        const s = stub(
          [stubInfo("trimmed", { contextWindow: 2000, maxOutputTokens: 100 })],
          (req) => {
            if (req.purpose === "compaction") return "too short";
            if (estimateTokens(req.messages, req.system, req.tools) > 1500) {
              throw new ModelError("context_overflow", "estimate said it fit");
            }
            return "trimmed answer";
          },
        );
        stubImpl = s;
        for (let i = 0; i < 8; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
        const agent = agentWith({ model: { provider: "stub", model: "trimmed" } });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect((await step({ agent })).content).toEqual([
            { type: "text", text: "trimmed answer" },
          ]);
          const calls = await ofType("model_call");
          // initial request, the (failed) forced-compaction retry, then the trim retry
          expect(calls).toHaveLength(3);
          expect(await ofType("compaction_failed")).toHaveLength(1);
          // the optimistic request carried no fit; the trim retry is trimmed to 70% of W
          expect(calls[0]?.payload.request.fit).toBeUndefined();
          expect(calls[2]?.payload.request.fit?.droppedMessageIndexes.length ?? 0).toBeGreaterThan(
            0,
          );
          expect(calls[2]?.payload.request.estimatedInputTokens).toBeLessThan(
            calls[0]?.payload.request.estimatedInputTokens as number,
          );
        });
      });

      it("a reactive trim uses the most aggressive target it reaches (80% when 70% is out of reach)", async () => {
        // W 20000, O 100, R 0: fit target 19900; reactive targets 13930 (70%), 15920 (80%) and
        // 17910 (90%). The ~14500-token system prompt alone is over the 70% target, so only the 80%
        // plan reaches its target; the unreachable 70% plan would drop the whole history for nothing.
        let calls = 0;
        stubImpl = stub(
          [stubInfo("aggressive", { contextWindow: 20_000, maxOutputTokens: 100 })],
          (req) => {
            if (req.purpose === "compaction") return "too short";
            calls++;
            if (calls <= 2) throw new ModelError("context_overflow", "estimate said it fit");
            return "trimmed answer";
          },
        );
        for (let i = 0; i < 10; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
        const agent = agentWith({
          instructions: "x".repeat(4 * 14_500),
          model: { provider: "stub", model: "aggressive" },
        });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect((await step({ agent })).content).toEqual([
            { type: "text", text: "trimmed answer" },
          ]);
          const rows = await ofType("model_call");
          // initial request, the (failed) forced-compaction retry, then the trim retry
          expect(rows).toHaveLength(3);
          const trim = rows[2]?.payload.request;
          const dropped = trim?.fit?.droppedMessageIndexes ?? [];
          expect(dropped.length).toBeGreaterThan(0);
          // the 80% plan: at or below its target, and part of the history is still sent
          expect(trim?.estimatedInputTokens).toBeLessThanOrEqual(15_920);
          expect(dropped.length).toBeLessThan(20);
          const sent = (stubImpl as Stub).calls.at(-1) as ModelRequest;
          expect(JSON.stringify(sent.messages)).toContain("turn 9 ");
          expect(trim?.maxOutputTokens).toBe(100);
        });
      });

      it("a persistent overflow across a fallback stops at four model_call rows with model.context_overflow", async () => {
        const s = stub([stubInfo("main"), stubInfo("fb", { contextWindow: 4000 })], (req) => {
          if (req.purpose === "compaction") {
            return `Summary: ${"s".repeat(300)}`;
          }
          throw new ModelError("context_overflow", "always too long");
        });
        stubImpl = s;
        await history();
        await say("go");
        const agent = agentWith({
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect(await runErrorCode(step({ agent }))).toBe("model.context_overflow");
          // main: initial + compaction (2 rows), nothing left to trim, so the fallback; fallback:
          // initial + compaction (2 rows), nothing to trim: model.context_overflow, never a loop
          expect(await ofType("model_call")).toHaveLength(4);
        });
      });

      const isCompactionCall = (req: ModelRequest): boolean => req.purpose === "compaction";

      const compactionUsages = async () =>
        (await ofType("usage")).filter((e) => e.payload.purpose === "compaction");

      it("a proactive summary and a forced one in the same step write two summaries and two usages", async () => {
        // the agent's model (W 3000) compacts proactively and then fails; the fallback (W 700)
        // overflows and compacts again with its own model: each compaction has its own keys, so
        // the second summary and its usage are not dropped as a repeat of the first (spec §4.4)
        let fbCalls = 0;
        const s = stub(
          [
            // W 3000 at threshold 0.5: compacts proactively in one summary call (the instruction's
            // overhead leaves room for the whole transcript)
            stubInfo("main", { contextWindow: 3000, maxOutputTokens: 100 }),
            stubInfo("fb", { contextWindow: 700, maxOutputTokens: 100 }),
          ],
          (req) => {
            if (isCompactionCall(req)) return `Summary: ${"s".repeat(300)}`;
            if (req.model === "main") throw new ModelError("server", "down", { retryAfterMs: 1 });
            fbCalls++;
            if (fbCalls === 1) throw new ModelError("context_overflow", "too long");
            return "fb answer";
          },
        );
        stubImpl = s;
        for (let i = 0; i < 8; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
        const agent = agentWith({
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });
        await withSettings({ reserveTokens: 0, threshold: 0.5 }, async () => {
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "fb answer" }]);
          expect(s.calls.filter(isCompactionCall).map((c) => c.model)).toEqual(["main", "fb"]);
          const summaries = await ofType("compaction_summary");
          expect(summaries).toHaveLength(2);
          expect(await compactionUsages()).toHaveLength(2);
          // the retried fallback request carries the second summary
          const last = (await ofType("model_call")).at(-1);
          expect(last?.payload.request.summarySeq).toBe(summaries[1]?.seq);
        });
      });

      it("compactions are counted by their recorded step: an earlier-step event between them does not reuse a key", async () => {
        // same two compactions as above, at step 2, with an event of this run from step 1 logged
        // between them (a writer outside the step): the second compaction still gets its own keys
        let fbCalls = 0;
        const s = stub(
          [
            // W 3000 at threshold 0.5: compacts proactively in one summary call (the instruction's
            // overhead leaves room for the whole transcript)
            stubInfo("main", { contextWindow: 3000, maxOutputTokens: 100 }),
            stubInfo("fb", { contextWindow: 700, maxOutputTokens: 100 }),
          ],
          (req) => {
            if (isCompactionCall(req)) return `Summary: ${"s".repeat(300)}`;
            if (req.model === "main") throw new ModelError("server", "down", { retryAfterMs: 1 });
            fbCalls++;
            if (fbCalls === 1) throw new ModelError("context_overflow", "too long");
            return "fb answer";
          },
        );
        stubImpl = s;
        for (let i = 0; i < 8; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
        const original = deps.stepLog.appendReported.bind(deps.stepLog);
        let injected = false;
        const spy = vi
          .spyOn(deps.stepLog, "appendReported")
          .mockImplementation(async (conversation, evs) => {
            const r = await original(conversation, evs);
            if (!injected && evs.some((e) => e.type === "compaction_summary")) {
              injected = true;
              const late = await eventLog.append(conversationId, [
                { type: "reminder", runId, payload: { step: 1, text: "late step-1 note" } },
              ]);
              return { ...r, written: [...r.written, ...late] };
            }
            return r;
          });
        const agent = agentWith({
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });
        try {
          await withSettings({ reserveTokens: 0, threshold: 0.5 }, async () => {
            expect((await step({ step: 2, agent })).content).toEqual([
              { type: "text", text: "fb answer" },
            ]);
          });
        } finally {
          spy.mockRestore();
        }
        expect(injected).toBe(true);
        const summaries = await ofType("compaction_summary");
        expect(summaries).toHaveLength(2);
        expect(summaries.map((e) => e.payload.step)).toEqual([2, 2]);
        expect(await compactionUsages()).toHaveLength(2);
      });

      it("a step re-run after a crash between the summary call and its write writes one summary", async () => {
        await withSettings({ reserveTokens: 0 }, async () => {
          for (let i = 0; i < 8; i++) {
            await say(filler(i));
            await answer(filler(i));
          }
          await say("echo:after compaction");
          const agent = agentWith({ model: { provider: "model-fake", model: "fake-small" } });
          const original = deps.stepLog.appendReported.bind(deps.stepLog);
          let crashed = false;
          const spy = vi
            .spyOn(deps.stepLog, "appendReported")
            .mockImplementation(async (conversation, evs) => {
              if (!crashed && evs.some((e) => e.type === "compaction_summary")) {
                crashed = true;
                throw new Error("crash before the summary write");
              }
              return original(conversation, evs);
            });
          try {
            await expect(step({ agent })).rejects.toThrow("crash before the summary write");
            expect(await ofType("compaction_summary")).toHaveLength(0);
            const r = await step({ agent });
            expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);
          } finally {
            spy.mockRestore();
          }
          expect(await ofType("compaction_summary")).toHaveLength(1);
          expect(await compactionUsages()).toHaveLength(1);
        });
      });

      /** An earlier summary of ~3000 tokens: the agent's model holds it, a 2200-token window cannot. */
      const largeSummaryHistory = async () => {
        await say("old");
        await answer("old answer");
        const covered = (await all()).at(-1) as ConversationEvent;
        await eventLog.append(conversationId, [
          {
            type: "compaction_summary",
            runId: "old-run",
            payload: {
              coversUpToSeq: covered.seq,
              text: `Summary: ${"o".repeat(12_000)}`,
              savedTokens: 0,
              step: 0,
            },
          },
        ]);
        for (let i = 0; i < 6; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say("go");
      };

      /** The agent's model always fails; the fallback (W 2200) overflows on its first `overflows` calls. */
      const fallbackStub = (overflows: number) => {
        let fbCalls = 0;
        return stub(
          [stubInfo("main"), stubInfo("fb", { contextWindow: 2200, maxOutputTokens: 100 })],
          (req) => {
            if (isCompactionCall(req)) return `Summary: ${"s".repeat(300)}`;
            if (req.model === "main") throw new ModelError("server", "down", { retryAfterMs: 1 });
            fbCalls++;
            if (fbCalls <= overflows) throw new ModelError("context_overflow", "too long");
            return "fb answer";
          },
        );
      };
      const fallbackAgent = () =>
        agentWith({
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });

      it("a fallback rung the guard cannot fit compacts once with its own model before sending", async () => {
        // the fallback's 2200-token window cannot hold the earlier summary, which the fit plan never
        // drops: the guard compacts with the fallback's model, rebuilds and sends (spec §4.3 point 5)
        const s = fallbackStub(0);
        stubImpl = s;
        await largeSummaryHistory();
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect((await step({ agent: fallbackAgent() })).content).toEqual([
            { type: "text", text: "fb answer" },
          ]);
          // one compaction (chunked: the earlier summary is over the fallback's chunk size), with
          // the fallback's model, before any fallback request went out
          const compactions = s.calls.filter(isCompactionCall);
          expect(compactions.length).toBeGreaterThan(0);
          expect(compactions.every((c) => c.model === "fb")).toBe(true);
          const firstFb = s.calls.findIndex((c) => c.model === "fb" && !isCompactionCall(c));
          expect(s.calls.indexOf(compactions.at(-1) as ModelRequest)).toBeLessThan(firstFb);
          // main twice, then the fallback's compacted request: no extra row for the compaction
          const rows = await ofType("model_call");
          expect(rows.map((r) => r.payload.model)).toEqual(["main", "main", "fb"]);
          const summaries = await ofType("compaction_summary");
          expect(summaries).toHaveLength(2);
          expect(rows[2]?.payload.request.summarySeq).toBe(summaries[1]?.seq);
          expect(rows[2]?.payload.request.fit).toBeUndefined();
          expect(rows[2]?.payload.request.maxOutputTokens).toBe(100);
        });
      });

      it("the guard's compaction is the rung's compaction fix-up: a later overflow does not compact again", async () => {
        const s = fallbackStub(1);
        stubImpl = s;
        await largeSummaryHistory();
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          // the overflow goes to the trim; the compacted request already fits 70% of the target, so
          // there is nothing to trim and the overflow surfaces (spec §4.3 point 6)
          expect(await runErrorCode(step({ agent: fallbackAgent() }))).toBe(
            "model.context_overflow",
          );
          const firstFb = s.calls.findIndex((c) => c.model === "fb" && !isCompactionCall(c));
          const lastCompaction = s.calls.findLastIndex(isCompactionCall);
          expect(lastCompaction).toBeLessThan(firstFb);
          expect(await ofType("compaction_summary")).toHaveLength(2);
          expect((await ofType("model_call")).map((r) => r.payload.model)).toEqual([
            "main",
            "main",
            "fb",
          ]);
        });
      });

      it("a sub-agent whose budget the guard's compaction uses up makes no fallback request", async () => {
        const parentRunId = randomUUID();
        // one token below the configured cap: the compaction call's usage crosses it
        await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, subagent_tokens_used)
          VALUES (${parentRunId}, ${conversationId}, 'waiting', 1, ${accountId}, 1, 4999999)`.execute(
          raw,
        );
        const s = fallbackStub(0);
        stubImpl = s;
        await largeSummaryHistory();
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          const r = await runModelStep(deps, {
            source: "web",
            orgId,
            conversationId,
            runId,
            step: 1,
            agent: fallbackAgent(),
            agentVersion: 1,
            absorbedUpToSeq: ALL_ABSORBED,
            signal: new AbortController().signal,
            sink: () => {},
            parentRunId,
          });
          expect(r.budget).toBe(true);
          expect(s.calls.filter((c) => c.model === "fb" && !isCompactionCall(c))).toHaveLength(0);
          expect((await ofType("model_call")).map((c) => c.payload.model)).toEqual([
            "main",
            "main",
          ]);
        });
      });

      it("run.context_too_large only after the forced compaction still cannot fit the rung", async () => {
        // the system prompt alone is over the fallback's window: compaction cannot help
        const s = stub(
          [stubInfo("main"), stubInfo("fb", { contextWindow: 2200, maxOutputTokens: 100 })],
          (req) => {
            if (isCompactionCall(req)) return `Summary: ${"s".repeat(300)}`;
            throw new ModelError("server", "down", { retryAfterMs: 1 });
          },
        );
        stubImpl = s;
        await largeSummaryHistory();
        const agent = agentWith({
          instructions: "x".repeat(4 * 2500),
          model: { provider: "stub", model: "main" },
          fallback: { provider: "stub", model: "fb" },
        });
        await withSettings({ enabled: false, reserveTokens: 0 }, async () => {
          expect(await runErrorCode(step({ agent }))).toBe("run.context_too_large");
          // one (chunked) compaction with the fallback's model, then the failure
          const compactions = s.calls.filter(isCompactionCall);
          expect(compactions.length).toBeGreaterThan(0);
          expect(compactions.every((c) => c.model === "fb")).toBe(true);
          expect(await ofType("compaction_summary")).toHaveLength(2);
          // no fallback request was sent or logged
          expect(s.calls.filter((c) => c.model === "fb" && !isCompactionCall(c))).toHaveLength(0);
          expect((await ofType("model_call")).map((r) => r.payload.model)).toEqual([
            "main",
            "main",
          ]);
        });
      });
    });

    describe("the in-context summary (idle compaction spec §9.4)", () => {
      /** The agent of these cases: one builtin tool, so requests declare tools. */
      const icAgent = (model = "fake-1") =>
        agentWith({
          model: { provider: "model-fake", model },
          disabledTools: onlyBuiltins([{ kind: "builtin", name: "ReadToolOutput" }]),
        });

      /** The agent version and run rows `liveSnapshot` reads. */
      const seedRun = async (id: string, agent: AgentDefinition = icAgent()) => {
        await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
          VALUES (${agentId}, 1, ${JSON.stringify(agent)}::jsonb, ${accountId})
          ON CONFLICT DO NOTHING`.execute(raw);
        await sql`UPDATE capybara.runs SET status = 'completed'
          WHERE conversation_id = ${conversationId} AND status = 'running'`.execute(raw);
        await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
          VALUES (${id}, ${conversationId}, 'running', 1, ${accountId}, 0)`.execute(raw);
      };

      interface Harness {
        /** Every request the providers received (deep copies, in order). */
        sent: ModelRequest[];
        /** The reasons of the `in-context summary skipped` debug lines. */
        skips: string[];
        /** The messages of the `warn` lines with `context=Compaction`. */
        warns: string[];
        /** Every `context=Compaction` line: level, message and reason. */
        lines: { level: string; msg: string; reason?: string }[];
        d: ModelStepDeps;
      }

      /**
       * Step deps with the live snapshot wired as `RunSteps` wires it, a debug logger and a
       * provider wrapper that records requests; `overflowOnce` fails the first step request of
       * step `overflowOnce` with `context_overflow`.
       */
      const harness = (
        opts: {
          overflowOnce?: number;
          hooks?: ModelStepDeps["hooks"];
          /** Runs before the live snapshot is read; a throw fails the snapshot. */
          beforeSnapshot?: () => void;
          /** The compaction model port (absent: unmapped). */
          compactionModel?: ModelStepDeps["compactionModel"];
          /** A configured model name whose `registry.resolve` throws. */
          resolveFails?: string;
          /** A model id whose every summary call fails with a scripted error. */
          failModel?: string;
        } = {},
      ) => {
        const sent: ModelRequest[] = [];
        const skips: string[] = [];
        const warns: string[] = [];
        const lines: Harness["lines"] = [];
        let overflowed = false;
        const log = createLogger("debug", {
          write: (line) => {
            const rec = JSON.parse(line) as {
              msg?: string;
              reason?: string;
              context?: string;
              level?: string | number;
            };
            if (rec.msg === "in-context summary skipped" && rec.context === "Compaction") {
              skips.push(rec.reason ?? "");
            }
            if ((rec.level === "warn" || rec.level === 40) && rec.context === "Compaction") {
              warns.push(rec.msg ?? "");
            }
            if (rec.context === "Compaction") {
              const level =
                rec.level === 40 ? "warn" : rec.level === 20 ? "debug" : String(rec.level);
              lines.push({
                level,
                msg: rec.msg ?? "",
                ...(rec.reason !== undefined && { reason: rec.reason }),
              });
            }
          },
        });
        const d: ModelStepDeps = {
          ...deps,
          // read through: withSettings swaps the shared deps' settings
          get compactionSettings() {
            return deps.compactionSettings;
          },
          log,
          ...(opts.hooks !== undefined && { hooks: opts.hooks }),
          ...(opts.compactionModel !== undefined && { compactionModel: opts.compactionModel }),
          liveSnapshot: async (o, c, r, a, events) => {
            opts.beforeSnapshot?.();
            return liveSnapshot(db, { orgId: o, conversationId: c, runId: r, agentId: a, events });
          },
          registry: {
            resolve: async (...args: Parameters<ModelStepDeps["registry"]["resolve"]>) => {
              if (opts.resolveFails !== undefined && args[1].model === opts.resolveFails) {
                throw new Error("the provider's model list failed");
              }
              const got = await deps.registry.resolve(...args);
              return {
                ...got,
                provider: {
                  ...got.provider,
                  stream(req, o) {
                    sent.push(structuredClone(req));
                    if (req.purpose === "compaction" && req.model === opts.failModel) {
                      // biome-ignore lint/correctness/useYield: fails before the first event
                      return (async function* (): AsyncGenerator<ModelStreamEvent> {
                        throw new ModelError("invalid_request", "Scripted summarizer failure");
                      })();
                    }
                    if (
                      opts.overflowOnce !== undefined &&
                      !overflowed &&
                      req.purpose === undefined &&
                      sent.filter((s) => s.purpose === undefined).length === opts.overflowOnce
                    ) {
                      overflowed = true;
                      // biome-ignore lint/correctness/useYield: fails before the first event
                      return (async function* (): AsyncGenerator<ModelStreamEvent> {
                        throw new ModelError("context_overflow", "too long");
                      })();
                    }
                    return got.provider.stream(req, o);
                  },
                },
              };
            },
          },
        };
        return { sent, skips, warns, lines, d } satisfies Harness;
      };

      /** The latest seq in the log below `seq`. */
      const lastSeqBefore = async (seq: number | undefined) =>
        Math.max(...(await all()).filter((e) => e.seq < (seq ?? 0)).map((e) => e.seq));

      /** The latest seq in the log: what a step starting now absorbs. */
      const lastSeq = async () => Math.max(...(await all()).map((e) => e.seq));

      const icStep = async (
        d: ModelStepDeps,
        n: number,
        agent = icAgent(),
        opts: { absorbedUpToSeq?: number; signal?: AbortSignal } = {},
      ) =>
        runModelStep(d, {
          source: "web",
          orgId,
          conversationId,
          runId,
          step: n,
          agent,
          agentVersion: 1,
          absorbedUpToSeq: opts.absorbedUpToSeq ?? (await lastSeq()),
          signal: opts.signal ?? new AbortController().signal,
          sink: () => {},
          agentId,
          accountId,
          conversationKind: "chat",
        });

      /**
       * Four filler turns, `extra` user messages (script lines for the summary call), then step 1
       * with proactive compaction off: a recorded, cached model call to summarize from.
       */
      const cachedStep = async (h: Harness, extra: string[] = []) => {
        await seedRun(runId);
        for (let i = 0; i < 4; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        for (const line of extra) await say(line);
        await say("echo:first");
        await withSettings({ enabled: false }, async () => {
          await icStep(h.d, 1);
        });
        expect(await ofType("compaction_summary")).toEqual([]);
      };

      /**
       * A new run opened by `text`, as a person's message starts one: the message, then the run's
       * `run_started` (its step 1 re-renders the message after a summary: `openingSeqs`).
       */
      const nextTurn = async (text: string) => {
        runId = randomUUID();
        await seedRun(runId);
        await say(text);
        await eventLog.append(conversationId, [
          {
            type: "run_started",
            runId,
            payload: {
              agentVersion: 1,
              model: { provider: "model-fake", model: "fake-1" },
              triggerAccountId: accountId,
              trigger: "message",
            },
          },
        ]);
        return (await ofType("user_message")).at(-1)?.seq as number;
      };

      /** A low threshold: the next step compacts proactively. */
      const compactNext = { threshold: 0.01 };
      /** The compaction model of these cases. */
      const cRef = { provider: "model-fake", model: "fake-c" };
      /** A compaction model port mapped to model-fake's `model` (null: unmapped); records org ids. */
      const portTo = (model: string | null, params: Record<string, string | number> = {}) => {
        const calls: string[] = [];
        return {
          calls,
          target: async (o: string) => {
            calls.push(o);
            return model === null ? null : { model: { provider: "model-fake", model }, params };
          },
        };
      };
      const compactionUsage = async () =>
        (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
      const lastBlock = (req: ModelRequest | undefined) => {
        const last = req?.messages.at(-1);
        return last?.role === "user" ? last.content.at(-1) : undefined;
      };

      it("a turn-start compaction whose only input after the last reply is the run opener summarizes in context: cache read", async () => {
        const h = harness();
        await cachedStep(h);
        const opener = await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        expect(h.skips).toEqual([]);
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("in_context");
        // boundary mode all: everything the request held is covered, the opener re-rendered
        // (ruling R9a: it is not lost, so it is not unanswered input)
        expect(summary?.payload.coversUpToSeq).toBe(await lastSeqBefore(summary?.seq));
        expect(summary?.payload.openingSeqs).toEqual([opener]);
        // review M4: what was saved is estimated from the covered range, not the plan's transcript
        const covered = compactionPlan(
          (await all()).filter((e) => e.seq <= (summary?.payload.coversUpToSeq ?? 0)),
          { ...COMPACTION_SETTINGS.parse({}), keepRecentTurns: 0 },
          Number.POSITIVE_INFINITY,
        );
        expect(summary?.payload.savedTokens).toBe(
          summarySavedTokens(covered?.transcript ?? "", summary?.payload.text ?? ""),
        );
        const usage = await compactionUsage();
        expect(usage).toHaveLength(1);
        expect(usage[0]?.payload.cacheReadTokens).toBeGreaterThan(0);

        const first = h.sent[0] as ModelRequest;
        const compaction = h.sent.find((r) => r.purpose === "compaction") as ModelRequest;
        expect(compaction.system).toEqual(first.system);
        expect(compaction.tools).toEqual(first.tools);
        expect(compaction.tools.length).toBeGreaterThan(0);
        expect(compaction.cacheTtl).toBe(first.cacheTtl);
        expect(compaction.toolChoice).toBe("none");
        expect(compaction.maxOutputTokens).toBe(4096);
        expect(compaction.messages.slice(0, first.messages.length)).toEqual(first.messages);
        expect(lastBlock(compaction)).toEqual({ type: "text", text: inContextInstruction(null) });
      });

      it("a model switch between the last call and the compaction summarizes the transcript", async () => {
        const h = harness();
        await cachedStep(h);
        await eventLog.append(conversationId, [
          {
            type: "model_switched",
            payload: {
              model: { provider: "model-fake", model: "fake-think" },
              effort: null,
              byAccountId: accountId,
              reason: "user",
            },
          },
        ]);
        await say("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 2, icAgent("fake-think"));
        });
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("transcript");
        expect(h.skips).toEqual(["model_mismatch"]);
      });

      it("the reactive path (context overflow) summarizes the transcript", async () => {
        const h = harness({ overflowOnce: 2 });
        await cachedStep(h);
        await say("echo:second");
        await withSettings({ enabled: false }, async () => {
          await icStep(h.d, 2);
        });
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("transcript");
        expect(h.skips).toEqual(["transcript_only"]);
        expect(await ofType("model_call")).toHaveLength(3);
      });

      it("a manual compaction on a gated model keeps the #990 plan on the transcript path (ruling R13): skip reason manual, no snapshot read", async () => {
        let snapshotReads = 0;
        const h = harness({ beforeSnapshot: () => snapshotReads++ });
        await cachedStep(h);
        const latest = (await ofType("user_message")).at(-1)?.seq as number;
        // what CompactionService.force does for a compact run (`force: true, manual: true`)
        const compactRunId = randomUUID();
        await seedRun(compactRunId);
        const input: ModelStepInput = {
          source: "web",
          orgId,
          conversationId,
          runId: compactRunId,
          step: 0,
          agent: icAgent(),
          agentVersion: 1,
          absorbedUpToSeq: await lastSeq(),
          signal: new AbortController().signal,
          sink: () => {},
          agentId,
          accountId,
          conversationKind: "chat",
        };
        const events = await readAllEvents(eventLog, conversationId);
        const tools = stepToolsOf(await resolveAgentTools(h.d, input, events), input, h.d);
        const out = await runCompaction(
          h.d,
          input,
          events,
          h.d.config.get().runtime,
          { ...COMPACTION_SETTINGS.parse({}), reserveTokens: 0 },
          tools,
          { force: true, manual: true },
        );
        expect(out.failed).toBe(false);
        expect(h.skips).toEqual(["manual"]);
        expect(snapshotReads).toBe(0);
        const [summary] = await ofType("compaction_summary");
        expect(out.summarySeq).toBe(summary?.seq);
        expect(summary?.payload.method).toBe("transcript");
        // the manual plan: every turn before the latest summarized, the latest turn kept whole
        expect(summary?.payload.coversUpToSeq).toBe(latest - 1);
        expect(summary?.payload.openingSeqs).toBeUndefined();
        const compaction = h.sent.find((r) => r.purpose === "compaction") as ModelRequest;
        expect(compaction.system).not.toEqual((h.sent[0] as ModelRequest).system);
      });

      it("a compaction whose in-context request would not fit summarizes the transcript", async () => {
        const h = harness();
        await cachedStep(h);
        // a ~28k-token opener: the in-context request's estimate, calibrated by the previous
        // step's actual input (about 0.77 of its estimate here, as the trigger calibrates), plus
        // the 4096-token summary cap does not fit fake-1's 32k window below the 8000-token reserve
        // (a tool directive keeps the step's reply short)
        await nextTurn(`tool:ReadToolOutput:${JSON.stringify({ id: "x".repeat(110_000) })}`);
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("transcript");
        expect(h.skips).toEqual(["too_large"]);
      });

      it("ruling R9: a mid-run compaction with a tool result the model has not read summarizes the transcript", async () => {
        const h = harness();
        await seedRun(runId);
        for (let i = 0; i < 4; i++) {
          await say(filler(i));
          await answer(filler(i));
        }
        await say('tool:ReadToolOutput:{"id":"x"}');
        await withSettings({ enabled: false }, async () => {
          await icStep(h.d, 1);
        });
        const call = (await ofType("assistant_message"))
          .at(-1)
          ?.payload.content.find((b) => b.type === "tool_call");
        expect(call?.type).toBe("tool_call");
        await eventLog.append(conversationId, [
          {
            type: "tool_result",
            runId,
            payload: {
              step: 1,
              callId: call?.type === "tool_call" ? call.id : "",
              toolKey: "ReadToolOutput",
              content: "the output",
              isError: false,
            },
          },
        ]);
        await withSettings(compactNext, async () => {
          await icStep(h.d, 2);
        });
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("transcript");
        expect(h.skips).toEqual(["pending_input"]);
      });

      it("review M1: an event after a message the step does not absorb stays out of the in-context request", async () => {
        const h = harness();
        await cachedStep(h);
        const opener = await nextTurn("echo:second");
        await say("echo:late message");
        await answer("late reply");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1, icAgent(), { absorbedUpToSeq: opener + 1 });
        });
        expect(h.skips).toEqual([]);
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("in_context");
        expect(summary?.payload.coversUpToSeq).toBe(opener + 1);
        const compaction = h.sent.find((r) => r.purpose === "compaction") as ModelRequest;
        const texts = compaction.messages.flatMap((m) =>
          typeof m.content === "string"
            ? [m.content]
            : m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])),
        );
        expect(texts).not.toContain("late reply");
        expect(texts).not.toContain("late message");
      });

      it("review M3: a live snapshot that fails summarizes the transcript and logs a warning", async () => {
        const h = harness({
          beforeSnapshot: () => {
            throw new Error("snapshot read failed");
          },
        });
        await cachedStep(h);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("transcript");
        expect(h.skips).toEqual(["snapshot_failed"]);
        expect(h.warns).toContain("in-context summary snapshot failed");
      });

      it("review M6: an abort during the in-context preparation sends no summary call", async () => {
        const ac = new AbortController();
        const h = harness({ beforeSnapshot: () => ac.abort() });
        await cachedStep(h);
        await nextTurn("echo:second");
        const sentBefore = h.sent.length;
        let r: Awaited<ReturnType<typeof icStep>> | undefined;
        await withSettings(compactNext, async () => {
          r = await icStep(h.d, 1, icAgent(), { signal: ac.signal });
        });
        expect(r).toMatchObject({ aborted: true });
        expect(h.sent.slice(sentBefore)).toEqual([]);
        expect(await ofType("compaction_summary")).toEqual([]);
        expect(await ofType("compaction_failed")).toEqual([]);
      });

      it("a summary cut off once is asked again with the retry note, then stored as in_context", async () => {
        const h = harness();
        await cachedStep(h, ["compact-cutoff:once"]);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        const calls = h.sent.filter((r) => r.purpose === "compaction");
        expect(calls).toHaveLength(2);
        expect(lastBlock(calls[0])).toEqual({ type: "text", text: inContextInstruction(null) });
        expect(lastBlock(calls[1])).toEqual({ type: "text", text: compactionRetryNote(4096) });
        expect(calls[1]?.messages.slice(0, -1)).toEqual(calls[0]?.messages.slice(0, -1));
        const [summary] = await ofType("compaction_summary");
        expect(summary?.payload.method).toBe("in_context");
        expect(await ofType("compaction_failed")).toEqual([]);
        expect(await compactionUsage()).toHaveLength(2);
      });

      it("a summary cut off twice fails the compaction with the cut-off reason", async () => {
        const h = harness();
        await cachedStep(h, ["compact-cutoff:always"]);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        expect(h.sent.filter((r) => r.purpose === "compaction")).toHaveLength(2);
        expect(await ofType("compaction_summary")).toEqual([]);
        expect((await ofType("compaction_failed")).map((f) => f.payload.reason)).toEqual([
          "summary cut off at the output token limit (4096 tokens), also when asked again for a shorter one",
        ]);
      });

      it("a summary reply that calls a tool fails the compaction", async () => {
        const h = harness();
        await cachedStep(h, ['compact-tool:ReadToolOutput:{"id":"x"}']);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        expect(await ofType("compaction_summary")).toEqual([]);
        expect((await ofType("compaction_failed")).map((f) => f.payload.reason)).toEqual([
          "summary reply called a tool",
        ]);
        expect(await compactionUsage()).toHaveLength(1);
      });

      it("a non-retryable error on the summary call fails the compaction; the next attempt follows the backoff", async () => {
        const h = harness();
        await cachedStep(h, ["compact-fail:invalid_request"]);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
          expect((await ofType("compaction_failed")).map((f) => f.payload)).toEqual([
            {
              attempt: 1,
              step: 1,
              reason: "Scripted invalid_request failure",
              model: { provider: "model-fake", model: "fake-1" },
            },
          ]);
          // attempt 1 failed: the backoff waits for two new user turns
          await nextTurn("echo:third");
          await icStep(h.d, 1);
          expect(await ofType("compaction_failed")).toHaveLength(1);
          await nextTurn("echo:fourth");
          await icStep(h.d, 1);
        });
        expect((await ofType("compaction_failed")).map((f) => f.payload.attempt)).toEqual([1, 2]);
        expect(h.sent.filter((r) => r.purpose === "compaction")).toHaveLength(2);
        expect(h.skips).toEqual([]);
      });

      it("a policy hook denying the in-context call fails the compaction with the hook reason", async () => {
        const hooks: NonNullable<ModelStepDeps["hooks"]> = {
          has: () => true,
          run: async (mount, payload) => {
            const p = payload as unknown as { purpose?: string; request?: ModelRequest };
            if (mount === "model.request" && p.purpose === "compaction") {
              // the hook sees the in-context request without the transport option
              expect(p.request?.toolChoice).toBe("none");
              expect(p.request).not.toHaveProperty("cacheTtl");
              return { allowed: false, plugin: "guard", reason: "no", cause: "deny", detail: "d" };
            }
            return { allowed: true };
          },
        };
        const h = harness({ hooks });
        await cachedStep(h);
        await nextTurn("echo:second");
        await withSettings(compactNext, async () => {
          await icStep(h.d, 1);
        });
        expect(h.skips).toEqual([]);
        expect((await ofType("compaction_failed")).map((f) => f.payload.reason)).toEqual([
          'compaction request blocked by the "guard" policy hook (deny)',
        ]);
        expect(h.sent.filter((r) => r.purpose === "compaction")).toEqual([]);
      });

      describe("idle: the idle compact run (idle compaction spec §4.3 check 9)", () => {
        /**
         * What `CompactionService.force(input, "idle", mode)` does: a compact run's step 0 with
         * `{ force: true, idle: mode }` (never `manual`, ruling R13).
         */
        const idleInput = async (agent = icAgent()): Promise<ModelStepInput> => {
          const compactRunId = randomUUID();
          await seedRun(compactRunId, agent);
          return {
            source: "web",
            orgId,
            conversationId,
            runId: compactRunId,
            step: 0,
            agent,
            agentVersion: 1,
            absorbedUpToSeq: await lastSeq(),
            signal: new AbortController().signal,
            sink: () => {},
            agentId,
            accountId,
            conversationKind: "chat",
          };
        };
        const settings = () => ({ ...COMPACTION_SETTINGS.parse({}), reserveTokens: 0 });
        const idleCompact = async (h: Harness, agent = icAgent(), mode: IdleMode = "cache") => {
          const input = await idleInput(agent);
          const events = await readAllEvents(eventLog, conversationId);
          const tools = stepToolsOf(await resolveAgentTools(h.d, input, events), input, h.d);
          return runCompaction(h.d, input, events, h.d.config.get().runtime, settings(), tools, {
            force: true,
            idle: mode,
          });
        };

        /** An in-context skip: nothing written at all, no summary call, the outcome `skipped`. */
        const expectSilentSkip = async (
          h: Harness,
          agent = icAgent(),
          mode: IdleMode = "cache",
        ) => {
          const before = (await all()).length;
          const sentBefore = h.sent.length;
          const progress: unknown[] = [];
          deps.compactionProgress = {
            update: (u) => progress.push(u),
            clear: (id) => progress.push(id),
          };
          let out: Awaited<ReturnType<typeof idleCompact>>;
          try {
            out = await idleCompact(h, agent, mode);
          } finally {
            delete deps.compactionProgress;
          }
          expect(progress).toEqual([]);
          expect({ summarySeq: out.summarySeq, failed: out.failed }).toEqual({
            summarySeq: null,
            failed: false,
          });
          expect(await all()).toHaveLength(before);
          expect(h.sent.slice(sentBefore)).toEqual([]);
        };

        it("a model switched since the last call (model_mismatch) writes nothing", async () => {
          const h = harness();
          await cachedStep(h);
          await eventLog.append(conversationId, [
            {
              type: "model_switched",
              payload: {
                model: { provider: "model-fake", model: "fake-think" },
                effort: null,
                byAccountId: accountId,
                reason: "user",
              },
            },
          ]);
          await expectSilentSkip(h, icAgent("fake-think"));
          expect(h.skips).toEqual(["model_mismatch"]);
        });

        it("a tool result the model has not read (pending_input) writes nothing", async () => {
          const h = harness();
          await seedRun(runId);
          for (let i = 0; i < 4; i++) {
            await say(filler(i));
            await answer(filler(i));
          }
          await say('tool:ReadToolOutput:{"id":"x"}');
          await withSettings({ enabled: false }, async () => {
            await icStep(h.d, 1);
          });
          const call = (await ofType("assistant_message"))
            .at(-1)
            ?.payload.content.find((b) => b.type === "tool_call");
          await eventLog.append(conversationId, [
            {
              type: "tool_result",
              runId,
              payload: {
                step: 1,
                callId: call?.type === "tool_call" ? call.id : "",
                toolKey: "ReadToolOutput",
                content: "the output",
                isError: false,
              },
            },
          ]);
          await expectSilentSkip(h);
          expect(h.skips).toEqual(["pending_input"]);
        });

        it("a last call whose request recorded a fit plan (fit_plan) writes nothing", async () => {
          const h = harness();
          await cachedStep(h);
          const [call] = await ofType("model_call");
          await sql`UPDATE capybara.conversation_events
            SET payload = jsonb_set(payload, '{request,fit}',
              '{"droppedMessageIndexes":[1],"truncated":[]}'::jsonb)
            WHERE conversation_id = ${conversationId} AND seq = ${call?.seq as number}`.execute(
            raw,
          );
          await expectSilentSkip(h);
          expect(h.skips).toEqual(["fit_plan"]);
        });

        it("a settled conversation summarizes in context: cache read, usage of purpose compaction", async () => {
          const h = harness();
          await cachedStep(h);
          const out = await idleCompact(h);
          expect(out.failed).toBe(false);
          expect(h.skips).toEqual([]);
          const [summary] = await ofType("compaction_summary");
          expect(out.summarySeq).toBe(summary?.seq);
          expect(summary?.payload.method).toBe("in_context");
          expect(summary?.payload.step).toBe(0);
          const usage = await compactionUsage();
          expect(usage).toHaveLength(1);
          expect(usage[0]?.payload.cacheReadTokens).toBeGreaterThan(0);
          const compaction = h.sent.find((r) => r.purpose === "compaction") as ModelRequest;
          expect(compaction.system).toEqual((h.sent[0] as ModelRequest).system);
        });

        it("a failed in-context call writes compaction_failed and never sends the transcript request", async () => {
          const h = harness();
          await cachedStep(h, ["compact-fail:invalid_request"]);
          const out = await idleCompact(h);
          expect(out).toMatchObject({ summarySeq: null, failed: true });
          expect((await ofType("compaction_failed")).map((f) => f.payload)).toEqual([
            {
              attempt: 1,
              step: 0,
              reason: "Scripted invalid_request failure",
              model: { provider: "model-fake", model: "fake-1" },
            },
          ]);
          const calls = h.sent.filter((r) => r.purpose === "compaction");
          expect(calls).toHaveLength(1);
          // the in-context request (the conversation's own system prompt), not the transcript one
          expect(calls[0]?.system).toEqual((h.sent[0] as ModelRequest).system);
          expect(calls[0]?.toolChoice).toBe("none");
          expect(h.skips).toEqual([]);
        });

        it("prepareCompaction writes nothing and plans what the following runCompaction summarizes", async () => {
          const h = harness();
          await cachedStep(h);
          const input = await idleInput();
          const events = await readAllEvents(eventLog, conversationId);
          const tools = stepToolsOf(await resolveAgentTools(h.d, input, events), input, h.d);
          const before = (await all()).length;
          const sentBefore = h.sent.length;
          const prepared = await prepareCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            settings(),
            tools,
            { force: true, idle: "cache" },
          );
          expect(await all()).toHaveLength(before);
          expect(h.sent.slice(sentBefore)).toEqual([]);
          if ("skipped" in prepared) throw new Error(`skipped: ${prepared.skipped}`);
          expect(prepared.estimate).toBeGreaterThan(0);
          expect(prepared.window).toBe(prepared.info.contextWindow);
          expect(prepared.growthTokens).toBeGreaterThan(0);
          if ("skip" in prepared.inContext) throw new Error(prepared.inContext.skip);

          // the same preparation again inside runCompaction: the same request, the same coverage
          const out = await runCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            settings(),
            tools,
            { force: true, idle: "cache" },
          );
          const [summary] = await ofType("compaction_summary");
          expect(out.summarySeq).toBe(summary?.seq);
          expect(summary?.payload.coversUpToSeq).toBe(prepared.inContext.coversUpToSeq);
          const sent = h.sent.find((r) => r.purpose === "compaction") as ModelRequest;
          expect(sent.messages).toEqual(prepared.inContext.request.messages);
        });

        it("compaction_model mode without a compaction model writes nothing (no V, no progress)", async () => {
          const h = harness();
          await cachedStep(h);
          await expectSilentSkip(h, icAgent(), "compaction_model");
          // ended before the in-context build: no skip line either
          expect(h.skips).toEqual([]);
        });

        it("compaction_model mode with a compaction model summarizes the transcript on it", async () => {
          const h = harness({ compactionModel: portTo("fake-c") });
          await cachedStep(h);
          const out = await idleCompact(h, icAgent(), "compaction_model");
          expect(out.failed).toBe(false);
          const [summary] = await ofType("compaction_summary");
          expect(out.summarySeq).toBe(summary?.seq);
          expect(summary?.payload).toMatchObject({ method: "transcript", model: cRef, step: 0 });
          const calls = h.sent.filter((r) => r.purpose === "compaction");
          expect(calls.map((r) => r.model)).toEqual(["fake-c"]);
          expect(h.skips).toEqual(["compaction_model"]);
        });

        it("C3: cache mode with a compaction model mapped writes nothing (the in-context skip)", async () => {
          const h = harness({ compactionModel: portTo("fake-c") });
          await cachedStep(h);
          await expectSilentSkip(h, icAgent(), "cache");
          expect(h.skips).toEqual(["compaction_model"]);
        });
      });

      describe("the compaction model (compaction model spec §4, §5)", () => {
        /** A step input as the proactive path builds it for step 1 of the current run. */
        const stepInput = async (agent = icAgent()): Promise<ModelStepInput> => ({
          source: "web",
          orgId,
          conversationId,
          runId,
          step: 1,
          agent,
          agentVersion: 1,
          absorbedUpToSeq: await lastSeq(),
          signal: new AbortController().signal,
          sink: () => {},
          agentId,
          accountId,
          conversationKind: "chat",
        });
        /** The settings `withSettings(compactNext)` puts in effect. */
        const proactive = () => ({ ...COMPACTION_SETTINGS.parse({}), ...compactNext });
        const prepare = async (
          d: ModelStepDeps,
          settings = proactive(),
          opts: Parameters<typeof prepareCompaction>[6] = {},
          agent = icAgent(),
        ) => {
          const input = await stepInput(agent);
          const events = await readAllEvents(eventLog, conversationId);
          const tools = stepToolsOf(await resolveAgentTools(d, input, events), input, d);
          const prepared = await prepareCompaction(
            d,
            input,
            events,
            d.config.get().runtime,
            settings,
            tools,
            opts,
          );
          if ("skipped" in prepared) throw new Error(`skipped: ${prepared.skipped}`);
          return { prepared, input, events, tools };
        };
        const v = { provider: "model-fake", model: "fake-1" };
        const summaryCalls = (h: Harness) => h.sent.filter((r) => r.purpose === "compaction");

        it("no port: the gated in-context path still runs on model-fake; the summary names V", async () => {
          const h = harness();
          await cachedStep(h);
          await nextTurn("echo:second");
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          expect(h.skips).toEqual([]);
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({ method: "in_context", model: v });
        });

        it("a port with no mapping: today's transcript request to V (params {}, cap min(setting, V max))", async () => {
          const port = portTo(null);
          const h = harness({ compactionModel: port });
          await cachedStep(h);
          await nextTurn("echo:second");
          const settings = { ...COMPACTION_SETTINGS.parse({}), reserveTokens: 0 };
          const { prepared, input, events, tools } = await prepare(h.d, settings, {
            force: true,
            manual: true,
          });
          expect(prepared.summarizer.source).toBe("conversation");
          expect(prepared.summaryCap).toBe(Math.min(settings.maxOutputTokens, 4096));
          const out = await runCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            settings,
            tools,
            { force: true, manual: true },
          );
          expect(out.failed).toBe(false);
          const [call] = summaryCalls(h);
          expect(summaryCalls(h)).toHaveLength(1);
          expect(call).toEqual(
            buildCompactionRequest(prepared.plan.transcript, "fake-1", Math.min(20_000, 4096)),
          );
          expect(call?.params).toEqual({});
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({ method: "transcript", model: v });
          expect(port.calls.every((o) => o === orgId)).toBe(true);
        });

        it("port → C: one transcript request to C with its sanitized params; usage and summary name C; the plan is V's", async () => {
          const port = portTo("fake-c", { effort: "low", "no-such-knob": 3 });
          const h = harness({ compactionModel: port });
          await cachedStep(h);
          await nextTurn("echo:second");
          // the same preparation with and without C: only the summarizer differs
          const without = (await prepare(harness().d)).prepared;
          const withC = (await prepare(h.d)).prepared;
          expect(withC.plan).toEqual(without.plan);
          expect(withC.window).toBe(without.window);
          expect(withC.ref).toEqual(v);
          expect(withC.summarizer).toMatchObject({ source: "compaction_model", ref: cRef });
          expect(withC.inContext).toEqual({ skip: "compaction_model" });
          const sentBefore = h.sent.length;
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          const calls = summaryCalls(h);
          expect(calls).toHaveLength(1);
          expect(calls[0]).toMatchObject({
            model: "fake-c",
            purpose: "compaction",
            params: { effort: "low" },
            maxOutputTokens: 4096,
          });
          expect(h.sent.slice(sentBefore).filter((r) => r.purpose === "compaction")).toHaveLength(
            1,
          );
          expect(h.skips).toEqual(["compaction_model"]);
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({
            method: "transcript",
            model: cRef,
            coversUpToSeq: without.plan.coversUpToSeq,
          });
          const events = await all();
          const opening = openingSeqs(
            events,
            runId,
            without.plan.coversUpToSeq,
            (await stepInput()).absorbedUpToSeq,
          );
          expect(summary?.payload.openingSeqs).toEqual(opening.length > 0 ? opening : undefined);
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => [u.payload.provider, u.payload.model])).toEqual([
            ["model-fake", "fake-c"],
          ]);
        });

        it("port → a C too small to be useful (32k window): V writes the summary, debug compaction_model_small", async () => {
          const h = harness({ compactionModel: portTo("fake-c32") });
          await cachedStep(h);
          await nextTurn("echo:second");
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({ method: "in_context", model: v });
          expect(summaryCalls(h).map((r) => r.model)).toEqual(["fake-1"]);
          expect(h.lines).toContainEqual(
            expect.objectContaining({ level: "debug", reason: "compaction_model_small" }),
          );
        });

        it("port → a C the registry cannot resolve: V writes the summary, warn compaction_model_unavailable", async () => {
          const h = harness({ compactionModel: portTo("fake-c"), resolveFails: "fake-c" });
          await cachedStep(h);
          await nextTurn("echo:second");
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({ method: "in_context", model: v });
          expect(h.lines).toContainEqual(
            expect.objectContaining({ level: "warn", reason: "compaction_model_unavailable" }),
          );
        });

        it("a port that throws another error ends the compaction as unavailable: no call on any model, the step goes on", async () => {
          const h = harness({
            compactionModel: {
              target: async () => {
                throw new Error("purposes read failed");
              },
            },
          });
          await cachedStep(h);
          await nextTurn("echo:second");
          const sentBefore = h.sent.length;
          // the automatic path: nothing written for the compaction, the step's own request follows
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          const sent = h.sent.slice(sentBefore);
          expect(sent.filter((r) => r.purpose === "compaction")).toEqual([]);
          expect(sent.map((r) => r.model)).toEqual(["fake-1"]);
          expect(await ofType("compaction_summary")).toEqual([]);
          expect(await ofType("compaction_failed")).toEqual([]);
          expect(h.lines).toContainEqual(
            expect.objectContaining({
              level: "warn",
              msg: "compaction skipped: the compaction model is unavailable",
            }),
          );
          // a manual run records the outcome, naming no model (no call was built)
          const sentManual = h.sent.length;
          const input = await stepInput();
          const events = await readAllEvents(eventLog, conversationId);
          const tools = stepToolsOf(await resolveAgentTools(h.d, input, events), input, h.d);
          const out = await runCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            proactive(),
            tools,
            { force: true, manual: true },
          );
          expect(out).toMatchObject({ summarySeq: null, failed: true });
          expect(h.sent.slice(sentManual)).toEqual([]);
          expect((await ofType("compaction_failed")).map((f) => f.payload)).toEqual([
            { attempt: 1, step: 1, reason: "the compaction model is unavailable" },
          ]);
        });

        it("Review Focus 4: a large-output C never raises the cap above V's max (request level)", async () => {
          const c = { provider: "stub", model: "big-out" };
          const s = stub(
            [
              stubInfo("rung", { contextWindow: 24_000, maxOutputTokens: 3000 }),
              stubInfo("big-out", { contextWindow: 1_000_000, maxOutputTokens: 393_216 }),
            ],
            (req) =>
              req.purpose === "compaction" ? `<summary>${"s".repeat(2000)}</summary>` : "ok",
          );
          stubImpl = s;
          const h = harness({
            compactionModel: { target: async () => ({ model: c, params: {} }) },
          });
          await cachedStep(h);
          await nextTurn("echo:second");
          const settings = { ...COMPACTION_SETTINGS.parse({}), maxOutputTokens: 20_000 };
          const opts = {
            force: true,
            ref: { provider: "stub", model: "rung" },
            transcriptOnly: true,
          };
          const { input, events, tools } = await prepare(h.d, settings, opts);
          const out = await runCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            settings,
            tools,
            opts,
          );
          expect(out.failed).toBe(false);
          expect(s.calls.map((r) => [r.model, r.maxOutputTokens])).toEqual([["big-out", 3000]]);
        });

        it("C's call fails: compaction_failed names C, and no request goes to V (Q1)", async () => {
          const h = harness({ compactionModel: portTo("fake-c"), failModel: "fake-c" });
          await cachedStep(h);
          await nextTurn("echo:second");
          await withSettings(compactNext, async () => {
            await icStep(h.d, 1);
          });
          expect(summaryCalls(h).map((r) => r.model)).toEqual(["fake-c"]);
          expect((await ofType("compaction_failed")).map((f) => f.payload)).toEqual([
            { attempt: 1, step: 1, reason: "Scripted summarizer failure", model: cRef },
          ]);
          expect(await ofType("compaction_summary")).toEqual([]);
        });

        it("reactive (force, ref = the rung, transcriptOnly): the rung's window plans, C summarizes, cap = min(setting, rung max, C max)", async () => {
          const rung = { provider: "stub", model: "rung" };
          const c = { provider: "stub", model: "c" };
          const s = stub(
            [
              stubInfo("rung", { contextWindow: 24_000, maxOutputTokens: 3000 }),
              stubInfo("c", { contextWindow: 200_000, maxOutputTokens: 2048 }),
            ],
            (req) =>
              req.purpose === "compaction" ? `<summary>${"s".repeat(2000)}</summary>` : "ok",
          );
          stubImpl = s;
          const port = { target: async () => ({ model: c, params: {} }) };
          const h = harness({ compactionModel: port });
          await cachedStep(h);
          await nextTurn("echo:second");
          const settings = { ...COMPACTION_SETTINGS.parse({}), maxOutputTokens: 2500 };
          const opts = { force: true, ref: rung, transcriptOnly: true };
          const without = (await prepare(harness().d, settings, opts)).prepared;
          const { prepared, input, events, tools } = await prepare(h.d, settings, opts);
          expect(prepared.window).toBe(24_000);
          expect(prepared.ref).toEqual(rung);
          expect(prepared.plan).toEqual(without.plan);
          expect(without.summaryCap).toBe(2500);
          expect(prepared.summaryCap).toBe(2048);
          expect(prepared.summarizer).toMatchObject({ source: "compaction_model", ref: c });
          const out = await runCompaction(
            h.d,
            input,
            events,
            h.d.config.get().runtime,
            settings,
            tools,
            opts,
          );
          expect(out.failed).toBe(false);
          expect(s.calls.map((r) => [r.model, r.maxOutputTokens, r.purpose])).toEqual([
            ["c", 2048, "compaction"],
          ]);
          const [summary] = await ofType("compaction_summary");
          expect(summary?.payload).toMatchObject({ method: "transcript", model: c });
        });

        it("compactionModelPort: unconfigured → null, a mapping as is, any other error rethrown", async () => {
          const target = { model: cRef, params: { effort: "low" } };
          await expect(
            compactionModelPort({ resolve: async () => target }).target(orgId),
          ).resolves.toEqual(target);
          await expect(
            compactionModelPort({
              resolve: async () => {
                throw new ApiError("model.unconfigured", "none");
              },
            }).target(orgId),
          ).resolves.toBeNull();
          await expect(
            compactionModelPort({
              resolve: async () => {
                throw new ApiError("model.purpose_unknown", "no");
              },
            }).target(orgId),
          ).rejects.toThrow("no");
        });
      });
    });

    describe("chunked compaction (spec §4.5)", () => {
      // 390 ASCII characters per turn: the user line ("User: " + 390) is 99 tokens and the
      // assistant line 101, so a turn is 200 tokens.
      const turn = (n: number) => `turn ${n} `.padEnd(390, "y");
      /** Six turns to summarise: 1200 tokens, over one call's 500-token chunk at this window. */
      const history = async () => {
        for (let i = 0; i < 6; i++) {
          await say(turn(i));
          await answer(turn(i));
        }
      };
      // The chunk size subtracts the summary allowance (half of the 200-token cap) and the
      // request's fixed overhead (instruction + transcript wrapper, §4.5): a 500-token chunk needs
      // B = 500 + 100 + overhead, so the window is B plus the output cap and a zero reserve.
      const OVERHEAD = compactionRequestOverhead();
      const WINDOW = 500 + 100 + OVERHEAD + 200;
      const chunked = () => stubInfo("chunked", { contextWindow: WINDOW, maxOutputTokens: 200 });
      const settings = {
        maxOutputTokens: 200,
        reserveTokens: 0,
        keepRecentTurns: 1,
        threshold: 0.5,
      };
      const compactionCalls = (calls: ModelRequest[]) =>
        calls.filter((c) => c.purpose === "compaction");
      const transcriptOf = (req: ModelRequest): string => {
        const c = req.messages[0]?.content;
        return Array.isArray(c) && c[0]?.type === "text" ? c[0].text : "";
      };

      it("3 chunks produce 3 rolling calls, one usage each, and the summary of the last", async () => {
        const seen: ModelRequest[] = [];
        stubImpl = stub([chunked()], (req) => {
          seen.push(req);
          return req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);

          const calls = compactionCalls(seen);
          expect(calls).toHaveLength(3);
          // every request fits the window: its input (chunk + running summary + the fixed
          // overhead) plus the summary output cap and the zero reserve stays at or under Wc
          for (const call of calls) {
            const input = estimateTokens(call.messages, call.system, call.tools);
            expect(input + (call.maxOutputTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
          }
          // call 1 has no running summary; calls 2 and 3 carry the previous call's summary
          expect(transcriptOf(calls[0] as ModelRequest)).not.toContain("[Earlier summary]");
          expect(transcriptOf(calls[1] as ModelRequest)).toContain(
            `[Earlier summary]\nSummary: ${"s".repeat(300)}`,
          );
          expect(transcriptOf(calls[2] as ModelRequest)).toContain("[Earlier summary]");

          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual([1, 2, 3]);
          expect(usage.map((u) => u.payload.chunks)).toEqual([3, 3, 3]);

          // one summary event, the last call's text, checked against the full transcript
          const summaries = await ofType("compaction_summary");
          expect(summaries).toHaveLength(1);
          expect(summaries[0]?.payload.text).toBe(`Summary: ${"s".repeat(300)}`);
          expect(summaries[0]?.payload.savedTokens).toBeGreaterThan(0);
        });
      });

      it("a single line over the chunk size is hard-split, not failed", async () => {
        const seen: ModelRequest[] = [];
        stubImpl = stub([chunked()], (req) => {
          seen.push(req);
          return req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          for (let i = 0; i < 4; i++) {
            await say(turn(i));
            await answer(turn(i));
          }
          // 2011 characters ≈ 503 tokens: one assistant line over the 500-token chunk
          await say(turn(9));
          await answer("z".repeat(2000));
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);

          const calls = compactionCalls(seen);
          expect(calls.length).toBeGreaterThan(1);
          expect(calls.some((c) => transcriptOf(c).includes("[chunk split]"))).toBe(true);
          expect(await ofType("compaction_failed")).toEqual([]);
          expect(await ofType("compaction_summary")).toHaveLength(1);
        });
      });

      it("a failing middle chunk writes one compaction_failed naming the chunk and no summary", async () => {
        let attempts = 0;
        stubImpl = stub([chunked()], (req) => {
          if (req.purpose === "compaction") {
            attempts++;
            if (attempts === 2) throw new ModelError("server", "chunk blew up");
            return `Summary: ${"s".repeat(300)}`;
          }
          return "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          // the step continues unchanged after the failed compaction
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          expect(attempts).toBe(2);
          const failed = await ofType("compaction_failed");
          expect(failed).toHaveLength(1);
          expect(failed[0]?.payload.reason).toContain("chunk 2");
          expect(await ofType("compaction_summary")).toEqual([]);
          // chunk 1's call is billed; chunk 2 failed before its usage existed
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual([1]);
        });
      });

      it("an empty intermediate summary fails the chunk instead of silently dropping earlier chunks", async () => {
        let attempts = 0;
        stubImpl = stub([chunked()], (req) => {
          if (req.purpose === "compaction") {
            attempts++;
            // only the analysis scratchpad: extractSummary yields nothing to carry forward
            if (attempts === 2) return "<analysis>still thinking</analysis>";
            return `Summary: ${"s".repeat(300)}`;
          }
          return "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          // the third chunk is never sent: chunk 2 left nothing for it to merge
          expect(attempts).toBe(2);
          const failed = await ofType("compaction_failed");
          expect(failed).toHaveLength(1);
          expect(failed[0]?.payload.reason).toContain("no summary");
          expect(failed[0]?.payload.reason).toContain("chunk 2");
          expect(await ofType("compaction_summary")).toEqual([]);
          // both calls that ran are billed
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual([1, 2]);
        });
      });

      it("a middle chunk cut off at the output token limit is asked again, and the next chunk carries the retried summary", async () => {
        let n = 0;
        const s = stub(
          [chunked()],
          (req) => {
            if (req.purpose !== "compaction") return "answer";
            n++;
            if (n === 2) return `Half summary: ${"h".repeat(300)}`;
            if (n === 3) return `Retried summary: ${"r".repeat(300)}`;
            return `Summary: ${"s".repeat(300)}`;
          },
          undefined,
          // the second call (chunk 2's first attempt) stops at the limit
          () => (n === 2 ? "max_tokens" : "end_turn"),
        );
        stubImpl = s;
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          const calls = compactionCalls(s.calls);
          expect(calls).toHaveLength(4);
          // chunk 2 again with the note; the retried request still fits the window
          expect(calls[2]?.messages[0]?.content[0]).toEqual(calls[1]?.messages[0]?.content[0]);
          expect(calls[2]?.messages[0]?.content).toHaveLength(2);
          for (const call of calls) {
            const input = estimateTokens(call.messages, call.system, call.tools);
            expect(input + (call.maxOutputTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
          }
          // chunk 3 merges the retried summary, never the half one
          expect(transcriptOf(calls[3] as ModelRequest)).toContain(
            `[Earlier summary]\nRetried summary: ${"r".repeat(300)}`,
          );
          expect(JSON.stringify(calls[3])).not.toContain("Half summary");
          expect(await ofType("compaction_failed")).toEqual([]);
          expect(await ofType("compaction_summary")).toHaveLength(1);
          // every call is billed; the retry carries its chunk's index
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual([1, 2, 2, 3]);
        });
      });

      it("a middle chunk cut off twice fails the compaction naming the chunk, and the next chunk is never sent", async () => {
        let n = 0;
        const s = stub(
          [chunked()],
          (req) => {
            if (req.purpose === "compaction") n++;
            return req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer";
          },
          undefined,
          (req) => (req.purpose === "compaction" && n >= 2 ? "max_tokens" : "end_turn"),
        );
        stubImpl = s;
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          expect(compactionCalls(s.calls)).toHaveLength(3);
          const failed = await ofType("compaction_failed");
          expect(failed).toHaveLength(1);
          expect(failed[0]?.payload.reason).toBe(
            "summary cut off at the output token limit (200 tokens), also when asked again for a shorter one (chunk 2)",
          );
          expect(await ofType("compaction_summary")).toEqual([]);
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual([1, 2, 2]);
          expect(usage.every((u) => u.payload.chunks === 2)).toBe(true);
        });
      });

      it("publishes preparing → summarizing (chars, chunk i/N) → writing, then clears", async () => {
        stubImpl = stub([chunked()], (req) =>
          req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer",
        );
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        const updates: {
          phase: string;
          step: number;
          chunk?: number;
          chunks?: number;
          chars?: number;
        }[] = [];
        const cleared: string[] = [];
        deps.compactionProgress = {
          update: (u) => updates.push(u.progress),
          clear: (runId) => cleared.push(runId),
        };
        try {
          await withSettings(settings, async () => {
            await history();
            await say("go");
            expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          });
        } finally {
          delete deps.compactionProgress;
        }

        expect(updates[0]?.phase).toBe("preparing");
        // the first chunk's stream reports its characters and a real 1/3
        const summarizing = updates.filter((u) => u.phase === "summarizing");
        expect(summarizing.length).toBeGreaterThan(1);
        expect(summarizing[0]).toMatchObject({ chunk: 1, chunks: 3, chars: 0 });
        expect(summarizing.some((u) => (u.chars ?? 0) > 0)).toBe(true);
        // the last chunk is numbered 3 (real progress, never a percentage)
        expect(summarizing.at(-1)).toMatchObject({ chunk: 3, chunks: 3 });
        expect(updates.at(-1)?.phase).toBe("writing");
        expect(cleared).toHaveLength(1);
      });

      it("a base chunk below the minimum leaves the single call instead of failing the first chunk", async () => {
        // base chunk size 100 < the 256 floor: chunking could only make one token per call, so the
        // degenerate budget keeps the single summary call (the fit guard handles a request too big
        // for the window)
        const TINY = 100 + 300 + OVERHEAD;
        const tiny = stubInfo("tiny", { contextWindow: TINY, maxOutputTokens: 200 });
        const seen: ModelRequest[] = [];
        stubImpl = stub([tiny], (req) => {
          seen.push(req);
          return req.purpose === "compaction" ? `Summary: ${"s".repeat(300)}` : "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "tiny" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          const calls = compactionCalls(seen);
          // one call with the whole transcript: no running-summary wrapper, no chunk split
          expect(calls).toHaveLength(1);
          expect(transcriptOf(calls[0] as ModelRequest)).not.toContain("[Earlier summary]");
          expect(await ofType("compaction_failed")).toEqual([]);
          expect(await ofType("compaction_summary")).toHaveLength(1);
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage).toHaveLength(1);
          // a single call carries no chunk progress
          expect(usage[0]?.payload.chunk).toBeUndefined();
        });
      });

      it("a near-cap running summary shrinks the next chunk so every request fits the window", async () => {
        // 800 characters ≈ 200 tokens: the full summary cap, over the 100-token allowance
        const nearCap = `Summary: ${"s".repeat(791)}`;
        const seen: ModelRequest[] = [];
        stubImpl = stub([chunked()], (req) => {
          seen.push(req);
          return req.purpose === "compaction" ? nearCap : "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        await withSettings(settings, async () => {
          await history();
          await say("go");
          expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);

          const calls = compactionCalls(seen);
          expect(calls.length).toBeGreaterThanOrEqual(3);
          const inner = (req: ModelRequest): string => {
            const body = transcriptOf(req);
            return body.slice("<transcript>\n".length, -"\n</transcript>".length);
          };
          // the base chunk is 500 tokens; the 200-token summary leaves 395, so the next chunk is
          // one line shorter than the first
          const first = inner(calls[0] as ModelRequest);
          const second = inner(calls[1] as ModelRequest).replace(
            `[Earlier summary]\n${nearCap}\n\n`,
            "",
          );
          expect(second.length).toBeLessThan(first.length);
          // the running summary may now be the full output cap: every real request still fits
          for (const call of calls) {
            const input = estimateTokens(call.messages, call.system, call.tools);
            expect(input + (call.maxOutputTokens ?? 0)).toBeLessThanOrEqual(WINDOW);
          }
          // one summary event, from the last call
          expect(await ofType("compaction_summary")).toHaveLength(1);
          const usage = (await ofType("usage")).filter((u) => u.payload.purpose === "compaction");
          expect(usage.map((u) => u.payload.chunk)).toEqual(calls.map((_c, i) => i + 1));
          expect(usage.every((u) => u.payload.chunks === calls.length)).toBe(true);
        });
      });

      it("a failed compaction publishes no writing phase and clears the progress", async () => {
        stubImpl = stub([chunked()], (req) => {
          if (req.purpose === "compaction") {
            throw new ModelError("server", "summary call failed");
          }
          return "answer";
        });
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        const phases: string[] = [];
        const cleared: string[] = [];
        deps.compactionProgress = {
          update: (u) => phases.push(u.progress.phase),
          clear: (runId) => cleared.push(runId),
        };
        try {
          await withSettings(settings, async () => {
            await history();
            await say("go");
            // the step continues without the summary
            expect((await step({ agent })).content).toEqual([{ type: "text", text: "answer" }]);
          });
        } finally {
          delete deps.compactionProgress;
        }
        expect(await ofType("compaction_failed")).toHaveLength(1);
        // nothing was written, so there is no writing phase to show
        expect(phases).not.toContain("writing");
        expect(cleared).toHaveLength(1);
      });

      it("an aborted compaction clears the progress key (no writing phase, no summary)", async () => {
        const ac = new AbortController();
        const calls: ModelRequest[] = [];
        stubImpl = {
          async listModels() {
            return [chunked()];
          },
          async *stream(req): AsyncGenerator<ModelStreamEvent> {
            calls.push(req);
            if (req.purpose === "compaction") {
              yield { type: "text_delta", text: "Summary so far" };
              // the person stops the run while the summary streams; the runtime's abort path
              // closes the stream instead of reading on, so the provider stops right here
              ac.abort();
              return;
            }
            const text = "answer";
            yield { type: "text_delta", text };
            yield {
              type: "message_complete",
              content: [{ type: "text", text }],
              stopReason: "end_turn",
              usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
            };
          },
        };
        const agent = agentWith({ model: { provider: "stub", model: "chunked" } });
        const phases: string[] = [];
        const cleared: string[] = [];
        deps.compactionProgress = {
          update: (u) => phases.push(u.progress.phase),
          clear: (runId) => cleared.push(runId),
        };
        try {
          await withSettings(settings, async () => {
            await history();
            await say("go");
            expect((await step({ agent, signal: ac.signal })).aborted).toBe(true);
          });
        } finally {
          delete deps.compactionProgress;
        }
        expect(await ofType("compaction_summary")).toEqual([]);
        expect(phases).not.toContain("writing");
        // the throttle map entry and the Redis key are dropped on the abort path too
        expect(cleared).toHaveLength(1);
      });
    });
  });

  it("提醒：maxSteps 3 时 step 1 写 reminder，且 model_call.request.reminderSeqs 包含它", async () => {
    await say("echo:hi");
    await step({ step: 1, maxSteps: 3 });
    const [reminder] = await ofType("reminder");
    expect(reminder).toBeDefined();
    expect(reminder?.payload.step).toBe(1);
    const [call] = await ofType("model_call");
    expect(call?.payload.request.reminderSeqs).toContain(reminder?.seq);
  });

  it("no step limit (maxSteps absent, runtime.maxSteps 0): no step-limit reminder at any step", async () => {
    runtimeOverrides = { maxSteps: 0 };
    await say("echo:hi");
    await step({ step: 49 });
    expect(await ofType("reminder")).toEqual([]);
    const [call] = await ofType("model_call");
    expect(call?.payload.request.reminderSeqs ?? []).toEqual([]);
  });

  it("an event written by someone else between the step's read and its own reminder append is in the request (batch 5 review I2)", async () => {
    const s = stub([stubInfo("ok")], () => "ok");
    stubImpl = s;
    // a person's fork invocation whose report the wait sweep writes while this step runs
    const [lead] = await eventLog.append(conversationId, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: "LEAD" }],
          authorAccountId: accountId,
          skill: {
            id: "sk1",
            version: 1,
            source: "org",
            name: "review",
            arguments: "",
            mode: "fork",
            agentType: "general-purpose",
          },
        },
      },
    ]);
    let injected = false;
    const racing: EventLog = Object.create(eventLog);
    racing.append = async (conv, events) => {
      if (!injected && events.some((e) => e.type === "reminder")) {
        injected = true;
        await eventLog.append(conv, [
          {
            type: "skill_fork_result",
            idemKey: `skill_fork_result:${lead?.seq}`,
            payload: { invokedSeq: lead?.seq as number, text: "REPORT" },
          },
        ]);
      }
      return eventLog.append(conv, events);
    };
    await runModelStep(
      { ...deps, eventLog: racing },
      {
        source: "web",
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: agentWith({ model: { provider: "stub", model: "ok" } }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
        maxSteps: 3,
      },
    );
    expect(injected).toBe(true);
    const [report] = await ofType("skill_fork_result");
    const [call] = await ofType("model_call");
    // the request covers the report's seq, so it must also carry the report
    expect(call?.payload.request.toSeq).toBeGreaterThan(report?.seq ?? 0);
    expect(JSON.stringify(s.calls[0]?.messages)).toContain("REPORT");
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
      source: "web",
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
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "ReadToolOutput" }]),
      });
    const wrapUp = (agent: AgentDefinition) =>
      runFinalWrapUp(deps, {
        source: "web",
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
      expect(req.tools.map((t) => t.name)).toEqual(["ReadToolOutput"]);
      expect(req.toolChoice).toBe("none");
      const [call] = await ofType("model_call");
      expect(call?.payload.request.toolChoice).toBe("none");
      expect(call?.payload.request.tools?.map((t) => t.key)).toEqual(["ReadToolOutput"]);
      expect(req.messages.at(-1)).toEqual({ role: "system", content: WRAP_UP_REMINDER });
    });

    it("普通步骤不发 toolChoice（由模型决定），model_call 也不记", async () => {
      const s = stub([toolsModel()], () => "ok");
      stubImpl = s;
      await say("hi");
      await step({ agent: withTools() });
      const req = s.calls[0] as ModelRequest;
      expect(req.tools.map((t) => t.name)).toEqual(["ReadToolOutput"]);
      expect(req.toolChoice).toBeUndefined();
      const [call] = await ofType("model_call");
      expect(call?.payload.request).not.toHaveProperty("toolChoice");
      expect(call?.payload.request).not.toHaveProperty("toolsOmitted");
    });

    it("a model without tool support (capabilities.tools = false): no tools or toolChoice sent, the omission recorded on model_call, and a reminder says the step has no tools", async () => {
      const s = stub([stubInfo("plain")], () => "ok");
      stubImpl = s;
      await say("hi");
      await wrapUp({ ...withTools(), model: { provider: "stub", model: "plain" } });
      const req = s.calls[0] as ModelRequest;
      expect(req.tools).toEqual([]);
      expect(req.toolChoice).toBeUndefined();
      const [call] = await ofType("model_call");
      expect(call?.payload.request.tools).toEqual([]);
      expect(call?.payload.request.toolsOmitted).toBe(true);
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
      expect(rows[0]?.spec).toMatchObject({ name: "ReadToolOutput" });
    });

    it("ToolSearch 生效：请求只带内置工具，目录进 system 第二块；model_call 记录 catalog，目录里的定义也存进 tool_specs", async () => {
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
        key: "ToolSearch",
        source: { kind: "builtin", name: "ToolSearch" },
        spec: search.spec,
        specHash: specHash(search.spec),
        defaultPolicy: "allow",
      };
      const tools = [mk("mcp__p__zeta"), mk("mcp__p__alpha"), searchTool];
      const searchDeps: ModelStepDeps = {
        ...deps,
        tools: { forAgent: async () => ({ tools, unavailable: [], toolSearch: true }) },
      };
      await say("hi");
      await runModelStep(searchDeps, {
        source: "web",
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
      expect(req.tools.map((t) => t.name)).toEqual(["ToolSearch"]);
      expect(req.system).toHaveLength(2);
      expect(req.system[1]?.text).toContain(
        "- mcp__p__alpha: Do mcp__p__alpha.\n- mcp__p__zeta: Do mcp__p__zeta.",
      );
      const [call] = await ofType("model_call");
      expect(call?.payload.request.tools?.map((t) => t.key)).toEqual(["ToolSearch"]);
      expect(call?.payload.request.catalog?.map((t) => t.key)).toEqual([
        "mcp__p__alpha",
        "mcp__p__zeta",
      ]);
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

describe("tool set changes (tool naming spec §9.1)", () => {
  const tooly = () =>
    stubInfo("tooly", { capabilities: { ...stubInfo("x").capabilities, tools: true } });
  const mk = (key: string): ResolvedTool => {
    const spec = { name: key, description: `Do ${key}.`, inputSchema: { type: "object" } };
    return {
      key,
      source: { kind: "builtin", name: key },
      spec,
      specHash: specHash(spec),
      defaultPolicy: "allow",
    };
  };
  /** The tools the next forAgent resolves (changed between steps by the test). */
  let current: string[] = [];
  const run = (n: number, over: { model?: string; runId?: string; wrapUp?: boolean } = {}) =>
    (over.wrapUp ? runFinalWrapUp : runModelStep)(
      {
        ...deps,
        tools: {
          forAgent: async () => ({ tools: current.map(mk), unavailable: [], toolSearch: false }),
        },
      },
      {
        source: "web",
        orgId,
        conversationId,
        runId: over.runId ?? runId,
        step: n,
        agent: agentWith({ model: { provider: "stub", model: over.model ?? "tooly" } }),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: new AbortController().signal,
        sink: () => {},
      },
    );

  it("writes nothing before the first request nor while the set stays the same", async () => {
    stubImpl = stub([tooly()], () => "ok");
    current = ["AskUserQuestion", "ReadToolOutput"];
    await say("hi");
    await run(1);
    await run(2);
    expect(await ofType("tools_changed")).toEqual([]);
  });

  it("logs the change before the request that offers it and renders it there; later steps stay quiet", async () => {
    const s = stub([tooly()], () => "ok");
    stubImpl = s;
    current = ["AskUserQuestion", "ReadToolOutput"];
    await say("hi");
    await run(1);
    current = ["AskUserQuestion", "WebSearch", "WebFetch", "plugin__todo__write"];
    await run(2);
    const [changed, ...more] = await ofType("tools_changed");
    expect(more).toEqual([]);
    expect(changed?.runId).toBe(runId);
    expect(changed?.payload).toEqual({
      step: 2,
      added: ["WebFetch", "WebSearch", "plugin__todo__write"],
      removed: ["ReadToolOutput"],
    });
    const text =
      "Your tools changed. Now available: WebFetch, WebSearch, plugin__todo__write. No longer " +
      "available: ReadToolOutput. Use the current tool list; it replaces anything said earlier in " +
      "this conversation about which tools you have.";
    const req = s.calls[1] as ModelRequest;
    expect(req.messages.at(-1)).toEqual({ role: "system", content: text });
    const calls = await ofType("model_call");
    expect((changed?.seq ?? 0) < (calls[1]?.seq ?? 0)).toBe(true);
    expect(calls[1]?.payload.request.toSeq).toBeGreaterThanOrEqual(changed?.seq ?? 0);
    // the next step: no new event, the notice stays where it was (append-only)
    await run(3);
    expect(await ofType("tools_changed")).toHaveLength(1);
    const third = s.calls[2] as ModelRequest;
    expect(third.messages.filter((m) => m.content === text)).toHaveLength(1);
  });

  it("a new run compares with the previous run's last request; the wrap-up call logs a change too", async () => {
    stubImpl = stub([tooly()], () => "ok");
    current = ["AskUserQuestion"];
    await say("hi");
    await run(1);
    current = ["AskUserQuestion", "Agent", "SendMessage"];
    const next = randomUUID();
    await run(1, { runId: next, wrapUp: true });
    const [changed] = await ofType("tools_changed");
    expect(changed?.runId).toBe(next);
    expect(changed?.payload).toEqual({ step: 1, added: ["Agent", "SendMessage"], removed: [] });
  });

  it("a retried step finds its change in the log and writes no duplicate", async () => {
    stubImpl = stub([tooly()], () => "ok");
    current = ["AskUserQuestion"];
    await say("hi");
    await run(1);
    current = ["AskUserQuestion", "WebSearch"];
    // a crash after the change was logged and before the request: the step runs again
    await eventLog.append(conversationId, [
      {
        type: "tools_changed",
        runId,
        payload: { step: 2, added: ["WebSearch"], removed: [] },
      },
    ]);
    await run(2);
    expect(await ofType("tools_changed")).toHaveLength(1);
  });

  it("a request without tools because its model has none is not the baseline", async () => {
    stubImpl = stub([tooly(), stubInfo("plain")], () => "ok");
    current = ["AskUserQuestion"];
    await say("hi");
    await run(1);
    await run(2, { model: "plain" });
    await run(3);
    expect(await ofType("tools_changed")).toEqual([]);
    const [, plain] = await ofType("model_call");
    expect(plain?.payload.request.tools).toEqual([]);
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
        source: "web",
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

describe("model.request hooks: stickiness, compaction (M-4, M-2, I-1)", () => {
  type Seen = { mount: string; payload: Record<string, unknown> };
  /** Fake hook runner: records every call; `deny(payload)` decides model.request denials. */
  const fakeHooks = (deny: (p: Record<string, unknown>) => boolean = () => false) => {
    const seen: Seen[] = [];
    const hooks: NonNullable<ModelStepDeps["hooks"]> = {
      has: () => true,
      run: async (mount, payload) => {
        seen.push({ mount, payload: payload as unknown as Record<string, unknown> });
        if (mount === "model.request" && deny(payload as unknown as Record<string, unknown>)) {
          return {
            allowed: false,
            plugin: "guard",
            reason: "no compaction",
            cause: "deny",
            detail: "raw detail",
          };
        }
        return { allowed: true };
      },
    };
    return { seen, hooks };
  };
  const hookedStep = (d: ModelStepDeps, agent = agentWith(), n = 1) =>
    runModelStep(d, {
      source: "web",
      orgId,
      conversationId,
      runId,
      step: n,
      agent,
      agentVersion: 1,
      absorbedUpToSeq: ALL_ABSORBED,
      signal: new AbortController().signal,
      sink: () => {},
      agentId: randomUUID(),
      accountId,
      conversationKind: "chat",
    });
  /** 每条 ~400 个 ASCII 字符 ≈ 100 token。 */
  const filler = (n: number) => `turn ${n} `.padEnd(400, "x");
  const longHistory = async () => {
    for (let i = 0; i < 8; i++) {
      await say(filler(i));
      await answer(filler(i));
    }
    await say("echo:after compaction");
  };
  const small = () => agentWith({ model: { provider: "model-fake", model: "fake-small" } });

  it("a denial logged at a later attempt is sticky on a resume that restarts at attempt 1 (M-4)", async () => {
    await say("hello");
    await eventLog.append(conversationId, [
      {
        type: "hook_denied",
        runId,
        idemKey: `hook_denied:${runId}:1:2`,
        payload: {
          mount: "model.request",
          plugin: "guard",
          reason: "denied at attempt 2",
          cause: "deny",
          step: 1,
          attempt: 2,
        },
      },
    ]);
    const { seen, hooks } = fakeHooks();
    const code = await runErrorCode(hookedStep({ ...deps, hooks }));
    expect(code).toBe("run.hook_denied");
    expect(seen).toEqual([]);
    expect(await ofType("model_call")).toEqual([]);
  });

  it("without hooks no hook_denied lookup is made (M-2)", async () => {
    await say("echo:hi");
    const keys: string[] = [];
    const spied = Object.create(eventLog) as EventLog;
    spied.findByIdem = async (conv: string, key: string) => {
      keys.push(key);
      return eventLog.findByIdem(conv, key);
    };
    const { hooks } = fakeHooks();
    await hookedStep({ ...deps, eventLog: spied, hooks: { ...hooks, has: () => false } });
    expect(keys.filter((k) => k.startsWith("hook_denied"))).toEqual([]);
  });

  it("compaction: model.request and model.response fire with purpose compaction; its usage is logged and reported (I-1)", async () => {
    await longHistory();
    const { seen, hooks } = fakeHooks();
    const owed: number[] = [];
    const r = await hookedStep(
      {
        ...deps,
        hooks,
        stepLog: stepLogFor(db, eventLog, async (_c, events) => {
          for (const e of events) if (e.type === "usage") owed.push(e.seq);
        }),
      },
      small(),
    );
    expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);
    const purposes = (mount: string) =>
      seen.filter((x) => x.mount === mount).map((x) => x.payload.purpose);
    expect(purposes("model.request")).toEqual(["compaction", "step"]);
    await vi.waitFor(() => expect(purposes("model.response")).toEqual(["compaction", "step"]));
    const compactReq = seen.find((x) => x.mount === "model.request")?.payload;
    expect(compactReq).toMatchObject({
      step: 1,
      attempt: 1,
      provider: "model-fake",
      model: "fake-small",
    });
    expect(compactReq?.request).toMatchObject({ purpose: "compaction" });
    const compactRes = seen.find((x) => x.mount === "model.response")?.payload;
    expect(compactRes).toMatchObject({ outcome: "ok", usage: expect.any(Object) });

    const usage = await ofType("usage");
    expect(usage.map((u) => u.payload.purpose ?? "step")).toEqual(["compaction", "step"]);
    expect(usage[0]?.payload).toMatchObject({
      step: 1,
      provider: "model-fake",
      model: "fake-small",
    });
    const summary = (await ofType("compaction_summary"))[0];
    // written in the same append as the compaction outcome, before the step's model_call
    expect(usage[0]?.seq).toBe((summary?.seq ?? 0) + 1);
    // each usage event's report is owed in the transaction that wrote it
    expect(owed).toEqual(usage.map((u) => u.seq));
  });

  it("compaction denied by a policy hook: compaction_failed with a generic reason, raw detail only in audit; the step goes on (I-1)", async () => {
    await longHistory();
    const { seen, hooks } = fakeHooks((p) => p.purpose === "compaction");
    const r = await hookedStep({ ...deps, hooks }, small());
    expect(r.content).toEqual([{ type: "text", text: "after compaction" }]);
    // one denied compaction: fake-small's output cap (4096) is above its window, but the planning
    // bounds (spec §4.1) keep the guard's target reachable, so the guard needs no forced compaction
    const failures = await ofType("compaction_failed");
    expect(failures.map((f) => f.payload)).toEqual([
      {
        attempt: 1,
        step: 1,
        reason: 'compaction request blocked by the "guard" policy hook (deny)',
        model: { provider: "model-fake", model: "fake-small" },
      },
    ]);
    expect(JSON.stringify(await all())).not.toContain("raw detail");
    expect(await ofType("compaction_summary")).toEqual([]);
    expect(await ofType("hook_denied")).toEqual([]);
    // the compaction call was never sent: no usage for it, no model.response for it
    expect((await ofType("usage")).map((u) => u.payload.purpose ?? "step")).toEqual(["step"]);
    // wait for the step's own model.response hook, then assert no compaction response was seen
    await vi.waitFor(
      () =>
        expect(seen.some((x) => x.mount === "model.response" && x.payload.purpose === "step")).toBe(
          true,
        ),
      { timeout: 5_000 },
    );
    expect(seen.filter((x) => x.mount === "model.response").map((x) => x.payload.purpose)).toEqual([
      "step",
    ]);
    const rows = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "hook.denied")
      .where("target", "=", conversationId)
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.detail).toMatchObject({
      purpose: "compaction",
      plugin: "guard",
      error: "raw detail",
      mount: "model.request",
    });
  });
});

describe("streaming Write base reads (streaming tool input spec §4.1)", () => {
  type Reader = NonNullable<ModelStepDeps["writeBase"]>;
  type ReadInput = Parameters<Reader["read"]>[0];
  type BaseResult = Awaited<ReturnType<Reader["read"]>>;
  const PATH = "/workspace/a.py";
  /** These tests stream the path first: no guess, so no candidates are listed. */
  const noCandidates = {
    recentPaths: async () => [],
    normalize: (p: string) => p,
  };
  const pending = <T>() => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  };
  const toolInfo = stubInfo("tooly", {
    capabilities: {
      tools: true,
      vision: false,
      reasoning: false,
      midConversationSystem: true,
    },
  });
  const writeAgent = () =>
    agentWith({
      model: { provider: "stub", model: "tooly" },
      disabledTools: onlyBuiltins([{ kind: "builtin", name: "Write" }]),
    });
  const usage = { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
  /** A provider that streams a Write start and its closed path; `after` decides what follows. */
  function writer(after: (call: number) => Promise<"complete" | ModelError>): ModelProvider {
    let calls = 0;
    return {
      async listModels() {
        return [toolInfo];
      },
      async *stream(): AsyncGenerator<ModelStreamEvent> {
        const n = ++calls;
        yield { type: "tool_call_start", id: "c1", name: "Write" };
        yield { type: "tool_call_delta", id: "c1", input: `{"file_path":"${PATH}",` };
        const outcome = await after(n);
        if (outcome !== "complete") throw outcome;
        yield { type: "tool_call_delta", id: "c1", input: `"content":"x"}` };
        yield {
          type: "message_complete",
          content: [
            {
              type: "tool_call",
              id: "c1",
              name: "Write",
              input: { file_path: PATH, content: "x" },
            },
          ],
          stopReason: "tool_use",
          usage,
        };
      },
    };
  }
  const realTools = () => k.app.get(ToolRegistry);
  const runWith = (
    reader: Reader,
    sink: StreamSink,
    kind: "chat" | "eval" | "subagent" = "chat",
    opts: { signal?: AbortSignal; settleMs?: number; log?: ModelStepDeps["log"] } = {},
  ) =>
    runModelStep(
      {
        ...deps,
        writeBase: reader,
        ...(opts.settleMs !== undefined && { writeBaseSettleMs: opts.settleMs }),
        ...(opts.log !== undefined && { log: opts.log }),
        // a replay listing offers the sandbox tools (this test has no device): the builtin Write
        tools: {
          forAgent: (org, def, ...rest) =>
            realTools().forAgent(org, { ...def, replay: true }, ...rest),
        },
      },
      {
        source: "web",
        orgId,
        conversationId,
        runId,
        step: 1,
        agent: writeAgent(),
        agentVersion: 1,
        absorbedUpToSeq: ALL_ABSORBED,
        signal: opts.signal ?? new AbortController().signal,
        sink,
        agentId: randomUUID(),
        accountId,
        conversationKind: kind,
      },
    );

  it("waits for a base read still running at the stream's end, after aborting its signal", async () => {
    stubImpl = writer(async () => "complete");
    await say("write it");
    const read = pending<BaseResult>();
    const seen: ReadInput[] = [];
    const reader: Reader = {
      ...noCandidates,
      read: (input) => {
        seen.push(input);
        return read.promise;
      },
    };
    const { deltas, sink } = collector();
    let done = false;
    const stepP = runWith(reader, sink).finally(() => {
      done = true;
    });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.path).toBe(PATH);
    // the stream ends; the read's signal is aborted, yet the step still waits for the read
    await vi.waitFor(() => expect(seen[0]?.signal.aborted).toBe(true));
    await vi.waitFor(() =>
      expect(deltas.some((d) => d.kind === "tool_input" && d.text === `"content":"x"}`)).toBe(true),
    );
    expect(done).toBe(false);
    expect(deltas.some((d) => d.kind === "stream_end")).toBe(false);
    expect(await ofType("assistant_message")).toHaveLength(0);
    // the read ends late: its base is not shown (its attempt is over)
    read.resolve({ text: "old", sha256: "0".repeat(64) });
    await stepP;
    expect(deltas.some((d) => d.kind === "tool_base")).toBe(false);
    expect(deltas.filter((d) => d.kind === "stream_end")).toHaveLength(1);
    expect(await ofType("assistant_message")).toHaveLength(1);
  });

  /** A logger that records its warnings (the rest is silent). */
  const warnings = () => {
    const seen: string[] = [];
    const log: ModelStepDeps["log"] = {
      ...silent,
      warn: (msg: string) => {
        seen.push(msg);
      },
    };
    return { seen, log };
  };
  const STRAY = "write base read still running after its abort; not waited for";

  it("a reader that never settles does not hold the step past the bound", async () => {
    stubImpl = writer(async () => "complete");
    await say("write it");
    const seen: ReadInput[] = [];
    // a provider that ignores its abort: the read never ends
    const reader: Reader = {
      ...noCandidates,
      read: (input) => {
        seen.push(input);
        return new Promise<never>(() => {});
      },
    };
    const { deltas, sink } = collector();
    const w = warnings();
    await runWith(reader, sink, "chat", { settleMs: 1, log: w.log });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(w.seen.filter((m) => m === STRAY)).toHaveLength(1);
    expect(deltas.some((d) => d.kind === "tool_base")).toBe(false);
    expect(deltas.filter((d) => d.kind === "stream_end")).toHaveLength(1);
    expect(await ofType("assistant_message")).toHaveLength(1);
  });

  it("Stop ends the step while a reader that never settles is still running", async () => {
    const stall = pending<"complete">();
    stubImpl = writer(() => stall.promise);
    await say("write it");
    const seen: ReadInput[] = [];
    const reader: Reader = {
      ...noCandidates,
      read: (input) => {
        seen.push(input);
        return new Promise<never>(() => {});
      },
    };
    const { deltas, sink } = collector();
    const stop = new AbortController();
    const w = warnings();
    const stepP = runWith(reader, sink, "chat", { signal: stop.signal, settleMs: 1, log: w.log });
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    stop.abort();
    expect(await stepP).toMatchObject({ aborted: true, stopReason: "aborted" });
    expect(seen[0]?.signal.aborted).toBe(true);
    expect(w.seen.filter((m) => m === STRAY)).toHaveLength(1);
    expect(deltas.some((d) => d.kind === "tool_base")).toBe(false);
  });

  it.each([
    ["chat", true],
    ["subagent", true],
    ["eval", false],
  ] as const)("a %s conversation: the reader is called: %s", async (kind, called) => {
    stubImpl = writer(async () => "complete");
    await say("write it");
    const seen: ReadInput[] = [];
    const reader: Reader = {
      ...noCandidates,
      read: async (input) => {
        seen.push(input);
        return { text: "old", sha256: "1".repeat(64) };
      },
    };
    const { deltas, sink } = collector();
    await runWith(reader, sink, kind);
    // the step awaited every read it started: nothing is pending after it returned
    expect(seen).toHaveLength(called ? 1 : 0);
    // the base found in time is published for chat and sub-agent runs only when the stream is
    // still open; here the read settles at once, before the stream's end
    expect(deltas.some((d) => d.kind === "tool_start")).toBe(true);
    if (!called) expect(deltas.some((d) => d.kind === "tool_base")).toBe(false);
  });

  it("a step reset cancels its reads: no base after the reset for that attempt, the retry watches afresh", async () => {
    const first = pending<BaseResult>();
    const seen: ReadInput[] = [];
    // attempt 1 fails after the path closed (a retryable error); attempt 2 completes
    stubImpl = writer(async (n) =>
      n === 1 ? new ModelError("rate_limited", "slow down") : "complete",
    );
    await say("write it");
    const reader: Reader = {
      ...noCandidates,
      read: (input) => {
        seen.push(input);
        return seen.length === 1
          ? first.promise
          : Promise.resolve({ text: "fresh", sha256: "2".repeat(64) });
      },
    };
    const { deltas, sink } = collector();
    const stepP = runWith(reader, sink);
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    await vi.waitFor(() => expect(seen[0]?.signal.aborted).toBe(true));
    // the first attempt's read ends after its reset: nothing is published for it
    first.resolve({ text: "stale", sha256: "3".repeat(64) });
    await stepP;
    expect(seen).toHaveLength(2);
    expect(seen[1]?.signal).not.toBe(seen[0]?.signal);
    const resetAt = deltas.findIndex((d) => d.kind === "step_reset");
    expect(resetAt).toBeGreaterThan(-1);
    const bases = deltas.flatMap((d, i) => (d.kind === "tool_base" ? [{ i, text: d.text }] : []));
    expect(bases.some((b) => b.text === "stale")).toBe(false);
    // the retry's read settled before its stream ended or after; either way a base is never
    // published before the reset
    expect(bases.every((b) => b.i > resetAt)).toBe(true);
  });
});

describe("the prompt cache tier (idle compaction spec §9.2)", () => {
  it("promptCache.longTtl on: the request asks model-fake for its 3600 s tier and records it", async () => {
    longTtl = true;
    await say("echo:hello");
    await step();
    const [call] = await ofType("model_call");
    expect(call?.payload.request.cacheTtl).toBe(3600);
    // model-fake reports the tier it was asked for: the request carried cacheTtl 3600
    const [usage] = await ofType("usage");
    expect(usage?.payload.cacheWriteTokens).toBeGreaterThan(0);
    expect(usage?.payload.cacheWriteByTtl).toEqual([
      { ttl: 3600, tokens: usage?.payload.cacheWriteTokens },
    ]);
  });

  it("promptCache.longTtl off: no cacheTtl is recorded or sent (the model's default tier)", async () => {
    await say("echo:hello");
    await step();
    const [call] = await ofType("model_call");
    expect(call?.payload.request).not.toHaveProperty("cacheTtl");
    const [usage] = await ofType("usage");
    expect(usage?.payload.cacheWriteByTtl).toEqual([
      { ttl: 300, tokens: usage?.payload.cacheWriteTokens },
    ]);
  });

  it("a model without a cache gets no cacheTtl and reports no tiers", async () => {
    longTtl = true;
    await say("echo:hello");
    await step({ agent: agentWith({ model: { provider: "model-fake", model: "fake-nocache" } }) });
    const [call] = await ofType("model_call");
    expect(call?.payload.request).not.toHaveProperty("cacheTtl");
    const [usage] = await ofType("usage");
    expect(usage?.payload.cacheWriteTokens).toBe(0);
    expect(usage?.payload).not.toHaveProperty("cacheWriteByTtl");
  });

  it("each rung chooses for its own model: a fallback on a model without a cache records none", async () => {
    longTtl = true;
    const main = stub(
      [
        stubInfo("limited", {
          cache: {
            mechanism: "explicit",
            ttlOptions: [300, 3600],
            defaultTtl: 300,
            ttlIsMinimum: false,
            refreshOnHit: true,
            ttlClock: "request_start",
            guaranteed: true,
          },
        }),
      ],
      () => {
        throw new ModelError("rate_limited", "slow down", { retryAfterMs: 600_000 });
      },
    );
    stubImpl = main;
    await say("echo:from fallback");
    const r = await step({
      agent: agentWith({
        model: { provider: "stub", model: "limited" },
        fallback: { provider: "model-fake", model: "fake-nocache" },
      }),
    });
    expect(r.content).toEqual([{ type: "text", text: "from fallback" }]);
    const calls = await ofType("model_call");
    expect(calls.map((c) => [c.payload.model, c.payload.request.cacheTtl])).toEqual([
      ["limited", 3600],
      ["fake-nocache", undefined],
    ]);
    expect(calls[1]?.payload.request).not.toHaveProperty("cacheTtl");
    expect(main.calls.map((c) => c.cacheTtl)).toEqual([3600]);
  });

  it("a malformed cacheWriteByTtl is dropped with a warn; the step completes with the rest of the usage", async () => {
    stubImpl = stub(
      [stubInfo("ok")],
      () => "ok",
      () => ({
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 5,
        // sums to 7, not cacheWriteTokens 5
        cacheWriteByTtl: [{ ttl: 300, tokens: 7 }],
      }),
    );
    const warn = vi.spyOn(deps.log, "warn");
    try {
      await say("hi");
      const r = await step({ agent: agentWith({ model: { provider: "stub", model: "ok" } }) });
      expect(r.content).toEqual([{ type: "text", text: "ok" }]);
      const [usage] = await ofType("usage");
      expect(usage?.payload).toMatchObject({ inputTokens: 10, cacheWriteTokens: 5 });
      expect(usage?.payload).not.toHaveProperty("cacheWriteByTtl");
      expect(warn).toHaveBeenCalledWith(
        "invalid cacheWriteByTtl from the provider; dropped",
        expect.objectContaining({ model: "ok" }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("the wrap-up call chooses the tier too", async () => {
    longTtl = true;
    await say("echo:summary");
    await runFinalWrapUp(deps, {
      source: "web",
      orgId,
      conversationId,
      runId,
      step: 2,
      agent: agentWith(),
      agentVersion: 1,
      absorbedUpToSeq: ALL_ABSORBED,
      signal: new AbortController().signal,
      sink: () => {},
    });
    const [call] = await ofType("model_call");
    expect(call?.payload.request.cacheTtl).toBe(3600);
  });
});
