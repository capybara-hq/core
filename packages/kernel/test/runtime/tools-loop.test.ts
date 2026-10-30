import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type {
  ContentBlock,
  ModelInfo,
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ToolResult,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import type { KyselyCheckpointSaver } from "../../src/runtime/checkpointer.js";
import { UNKNOWN_RESULT_TEXT } from "../../src/runtime/context/pairing.js";
import { LangGraphLoop, type LoopDeps } from "../../src/runtime/langgraph-loop.js";
import type { LoopContext } from "../../src/runtime/loop.js";
import { type ResolvedTool, specHash } from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitForTerminal,
} from "../helpers/runs.js";
import { checkpointsFor, providerRegistryFor, stepLogFor } from "../helpers/runtime.js";
import { seedConversation } from "../helpers/tool-fixtures.js";
import {
  approvalsFor,
  breakerFor,
  outputsFor,
  pipelineFor,
  questionsFor,
} from "../helpers/tools.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

const silent = createLogger("error", { write: () => {} });

const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));

describe("tools 节点（LangGraphLoop + 执行管线）", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let raw: ReturnType<typeof createDb>;
  let db: KernelSchemaDb;
  let redis: Redis;
  let sub: ReturnType<typeof createBusSubscriber>;
  let eventLog: EventLog;
  let saver: KyselyCheckpointSaver;
  let deps: LoopDeps;

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
    parameters: [],
  };
  /** 第 1 次调用返回三个工具调用，之后返回文本。 */
  const calls: ModelRequest[] = [];
  const stubProvider: ModelProvider = {
    async listModels() {
      return [stubInfo];
    },
    async *stream(req): AsyncGenerator<ModelStreamEvent> {
      calls.push(req);
      const content: ContentBlock[] =
        calls.length === 1
          ? ["1", "2", "3"].map((n) => ({
              type: "tool_call",
              id: `c${n}`,
              name: "probe__echo",
              input: { text: n },
            }))
          : [{ type: "text", text: "done" }];
      yield {
        type: "message_complete",
        content,
        stopReason: calls.length === 1 ? "tool_use" : "end_turn",
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      };
    },
  };

  const echoSpec = {
    name: "echo",
    description: "Echo.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
  };
  const echo: ResolvedTool = {
    key: "probe__echo",
    source: { kind: "plugin", plugin: "probe", name: "echo" },
    spec: echoSpec,
    specHash: specHash(echoSpec),
    defaultPolicy: "allow",
  };
  let invoked: string[] = [];
  let crashOn: string | null = null;

  const agent: AgentDefinition = {
    name: "Helper",
    avatarUrl: null,
    instructions: "Be helpful.",
    model: { provider: "stub", model: "s-1" },
    fallback: null,
    modelParams: {},
    fallbackParams: {},
    tools: [{ kind: "plugin", plugin: "probe", name: "echo" }],
    toolPolicies: {},
  };

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    await migrate(pgc.url, {
      schema: "capybara",
      dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
    });
    raw = createDb(pgc.url, 10);
    db = legacyDbFor(raw);
    redis = new Redis(rd.url);
    sub = createBusSubscriber(() => new Redis(rd.url));
    eventLog = eventLogFor(db, createBus(redis, sub, "kernel"));
    const config = KernelConfigSchema.parse({
      db: { url: pgc.url },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
    });
    const registry = {
      forAgent: async () => ({ tools: [echo], unavailable: [] }),
      findConnector: () => undefined,
      handler:
        () =>
        async (input: unknown): Promise<ToolResult> => {
          const text = (input as { text: string }).text;
          invoked.push(text);
          return { content: [{ type: "text", text: `echo ${text}` }] };
        },
    };
    deps = {
      db,
      eventLog,
      stepLog: stepLogFor(db, eventLog),
      registry: providerRegistryFor(
        { list: () => [{ plugin: "stub", capability: "model-provider@2", impl: stubProvider }] },
        redis,
      ),
      tools: registry,
      config: { get: () => config },
      log: silent,
      toolPipeline: pipelineFor({
        db,
        eventLog,
        registry,
        credentials: { injection: async () => ({ headers: {} }), onUnauthorized: async () => {} },
        breaker: breakerFor(redis, () => config),
        outputs: outputsFor(db, () => config),
        approvals: approvalsFor(db, eventLog, () => config),
        questions: questionsFor(db, eventLog, () => config),
        config: () => config,
        log: silent,
        hooks: {
          afterExecute: async (_runId: string, callId: string) => {
            if (callId === crashOn) {
              crashOn = null;
              throw new SimulatedCrash();
            }
          },
        },
      }),
    };
    saver = checkpointsFor(db);
  }, 120_000);

  afterAll(async () => {
    await sub?.close();
    redis?.disconnect();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  class SimulatedCrash extends Error {}

  let seed: Awaited<ReturnType<typeof seedConversation>>;
  let runId: string;
  beforeEach(async () => {
    calls.length = 0;
    invoked = [];
    crashOn = null;
    await truncateTables(
      raw,
      "capybara.accounts, capybara.orgs, capybara.lg_checkpoints, capybara.lg_checkpoint_writes",
    );
    seed = await seedConversation(raw);
    runId = randomUUID();
    await eventLog.append(seed.conversationId, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text: "go" }], authorAccountId: seed.accountId },
      },
    ]);
  });

  const ctx = (): LoopContext => ({
    orgId: seed.orgId,
    conversationId: seed.conversationId,
    runId,
    agentId: seed.agentId,
    triggerAccountId: seed.accountId,
    agent,
    agentVersion: 1,
    signal: new AbortController().signal,
    shutdown: new AbortController().signal,
    sink: () => {},
    async pendingUserMessages(afterSeq) {
      const evs = await eventLog.readAfter(seed.conversationId, afterSeq, 1000);
      return evs.filter((e) => e.type === "user_message");
    },
    limits: { maxSteps: 10, deadline: Date.now() + 60_000 },
  });

  it("一步三个调用按顺序执行，结果按调用顺序进入下一步请求", async () => {
    const out = await new LangGraphLoop(saver, deps).run(ctx());
    expect(out.kind).toBe("completed");
    expect(invoked).toEqual(["1", "2", "3"]);
    const evs = await eventsOf(db, seed.conversationId);
    const kinds = evs
      .filter((e) => e.type === "tool_call_started" || e.type === "tool_result")
      .map((e) => `${e.type}:${(e.payload as { callId: string }).callId}`);
    expect(kinds).toEqual([
      "tool_call_started:c1",
      "tool_result:c1",
      "tool_call_started:c2",
      "tool_result:c2",
      "tool_call_started:c3",
      "tool_result:c3",
    ]);
    const last = calls[1]?.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.role === "user" && last.content).toEqual([
      { type: "tool_result", callId: "c1", content: "echo 1", isError: false },
      { type: "tool_result", callId: "c2", content: "echo 2", isError: false },
      { type: "tool_result", callId: "c3", content: "echo 3", isError: false },
    ]);
  });

  it("Review Focus 2：执行第二个调用后、写结果前崩溃 → 续跑时该调用为「结果未知」，工具各只调用一次", async () => {
    crashOn = "c2";
    await expect(new LangGraphLoop(saver, deps).run(ctx())).rejects.toThrow(SimulatedCrash);
    expect(invoked).toEqual(["1", "2"]);
    const out = await new LangGraphLoop(saver, deps).run(ctx());
    expect(out.kind).toBe("completed");
    // c1 不重复执行、c2 不再执行、c3 正常执行
    expect(invoked).toEqual(["1", "2", "3"]);
    const evs = await eventsOf(db, seed.conversationId);
    expect(resultsOf(evs).map((r) => [r.callId, r.content])).toEqual([
      ["c1", "echo 1"],
      ["c2", UNKNOWN_RESULT_TEXT],
      ["c3", "echo 3"],
    ]);
    // 模型只被调用两次（第一步的回复复用），第二步请求里带三条结果
    expect(calls).toHaveLength(2);
    const last = calls[1]?.messages.at(-1);
    expect(
      last?.role === "user" && last.content.map((b) => b.type === "tool_result" && b.content),
    ).toEqual(["echo 1", UNKNOWN_RESULT_TEXT, "echo 3"]);
  });
});

describe("端到端：model-fake 脚本工具调用 → 连接器工具与插件工具", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: TestKernel;
  let req: Req;
  let orgId: string;

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    k = await startKernel(
      runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MEM_CONNECTOR] }),
    );
  }, 120_000);
  afterAll(async () => {
    await k?.close();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  beforeEach(async () => {
    const { AccountsService } = await import("../../src/identity/accounts.js");
    const raw = createDb(pgc.url, 2);
    await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
    await accountsFor(kernelDb(raw)).createLocal({
      login: "owner",
      password: "correct horse battery",
      displayName: "O",
    });
    await raw.destroy();
    const st = memState();
    st.calls = [];
    st.echoCalls = 0;
    st.servers = {
      open: {
        tools: [
          {
            name: "read",
            description: "Read.",
            inputSchema: { type: "object", properties: { q: { type: "string" } } },
            annotations: { readOnlyHint: true },
          },
        ],
      },
    };
    req = await session(k, "owner");
    orgId = await createOrg(req);
  });

  it("连接器工具与插件工具各调用一次，模型拿到结果后结束", async () => {
    const app = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Open",
        slug: "open",
        connector: "mem",
        endpoint: { server: "open" },
        auth: { type: "none" },
      },
    });
    expect(app.statusCode, app.body).toBe(201);
    const connectorId = (app.json() as { connector: { id: string } }).connector.id;
    const en = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
    const ag = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [
            { kind: "connector", connectorId, tools: "all" },
            { kind: "plugin", plugin: "mem-connector", name: "echo" },
          ],
        },
        visibility: "org",
      },
    });
    expect(ag.statusCode, ag.body).toBe(201);
    const agentId = (ag.json() as { agent: { id: string } }).agent.id;
    const db = kernelDb(createDb(pgc.url, 2));
    try {
      const convId = await createConv(req, orgId, agentId);
      await postMessage(req, orgId, convId, 'tool:open__read:{"q":"x"}');
      await waitForTerminal(db, convId, 1);
      await postMessage(req, orgId, convId, 'tool:mem-connector__echo:{"text":"hi"}');
      await waitForTerminal(db, convId, 2);
      const evs = await eventsOf(db, convId);
      expect(resultsOf(evs).map((r) => [r.toolKey, r.content, r.isError])).toEqual([
        ["open__read", "called read", false],
        ["mem-connector__echo", '{"text":"hi"}', false],
      ]);
      expect(memState().calls).toEqual([{ server: "open", name: "read", input: { q: "x" } }]);
      expect(memState().echoCalls).toBe(1);
      const replies = evs.flatMap((e) =>
        e.type === "assistant_message" && e.payload.stopReason === "end_turn"
          ? [e.payload.content]
          : [],
      );
      expect(replies).toEqual([
        [{ type: "text", text: "Tool result: called read" }],
        [{ type: "text", text: 'Tool result: {"text":"hi"}' }],
      ]);
      const audits = await db
        .selectFrom("audit_events")
        .select(["action", "detail"])
        .where("action", "=", "tool.called")
        .execute();
      expect(audits.map((a) => (a.detail as { toolKey: string }).toolKey)).toEqual([
        "open__read",
        "mem-connector__echo",
      ]);
    } finally {
      await db.destroy();
    }
  });
});
