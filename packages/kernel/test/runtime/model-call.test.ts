import { randomUUID } from "node:crypto";
import type {
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
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
  WRAP_UP_REMINDER,
} from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
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
  ...extra,
});

interface Stub extends ModelProvider {
  calls: ModelRequest[];
}

/** `respond` 返回文本即流式输出该文本（每 4 字符一个增量）；usage 的输入 token 与内核估算一致（校正比例为 1）。 */
function stub(models: ModelInfo[], respond: (req: ModelRequest) => string): Stub {
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
        usage: {
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
    { list: (cap: string) => [...k.host.list(cap), { plugin: "stub", impl: stubImpl }] },
    redis,
  );
  deps = {
    db,
    eventLog,
    registry,
    config: () => ({ ...baseConfig, runtime: { ...baseConfig.runtime, ...runtimeOverrides } }),
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

beforeEach(async () => {
  await redis.flushdb();
  runtimeOverrides = {};
  stubImpl = stub([stubInfo("ok")], () => "ok");
  await sql`TRUNCATE capybara.accounts, capybara.orgs CASCADE`.execute(raw);
  accountId = randomUUID();
  const orgId = randomUUID();
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
  effort: null,
  tools: [],
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
    conversationId,
    runId,
    step: over.step ?? 1,
    agent: over.agent ?? agentWith(),
    agentVersion: 1,
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
      request: { maxOutputTokens: 4096, effort: null, summarySeq: null, reminderSeqs: [] },
    });
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
    expect(elapsed).toBeLessThan(2000);
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
          { plugin: "flaky", impl: flaky },
          { plugin: "stub", impl: stubImpl },
        ],
      },
      redis,
    );
    await say("hi");
    const { deltas, sink } = collector();
    const r = await runModelStep(
      { ...deps, registry },
      {
        conversationId,
        runId,
        step: 1,
        agent: agentWith({
          model: { provider: "flaky", model: "x" },
          fallback: { provider: "stub", model: "ok" },
        }),
        agentVersion: 1,
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
      { list: (cap: string) => [...k.host.list(cap), { plugin: "broken", impl: broken }] },
      redis,
    );
    await say("hi");
    const p = runModelStep(
      { ...deps, registry },
      {
        conversationId,
        runId,
        step: 1,
        agent: agentWith({ model: { provider: "broken", model: "x" } }),
        agentVersion: 1,
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
    await say("fail:overloaded");
    const ac = new AbortController();
    const t0 = Date.now();
    setTimeout(() => ac.abort(), 100);
    const r = await step({ signal: ac.signal });
    expect(Date.now() - t0).toBeLessThan(800);
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
      conversationId,
      runId,
      step: 51,
      agent: agentWith({ model: { provider: "stub", model: "ok" } }),
      agentVersion: 1,
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
  });
});
