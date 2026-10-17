import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  StopReason,
} from "@capybara-hq/plugin-sdk";
import {
  createDualReplicaHarness,
  type Harness,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import { LangGraphLoop, TOOLS_UNAVAILABLE_REMINDER } from "../../src/runtime/langgraph-loop.js";
import type { LoopContext } from "../../src/runtime/loop.js";
import type { ModelStepDeps, StreamSink } from "../../src/runtime/model-call.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { runJobId } from "../../src/runtime/run-queue.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, sleep, waitFor, waitForTerminal } from "../helpers/runs.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let deps: ModelStepDeps;
let saver: KyselyCheckpointSaver;
let runtimeOverrides: Partial<KernelConfig["runtime"]> = {};

const silent = createLogger("error", { write: () => {} });

const stubInfo: ModelInfo = {
  id: "s-1",
  displayName: "s-1",
  contextWindow: 32_000,
  maxOutputTokens: 4096,
  capabilities: {
    tools: true,
    vision: false,
    reasoning: false,
    caching: false,
    midConversationSystem: true,
    effort: false,
  },
};

/** 测试内的供应商桩：记录每次 stream 调用；`script` 决定每次调用返回的文本与 stopReason。 */
const calls: ModelRequest[] = [];
let script: (n: number) => { text: string; stopReason: StopReason } = () => ({
  text: "ok",
  stopReason: "end_turn",
});
const stubProvider: ModelProvider = {
  async listModels() {
    return [stubInfo];
  },
  async *stream(req): AsyncGenerator<ModelStreamEvent> {
    calls.push(req);
    const { text, stopReason } = script(calls.length);
    for (let i = 0; i < text.length; i += 4) {
      yield { type: "text_delta", text: text.slice(i, i + 4) };
    }
    yield {
      type: "message_complete",
      content:
        stopReason === "tool_use"
          ? [{ type: "tool_call", id: randomUUID(), name: "noop", input: {} }]
          : [{ type: "text", text }],
      stopReason,
      usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
    };
  },
};

const agent: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  effort: null,
  tools: [],
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 10);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  sub = createBusSubscriber(() => new Redis(rd.url));
  eventLog = new EventLog(db, createBus(redis, sub, "kernel"));
  const base = KernelConfigSchema.parse({
    db: { url: pgc.url },
    redis: { url: rd.url },
    masterKey: Buffer.alloc(32, 7).toString("base64"),
  });
  deps = {
    db,
    eventLog,
    registry: new ProviderRegistry({ list: () => [{ plugin: "stub", impl: stubProvider }] }, redis),
    config: () => ({ ...base, runtime: { ...base.runtime, ...runtimeOverrides } }),
    log: silent,
  };
  saver = new KyselyCheckpointSaver(db);
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let conversationId: string;
let accountId: string;
let runId: string;

beforeEach(async () => {
  calls.length = 0;
  script = () => ({ text: "ok", stopReason: "end_turn" });
  runtimeOverrides = {};
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.lg_checkpoints, capybara.lg_checkpoint_writes CASCADE`.execute(
    raw,
  );
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

async function say(text: string): Promise<number> {
  const [e] = await eventLog.append(conversationId, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text }], authorAccountId: accountId },
    },
  ]);
  return (e as ConversationEvent).seq;
}

type Delta = Parameters<StreamSink>[0];

/** 与 run-worker 相同语义的最小 LoopContext。 */
function loopCtx(
  over: Partial<LoopContext> = {},
  deltas: Delta[] = [],
): LoopContext & { deltas: Delta[] } {
  return {
    conversationId,
    runId,
    agent,
    agentVersion: 1,
    signal: new AbortController().signal,
    shutdown: new AbortController().signal,
    sink: (d) => deltas.push(d),
    async pendingUserMessages(afterSeq) {
      const evs = await eventLog.readAfter(conversationId, afterSeq, 1000);
      return evs.filter((e) => e.type === "user_message");
    },
    limits: { maxSteps: 50, deadline: Date.now() + 60_000 },
    deltas,
    ...over,
  };
}

const checkpointRows = async (threadId: string) =>
  (
    await db
      .selectFrom("lg_checkpoints")
      .select("checkpoint_id")
      .where("thread_id", "=", threadId)
      .execute()
  ).length;

class SimulatedCrash extends Error {}

describe("LangGraphLoop", () => {
  it("一步完成：completed，consumedUpToSeq 为吸收到的消息，checkpoint 以 runId 为 thread", async () => {
    const seq = await say("hi");
    const out = await new LangGraphLoop(saver, deps).run(loopCtx());
    expect(out).toEqual({ kind: "completed", consumedUpToSeq: seq });
    const evs = await eventsOf(db, conversationId);
    expect(evs.map((e) => e.type)).toEqual([
      "user_message",
      "model_call",
      "assistant_message",
      "usage",
    ]);
    expect(await checkpointRows(runId)).toBeGreaterThan(0);
    const tuple = await saver.getTuple({ configurable: { thread_id: runId } });
    expect(tuple?.checkpoint.channel_values).toMatchObject({
      step: 1,
      consumedUpToSeq: seq,
      lastStopReason: "end_turn",
    });
  });

  it("tool_use → tools 占位节点写提醒后回到 prepare；到 maxSteps 后 wrapUp → max_steps", async () => {
    script = (n) =>
      n <= 2 ? { text: "", stopReason: "tool_use" } : { text: "done", stopReason: "end_turn" };
    const seq = await say("go");
    const out = await new LangGraphLoop(saver, deps).run(
      loopCtx({ limits: { maxSteps: 2, deadline: Date.now() + 60_000 } }),
    );
    expect(out).toEqual({ kind: "max_steps", consumedUpToSeq: seq });
    const evs = await eventsOf(db, conversationId);
    const msgs = evs.flatMap((e) =>
      e.type === "assistant_message" ? [[e.payload.step, e.payload.stopReason]] : [],
    );
    expect(msgs).toEqual([
      [1, "tool_use"],
      [2, "tool_use"],
      [3, "end_turn"],
    ]);
    const toolReminders = evs.filter(
      (e) => e.type === "reminder" && e.payload.text === TOOLS_UNAVAILABLE_REMINDER,
    );
    expect(toolReminders.map((e) => (e.type === "reminder" ? e.payload.step : 0))).toEqual([1, 2]);
    // wrap-up 请求没有工具
    expect(calls[2]?.tools).toEqual([]);
  });

  it("停机信号：在 prepare 处返回 interrupted，checkpoint 停在下一步之前；续跑从那里继续", async () => {
    script = (n) =>
      n === 1 ? { text: "", stopReason: "tool_use" } : { text: "two", stopReason: "end_turn" };
    const seq = await say("go");
    const shutdown = new AbortController();
    let step1Done = false;
    const loop1 = new LangGraphLoop(saver, deps, {
      async afterModelStep() {
        step1Done = true;
        shutdown.abort();
      },
    });
    expect(await loop1.run(loopCtx({ shutdown: shutdown.signal }))).toEqual({
      kind: "interrupted",
    });
    expect(step1Done).toBe(true);
    expect(calls).toHaveLength(1);
    const deltas: Delta[] = [];
    const out = await new LangGraphLoop(saver, deps).run(loopCtx({}, deltas));
    expect(out).toEqual({ kind: "completed", consumedUpToSeq: seq });
    expect(calls).toHaveLength(2);
    // 续跑的是 prepare 节点，不是 model：不发 step_reset
    expect(deltas.some((d) => d.kind === "step_reset")).toBe(false);
    const steps = (await eventsOf(db, conversationId)).flatMap((e) =>
      e.type === "assistant_message" ? [e.payload.step] : [],
    );
    expect(steps).toEqual([1, 2]);
  });

  it("步骤边界之后崩溃（assistant_message 已写入、checkpoint 未保存）→ 续跑复用已有回复，不再调用模型", async () => {
    const seq = await say("hi");
    const crashing = new LangGraphLoop(saver, deps, {
      async afterModelStep() {
        throw new SimulatedCrash("process died after runModelStep returned");
      },
    });
    await expect(crashing.run(loopCtx())).rejects.toBeInstanceOf(SimulatedCrash);
    expect(calls).toHaveLength(1);

    const deltas: Delta[] = [];
    const out = await new LangGraphLoop(saver, deps).run(loopCtx({}, deltas));
    expect(out).toEqual({ kind: "completed", consumedUpToSeq: seq });
    // 桩供应商的调用计数不增加
    expect(calls).toHaveLength(1);
    // 续跑的是 model 节点：先发 step_reset
    expect(deltas[0]).toEqual({ kind: "step_reset", runId, step: 1 });
    const evs = await eventsOf(db, conversationId);
    expect(evs.filter((e) => e.type === "assistant_message")).toHaveLength(1);
    expect(evs.filter((e) => e.type === "model_call")).toHaveLength(1);
  });

  it("图已经结束（终态写入前崩溃）→ 续跑直接返回同样的结果，不再调用模型", async () => {
    const seq = await say("hi");
    expect(await new LangGraphLoop(saver, deps).run(loopCtx())).toEqual({
      kind: "completed",
      consumedUpToSeq: seq,
    });
    expect(await new LangGraphLoop(saver, deps).run(loopCtx())).toEqual({
      kind: "completed",
      consumedUpToSeq: seq,
    });
    expect(calls).toHaveLength(1);
  });

  it("中止：model 节点返回 aborted → aborted；deadline 已过 → max_duration", async () => {
    await say("hi");
    const ac = new AbortController();
    ac.abort();
    expect(await new LangGraphLoop(saver, deps).run(loopCtx({ signal: ac.signal }))).toEqual({
      kind: "aborted",
    });
    runId = randomUUID();
    await say("again");
    expect(
      await new LangGraphLoop(saver, deps).run(
        loopCtx({ limits: { maxSteps: 50, deadline: Date.now() - 1 } }),
      ),
      // 先查截止时间（R33）：超时结束时不吸收任何消息
    ).toEqual({ kind: "max_duration", consumedUpToSeq: 0 });
    expect(calls).toHaveLength(0);
  });
});

// ---- 跨进程：SIGKILL 正在流式输出的 worker 副本，另一个副本从 checkpoint 续跑 ----

describe("LangGraphLoop crash resume (dual replica)", () => {
  let h: Harness | undefined;
  let listener: Redis | undefined;

  afterEach(async () => {
    listener?.disconnect();
    listener = undefined;
    await h?.stop();
    h = undefined;
  });

  /** 以 Cookie 身份经 harness 发 JSON 请求（自动带 CSRF 头）。 */
  async function call(
    cookie: string | undefined,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown>; cookies: string[] }> {
    const res = await (h as Harness).request(path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(body !== undefined && { "content-type": "application/json" }),
        ...(cookie !== undefined && { cookie }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return {
      status: res.status,
      json: text === "" ? {} : (JSON.parse(text) as never),
      cookies: res.headers.getSetCookie(),
    };
  }

  it("resume after crash mid-step：每个 (run, step) 恰好一条 assistant_message，一条 run_started，run_finished 存在，频道收到 step_reset", async () => {
    // Redis 每个测试独占（harness 要求同一 Redis 不被多个同时存活的 harness 共用）
    await redis.flushdb();
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE],
      pgUrl: pgc.url,
      redisUrl: rd.url,
      config: {
        auth: { cookieSecure: false },
        runtime: { jobLockMs: 1000, stalledIntervalMs: 500 },
      },
    });
    const hraw = createDb(h.dbUrl, 3);
    const hdb = kernelDb(hraw);
    try {
      await new AccountsService(hdb).createLocal({
        login: "owner",
        password: PW,
        displayName: "O",
      });
      const login = await call(undefined, "POST", "/api/v1/auth/login", {
        login: "owner",
        password: PW,
      });
      expect(login.status).toBe(200);
      const cookie = login.cookies.map((c) => c.split(";")[0]).join("; ");
      const org = await call(cookie, "POST", "/api/v1/orgs", { name: "Acme" });
      expect(org.status).toBe(201);
      const orgId = (org.json.org as { id: string }).id;
      const ag = await call(cookie, "POST", `/api/v1/orgs/${orgId}/agents`, {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
        },
        visibility: "org",
      });
      expect(ag.status).toBe(201);
      const agentId = (ag.json.agent as { id: string }).id;
      const conv = await call(cookie, "POST", `/api/v1/orgs/${orgId}/conversations`, { agentId });
      expect(conv.status).toBe(201);
      const convId = (conv.json.conversation as { id: string }).id;

      // 监听会话频道上的增量
      const deltas: { delta: string; step: number; runId: string }[] = [];
      listener = new Redis(rd.url);
      listener.on("message", (_ch: string, msg: string) => {
        const m = JSON.parse(msg) as { kind: string; delta: string; step: number; runId: string };
        if (m.kind === "delta") deltas.push(m);
      });
      await listener.subscribe(`cap:kernel:conv.${convId}`);

      const reply = "abcdefghijklmnopqrstuvwxyz0123456789";
      const posted = await call(
        cookie,
        "POST",
        `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
        {
          text: `slow:200:${reply}`,
        },
      );
      expect(posted.status).toBe(202);
      const seq = (posted.json.event as { seq: number }).seq;

      // 流到一半：至少收到 2 个文本增量
      await waitFor(
        async () => deltas.filter((d) => d.delta === "text").length >= 2,
        20_000,
        "text deltas",
      );
      // 找到正在执行的副本：BullMQ 记录领取任务的 worker 名（含 pid）
      const processedBy = await redis.hget(`bull:cap-kernel-runs:${runJobId(convId, seq)}`, "pb");
      const victim = h.replicas.find((r) => processedBy?.endsWith(`-${r.pid}`));
      expect(victim, `processedBy=${processedBy}`).toBeDefined();
      const victimIndex = (victim as { index: 0 | 1 }).index;
      await h.kill(victimIndex);
      const beforeKill = deltas.length;

      const [fin] = await waitForTerminal(hdb, convId, 1, 40_000);
      expect(fin?.type).toBe("run_finished");
      await sleep(300);
      const evs = await eventsOf(hdb, convId);
      const runId = fin?.runId as string;
      const msgs = evs.filter((e) => e.type === "assistant_message" && e.runId === runId);
      expect(msgs.map((m) => (m.type === "assistant_message" ? m.payload.step : 0))).toEqual([1]);
      const text = (msgs[0] as ConversationEvent & { type: "assistant_message" }).payload.content
        .flatMap((b) => (b.type === "text" ? [b.text] : []))
        .join("");
      expect(text).toBe(reply);
      expect(evs.filter((e) => e.type === "run_started")).toHaveLength(1);
      expect(evs.filter((e) => e.type === "run_finished")).toHaveLength(1);
      // 存活副本续跑时先发 step_reset，之后重新流出完整回复
      const after = deltas.slice(beforeKill);
      const resetAt = after.findIndex((d) => d.delta === "step_reset" && d.step === 1);
      expect(resetAt).toBeGreaterThanOrEqual(0);
      expect(after.slice(resetAt + 1).filter((d) => d.delta === "text").length).toBeGreaterThan(0);
      // 运行到达终态后该 thread 的 checkpoint 全部删除（删除在终态写入之后进行，稍等）
      const cpsLeft = async () =>
        (
          await hdb
            .selectFrom("lg_checkpoints")
            .select("checkpoint_id")
            .where("thread_id", "=", runId)
            .execute()
        ).length;
      const until = Date.now() + 5_000;
      while ((await cpsLeft()) > 0 && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(await cpsLeft()).toBe(0);
      // 被杀的副本之后的请求直接报错
      await expect(
        (async () => {
          for (let i = 0; i < 2; i++) await h?.request("/healthz");
        })(),
      ).rejects.toThrow(/replica/);
    } finally {
      await hraw.destroy();
    }
  }, 120_000);
});
