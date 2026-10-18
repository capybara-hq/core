import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type Connector,
  type ContentBlock,
  type ToolCallContext,
  ToolError,
  type ToolHandler,
  type ToolResult,
  type ToolSpec,
} from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { AgentDefinition } from "../../src/agents/definition.js";
import { type KernelConfig, KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { createBus, createBusSubscriber } from "../../src/ctx/bus.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import { UNKNOWN_RESULT_TEXT } from "../../src/runtime/context/pairing.js";
import { assistantIdemKey } from "../../src/runtime/model-call.js";
import { ApprovalsService } from "../../src/tools/approvals.service.js";
import { Breaker } from "../../src/tools/breaker.js";
import { type AppAuth, CredentialMissing } from "../../src/tools/credentials.js";
import { ToolOutputs } from "../../src/tools/outputs.js";
import {
  type DecidePolicy,
  RUN_STOPPED_DURING_TEXT,
  RUN_STOPPED_TEXT,
  ToolPipeline,
  type ToolPipelineDeps,
  type ToolStepContext,
} from "../../src/tools/pipeline.js";
import { QuestionsService } from "../../src/tools/questions.service.js";
import { type ResolvedTool, specHash, type UnavailableTool } from "../../src/tools/registry.js";
import { validateInput } from "../../src/tools/validate.js";
import { eventsOf } from "../helpers/runs.js";
import { seedApp, seedConversation } from "../helpers/tool-fixtures.js";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let sub: ReturnType<typeof createBusSubscriber>;
let eventLog: EventLog;
let outputs: ToolOutputs;
let breaker: Breaker;
let toolsCfg: Partial<KernelConfig["tools"]> = {};
const silent = createLogger("error", { write: () => {} });

const base = KernelConfigSchema.parse({
  db: { url: "postgres://x/y" },
  redis: { url: "redis://x" },
  masterKey: Buffer.alloc(32, 7).toString("base64"),
});
const config = (): KernelConfig => ({ ...base, tools: { ...base.tools, ...toolsCfg } });

const agent: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "Be helpful.",
  model: { provider: "stub", model: "s-1" },
  fallback: null,
  modelParams: {},
  fallbackParams: {},
  tools: [],
  toolPolicies: {},
};

// ---- 测试用工具：插件工具（处理函数在 handlers 里）与应用工具（经 test 连接器） ----

const ECHO_SCHEMA = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
};

const pluginSpec = (name: string, inputSchema: Record<string, unknown> = { type: "object" }) =>
  ({ name, description: `${name} tool.`, inputSchema }) satisfies ToolSpec;

function pluginTool(
  name: string,
  policy: ResolvedTool["defaultPolicy"] = "allow",
  schema?: Record<string, unknown>,
): ResolvedTool {
  const spec = pluginSpec(name, schema);
  return {
    key: `probe__${name}`,
    source: { kind: "plugin", plugin: "probe", name },
    spec,
    specHash: specHash(spec),
    defaultPolicy: policy,
  };
}

function appTool(slug: string, appId: string, name: string): ResolvedTool {
  const spec = pluginSpec(name);
  return {
    key: `${slug}__${name}`,
    source: { kind: "app", appId, name },
    spec,
    specHash: specHash(spec),
    defaultPolicy: "allow",
  };
}

/** 应用工具的快照行（执行时策略判定会实时重读 app_tools）。 */
async function seedAppTool(id: string, name: string): Promise<void> {
  const spec = pluginSpec(name);
  await sql`INSERT INTO capybara.app_tools (app_id, name, spec, spec_hash, status, default_policy)
    VALUES (${id}, ${name}, ${JSON.stringify(spec)}::jsonb, ${specHash(spec)}, 'enabled', 'allow')`.execute(
    raw,
  );
}

/** 插件处理函数调用记录（工具名 → 调用参数列表）。 */
let handlerCalls: Record<string, unknown[]> = {};
let handlers: Record<string, ToolHandler> = {};
const record = (name: string, input: unknown) => {
  handlerCalls[name] = [...(handlerCalls[name] ?? []), input];
};

/** test 连接器：行为由 connCall 决定；记录打开 / 关闭 / 调用次数与收到的 signal。 */
let connCall: (name: string, input: unknown, signal: AbortSignal) => Promise<ToolResult>;
const conn = { opened: 0, closed: 0, calls: 0, signals: [] as AbortSignal[] };
const testConnector: Connector = {
  kind: "test",
  endpointSchema: z.object({}),
  async open(args) {
    conn.opened++;
    return {
      async listTools() {
        return [];
      },
      async callTool(name, input, signal) {
        conn.calls++;
        conn.signals.push(signal);
        await args.auth();
        return connCall(name, input, signal);
      },
      async close() {
        conn.closed++;
      },
    };
  },
};

let resolved: ResolvedTool[] = [];
let unavailable: UnavailableTool[] = [];
let decidePolicy: DecidePolicy | undefined;
let afterExecute: ((runId: string, callId: string) => Promise<void>) | undefined;

function pipeline(): ToolPipeline {
  const deps: ToolPipelineDeps = {
    db,
    eventLog,
    registry: {
      forAgent: async () => ({ tools: resolved, unavailable }),
      findConnector: (kind: string) => (kind === "test" ? testConnector : undefined),
      handler: (source) =>
        source.kind === "plugin" ? handlers[`${source.plugin}__${source.name}`] : undefined,
    },
    credentials: {
      async injection(_orgId: string, appId: string, auth: AppAuth) {
        if (auth.type === "none") return { headers: {} };
        throw new CredentialMissing(appId, auth.ownership);
      },
      async onUnauthorized() {},
    },
    breaker,
    outputs,
    approvals: new ApprovalsService({ db, eventLog, config, log: silent }),
    questions: new QuestionsService({ db, eventLog, config, log: silent }),
    config,
    log: silent,
    ...(decidePolicy !== undefined && { decidePolicy }),
    hooks: { ...(afterExecute !== undefined && { afterExecute }) },
  };
  return new ToolPipeline(deps);
}

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
  outputs = new ToolOutputs(db, config);
  breaker = new Breaker(redis, config);
}, 120_000);

afterAll(async () => {
  await sub?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let seed: Awaited<ReturnType<typeof seedConversation>>;
let runId: string;
let appId: string;

beforeEach(async () => {
  toolsCfg = {};
  decidePolicy = undefined;
  afterExecute = undefined;
  unavailable = [];
  handlerCalls = {};
  Object.assign(conn, { opened: 0, closed: 0, calls: 0, signals: [] });
  connCall = async (name) => ({ content: [{ type: "text", text: `called ${name}` }] });
  await redis.flushdb();
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  seed = await seedConversation(raw);
  runId = randomUUID();
  appId = await seedApp(raw, seed.orgId, seed.accountId, { slug: "docs", name: "Docs" });
  handlers = {
    probe__echo: async (input) => {
      record("echo", input);
      return { content: [{ type: "text", text: `echo ${JSON.stringify(input)}` }] };
    },
    probe__slow: async (input) => {
      record("slow", input);
      return new Promise<ToolResult>(() => {}); // 不响应 signal 的处理函数
    },
    probe__gated: async (input) => {
      record("gated", input);
      return { content: [{ type: "text", text: "gated ran" }] };
    },
    probe__banned: async (input) => {
      record("banned", input);
      return { content: [{ type: "text", text: "banned ran" }] };
    },
    probe__form: async (input) => {
      record("form", input);
      return {
        kind: "input_required",
        form: { title: "t", fields: [{ key: "a", label: "A", schema: { type: "string" } }] },
      };
    },
    probe__big: async (input) => {
      record("big", input);
      return { content: [{ type: "text", text: "x".repeat(300) }] };
    },
    probe__ctx: async (_input, ctx: ToolCallContext) => {
      record("ctx", { ...ctx, signal: undefined });
      return { content: [{ type: "text", text: "ok" }] };
    },
    probe__throws: async () => {
      throw new Error("internal detail with token abc");
    },
  };
  resolved = [
    pluginTool("echo", "allow", ECHO_SCHEMA),
    pluginTool("slow"),
    pluginTool("gated", "ask"),
    pluginTool("banned", "deny"),
    pluginTool("form"),
    pluginTool("big"),
    pluginTool("ctx"),
    pluginTool("throws"),
    appTool("docs", appId, "read"),
  ];
  await seedAppTool(appId, "read");
});

const stepCtx = (over: Partial<ToolStepContext> = {}): ToolStepContext => ({
  orgId: seed.orgId,
  conversationId: seed.conversationId,
  runId,
  step: 1,
  agentId: seed.agentId,
  agent,
  accountId: seed.accountId,
  signal: new AbortController().signal,
  ...over,
});

type Call = { id: string; name: string; input: unknown };

/** 写一条本步的 assistant_message（带与 model-call 相同的幂等键），内容是这些工具调用。 */
async function assistant(calls: Call[], step = 1): Promise<void> {
  const content: ContentBlock[] = calls.map((c) => ({ type: "tool_call", ...c }));
  await eventLog.append(seed.conversationId, [
    {
      type: "assistant_message",
      runId,
      idemKey: assistantIdemKey(runId, step),
      payload: { step, content, stopReason: "tool_use" },
    },
  ]);
}

/** 审批 / 输入请求引用 runs 行：为当前 runId 插一条 running 运行。 */
async function insertRun(): Promise<void> {
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: seed.conversationId,
      status: "running",
      agent_version: 1,
      trigger_account_id: seed.accountId,
      trigger_seq: 0,
    })
    .execute();
}

async function runCalls(calls: Call[], over: Partial<ToolStepContext> = {}) {
  await assistant(calls);
  await pipeline().runStep(stepCtx(over));
  return eventsOf(db, seed.conversationId);
}

const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));
const startedOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_call_started" ? [e.payload] : []));

describe("validateInput", () => {
  it("合法 → null；不合法 → 含全部错误路径与完整 inputSchema 的英文说明", () => {
    const spec = pluginSpec("echo", {
      type: "object",
      properties: {
        text: { type: "string" },
        n: { type: "integer", minimum: 1 },
        mode: { enum: ["a", "b"] },
      },
      required: ["text"],
      additionalProperties: false,
    });
    expect(validateInput("probe__echo", spec, { text: "hi" })).toBeNull();
    const msg = validateInput("probe__echo", spec, { n: 0, mode: "c", extra: 1 }) as string;
    expect(msg.startsWith("Invalid arguments for probe__echo: ")).toBe(true);
    expect(msg).toContain("must have required property 'text'");
    expect(msg).toContain("/n must be >= 1");
    expect(msg).toContain('/mode must be equal to one of the allowed values ["a","b"]');
    expect(msg).toContain("must NOT have additional properties (extra)");
    expect(msg).toContain(`\nInput schema: ${JSON.stringify(spec.inputSchema)}`);
  });

  it("声明 draft-07 $schema 的定义照常校验（ajv 2020，strict: false）", () => {
    const spec = pluginSpec("x", {
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { a: { type: "string" } },
      unknownKeyword: true,
    });
    expect(validateInput("x", spec, { a: "s" })).toBeNull();
    expect(validateInput("x", spec, { a: 1 })).toContain("/a must be string");
  });

  describe("应用工具（连接器来源，不受信任）的 schema", () => {
    const warns = () => {
      const lines: { msg: string; meta: unknown }[] = [];
      return {
        lines,
        log: {
          warn: (msg: string, meta?: unknown) => {
            lines.push({ msg, meta });
          },
        },
      };
    };

    it("编译前去掉 pattern / format（防灾难性回溯与未知格式），同名属性不受影响", () => {
      const spec = pluginSpec("x", {
        type: "object",
        properties: {
          q: { type: "string", pattern: "^(a+)+$" },
          mail: { type: "string", format: "email" },
          pattern: { type: "string" },
        },
        required: ["pattern"],
      });
      const w = warns();
      const opts = { untrusted: true, log: w.log };
      expect(
        validateInput("app__x", spec, { pattern: "p", q: "b", mail: "nope" }, opts),
      ).toBeNull();
      expect(validateInput("app__x", spec, { q: "b" }, opts)).toContain(
        "must have required property 'pattern'",
      );
      // 受信任（插件 / 内置）的 schema 照常校验 pattern
      expect(validateInput("p__x", spec, { pattern: "p", q: "b" })).toContain(
        "/q must match pattern",
      );
    });

    it("patternProperties 按 additionalProperties 语义放宽：额外属性须符合其中某个 schema", () => {
      const spec = pluginSpec("x", {
        type: "object",
        patternProperties: { "^x_": { type: "string" } },
        additionalProperties: false,
      });
      const opts = { untrusted: true };
      expect(validateInput("app__x", spec, { x_a: "s" }, opts)).toBeNull();
      expect(validateInput("app__x", spec, { x_a: 1 }, opts)).toContain("/x_a must be string");
    });

    it("schema 超过 64 KB 或嵌套超过 32 层 → 跳过校验并记一次 warn（只含 toolKey 与原因）", () => {
      const big = pluginSpec("big", {
        type: "object",
        description: "d".repeat(70_000),
        properties: { a: { type: "string" } },
      });
      let deep: Record<string, unknown> = { type: "string" };
      for (let i = 0; i < 40; i++) deep = { type: "object", properties: { n: deep } };
      const deepSpec = pluginSpec("deep", deep);
      const w = warns();
      const opts = { untrusted: true, log: w.log };
      expect(validateInput("app__big", big, { a: 1 }, opts)).toBeNull();
      expect(validateInput("app__big", big, { a: 2 }, opts)).toBeNull();
      expect(validateInput("app__deep", deepSpec, { n: 1 }, opts)).toBeNull();
      expect(w.lines).toEqual([
        {
          msg: "tool input schema not validated",
          meta: { toolKey: "app__big", reason: "schema larger than 65536 bytes" },
        },
        {
          msg: "tool input schema not validated",
          meta: { toolKey: "app__deep", reason: "schema nested deeper than 32 levels" },
        },
      ]);
    });

    it("schema 无法编译 → 不拦截，按缓存键只 warn 一次", () => {
      const spec = pluginSpec("bad", { type: "object", properties: { a: { $ref: "#/nope" } } });
      const w = warns();
      expect(validateInput("p__bad", spec, { a: 1 }, { log: w.log })).toBeNull();
      expect(validateInput("p__bad", spec, { a: 1 }, { log: w.log })).toBeNull();
      expect(w.lines).toHaveLength(1);
      expect(w.lines[0]?.msg).toBe("tool input schema failed to compile; validation skipped");
      expect(w.lines[0]?.meta).toMatchObject({ toolKey: "p__bad" });
    });

    it("不同工具的 schema 用同一个 $id 不互相影响", () => {
      const a = pluginSpec("a", {
        $id: "https://example.com/same.json",
        type: "object",
        required: ["a"],
      });
      const b = pluginSpec("b", {
        $id: "https://example.com/same.json",
        type: "object",
        required: ["b"],
      });
      expect(validateInput("p__a", a, {})).toContain("must have required property 'a'");
      expect(validateInput("p__b", b, {})).toContain("must have required property 'b'");
    });
  });
});

describe("ToolPipeline.runStep", () => {
  it("合法调用：先写 tool_call_started 再执行，写 tool_result 与审计（不含参数值）", async () => {
    const evs = await runCalls([{ id: "c1", name: "probe__echo", input: { text: "secret-arg" } }]);
    const echo = resolved[0] as ResolvedTool;
    expect(startedOf(evs)).toEqual([
      { step: 1, callId: "c1", toolKey: "probe__echo", specHash: echo.specHash },
    ]);
    expect(resultsOf(evs)).toEqual([
      {
        step: 1,
        callId: "c1",
        toolKey: "probe__echo",
        content: 'echo {"text":"secret-arg"}',
        isError: false,
        contentTypes: ["text"],
      },
    ]);
    const types = evs.map((e) => e.type);
    expect(types.indexOf("tool_call_started")).toBeLessThan(types.indexOf("tool_result"));
    const audits = await db.selectFrom("audit_events").selectAll().execute();
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "tool.called",
      org_id: seed.orgId,
      actor_account_id: seed.accountId,
    });
    const detail = audits[0]?.detail as Record<string, unknown>;
    expect(Object.keys(detail).sort()).toEqual(["durationMs", "isError", "toolKey"]);
    expect(detail).toMatchObject({ toolKey: "probe__echo", isError: false });
    expect(JSON.stringify(audits)).not.toContain("secret-arg");
  });

  it("处理函数拿到 orgId / accountId（对话发起人）/ agentId / conversationId / callId", async () => {
    await runCalls([{ id: "c1", name: "probe__ctx", input: {} }]);
    expect(handlerCalls.ctx?.[0]).toMatchObject({
      orgId: seed.orgId,
      accountId: seed.accountId,
      agentId: seed.agentId,
      conversationId: seed.conversationId,
      callId: "c1",
    });
  });

  it("参数校验失败：不执行、不写 tool_call_started，结果含路径与 schema", async () => {
    const evs = await runCalls([{ id: "c1", name: "probe__echo", input: { text: 1 } }]);
    expect(handlerCalls.echo).toBeUndefined();
    expect(startedOf(evs)).toEqual([]);
    const [r] = resultsOf(evs);
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain("Invalid arguments for probe__echo: /text must be string");
    expect(r?.content).toContain(`Input schema: ${JSON.stringify(ECHO_SCHEMA)}`);
  });

  it("未知工具：列出可用工具；启用 tool_search 时提示用它加载", async () => {
    resolved = [pluginTool("echo", "allow", ECHO_SCHEMA), pluginTool("big")];
    let evs = await runCalls([{ id: "c1", name: "nope", input: {} }]);
    expect(resultsOf(evs)[0]).toMatchObject({
      toolKey: "nope",
      isError: true,
      content: 'Unknown tool "nope". Available tools: probe__big, probe__echo.',
    });
    resolved = [...resolved, { ...pluginTool("x"), key: "tool_search" }];
    runId = randomUUID();
    evs = await runCalls([{ id: "c2", name: "nope", input: {} }]);
    expect(resultsOf(evs)[1]?.content).toBe(
      'Unknown tool "nope". Available tools: probe__big, probe__echo, tool_search. Use tool_search to load other tools.',
    );
  });

  it("本步不可用的工具：说明原因而不是「未知」", async () => {
    unavailable = [{ ref: "docs__write", reason: "Tool is disabled" }];
    const evs = await runCalls([{ id: "c1", name: "docs__write", input: {} }]);
    expect(resultsOf(evs)[0]?.content).toBe('Tool "docs__write" is unavailable: Tool is disabled.');
  });

  it("$output 引用在校验前替换为存档全文；引用不存在 → 错误结果、不执行", async () => {
    const out = await outputs.save({
      orgId: seed.orgId,
      conversationId: seed.conversationId,
      callId: "old",
      content: "FULL",
    });
    let evs = await runCalls([
      { id: "c1", name: "probe__echo", input: { text: { $output: out.id } } },
    ]);
    expect(handlerCalls.echo).toEqual([{ text: "FULL" }]);
    expect(resultsOf(evs)[0]?.isError).toBe(false);
    runId = randomUUID();
    evs = await runCalls([{ id: "c2", name: "probe__echo", input: { text: { $output: "gone" } } }]);
    expect(handlerCalls.echo).toHaveLength(1);
    expect(resultsOf(evs)[1]?.content).toMatch(/^Output gone not found or expired/);
    // 同组织别的会话的存档不能引用
    const sibling = `sib-${seed.conversationId}`;
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${sibling}, ${seed.orgId}, ${seed.agentId}, ${seed.accountId})`.execute(raw);
    const foreign = await outputs.save({
      orgId: seed.orgId,
      conversationId: sibling,
      callId: "x",
      content: "OTHER CONVERSATION",
    });
    runId = randomUUID();
    evs = await runCalls([
      { id: "c3", name: "probe__echo", input: { text: { $output: foreign.id } } },
    ]);
    expect(handlerCalls.echo).toHaveLength(1);
    expect(resultsOf(evs)[2]?.content).toMatch(/not found or expired/);
  });

  it("策略：deny → 拒绝说明；ask → 建审批并暂停（之后的调用留到续跑）；decidePolicy 可注入", async () => {
    await insertRun();
    await assistant([
      { id: "c1", name: "probe__banned", input: {} },
      { id: "c2", name: "probe__gated", input: { a: 1 } },
      { id: "c3", name: "probe__echo", input: { text: "later" } },
    ]);
    const out = await pipeline().runStep(stepCtx());
    let evs = await eventsOf(db, seed.conversationId);
    expect(handlerCalls).toEqual({});
    expect(startedOf(evs)).toEqual([]);
    const [deny, ...rest] = resultsOf(evs);
    expect(rest).toEqual([]);
    expect(deny).toMatchObject({
      isError: true,
      content: "Tool probe__banned is denied by policy.",
    });
    const requested = evs.find((e) => e.type === "approval_requested");
    expect(requested?.payload).toMatchObject({ step: 1, callId: "c2", toolKey: "probe__gated" });
    const approvalId = (requested?.payload as { approvalId: string } | undefined)?.approvalId;
    expect(out).toEqual({
      kind: "suspended",
      waitingFor: { kind: "approval", id: approvalId, expiresAt: expect.any(String) },
    });
    const row = await db
      .selectFrom("approvals")
      .selectAll()
      .where("id", "=", approvalId ?? "")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ run_id: runId, call_id: "c2", status: "pending" });
    // 仍 pending 时再进入：继续等，不重复建审批
    expect(await pipeline().runStep(stepCtx())).toEqual(out);
    // 拒绝 → 拒绝说明，之后的调用照常执行
    await sql`UPDATE capybara.approvals SET status = 'denied' WHERE id = ${approvalId}`.execute(
      raw,
    );
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    evs = await eventsOf(db, seed.conversationId);
    expect(resultsOf(evs).map((r) => [r.callId, r.content])).toEqual([
      ["c1", "Tool probe__banned is denied by policy."],
      ["c2", "The user denied this tool call."],
      ["c3", 'echo {"text":"later"}'],
    ]);
    expect(handlerCalls.gated).toBeUndefined();

    const seen: string[] = [];
    decidePolicy = async (tool, def, ctx) => {
      seen.push(`${tool.key}|${def.name}|${ctx.accountId}|${ctx.runId}`);
      return "allow";
    };
    runId = randomUUID();
    evs = await runCalls([{ id: "c3", name: "probe__gated", input: {} }]);
    expect(seen).toEqual([`probe__gated|Helper|${seed.accountId}|${runId}`]);
    expect(handlerCalls.gated).toHaveLength(1);

    // 默认判定为执行时实时读取（createDecidePolicy）：管理员把应用工具改为 deny 立即生效
    decidePolicy = undefined;
    await sql`UPDATE capybara.app_tools SET default_policy = 'deny' WHERE app_id = ${appId}`.execute(
      raw,
    );
    runId = randomUUID();
    evs = await runCalls([{ id: "c4", name: "docs__read", input: {} }]);
    expect(conn.calls).toBe(0);
    expect(resultsOf(evs).find((r) => r.callId === "c4")).toMatchObject({
      isError: true,
      content: "Tool docs__read is denied by policy.",
    });
  });

  it("批准后等待期间工具定义变了：不执行，按新定义重新审批（attempt 2）并继续等待；再批准后执行", async () => {
    await insertRun();
    await assistant([{ id: "c1", name: "probe__gated", input: {} }]);
    const first = await pipeline().runStep(stepCtx());
    expect(first.kind).toBe("suspended");
    const id1 = first.kind === "suspended" ? first.waitingFor.id : "";
    await sql`UPDATE capybara.approvals SET status = 'approved' WHERE id = ${id1}`.execute(raw);
    // 定义变化：描述不同 → specHash 不同
    const changed = pluginTool("gated", "ask", {
      type: "object",
      properties: { x: { type: "string" } },
    });
    resolved = resolved.map((t) => (t.key === "probe__gated" ? changed : t));
    const second = await pipeline().runStep(stepCtx());
    expect(handlerCalls.gated).toBeUndefined();
    expect(second.kind).toBe("suspended");
    const id2 = second.kind === "suspended" ? second.waitingFor.id : "";
    expect(id2).not.toBe(id1);
    const row = await db
      .selectFrom("approvals")
      .select(["attempt", "spec_hash", "status"])
      .where("id", "=", id2)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ attempt: 2, spec_hash: changed.specHash, status: "pending" });
    const evs = await eventsOf(db, seed.conversationId);
    expect(evs.filter((e) => e.type === "approval_requested")).toHaveLength(2);
    expect(startedOf(evs)).toEqual([]);
    await sql`UPDATE capybara.approvals SET status = 'approved' WHERE id = ${id2}`.execute(raw);
    expect(await pipeline().runStep(stepCtx())).toEqual({ kind: "done" });
    expect(handlerCalls.gated).toHaveLength(1);
  });

  it("审批超时说明的小时数按该审批的等待时长（创建到到期）计算，不读当前配置", async () => {
    await insertRun();
    await assistant([{ id: "c1", name: "probe__gated", input: {} }]);
    const first = await pipeline().runStep(stepCtx());
    const id = first.kind === "suspended" ? first.waitingFor.id : "";
    await sql`UPDATE capybara.approvals SET status = 'expired',
      created_at = now() - interval '6 hours', expires_at = now() - interval '20 minutes'
      WHERE id = ${id}`.execute(raw);
    toolsCfg = { approvalTimeoutHours: 48 };
    await pipeline().runStep(stepCtx());
    const evs = await eventsOf(db, seed.conversationId);
    expect(resultsOf(evs)[0]?.content).toBe("Approval timed out after 6h; treated as denied.");
  });

  it("处理函数返回 input_required → 建输入请求（写 question_asked）并暂停；已写 tool_call_started、无结果", async () => {
    await insertRun();
    await assistant([{ id: "c1", name: "probe__form", input: {} }]);
    const out = await pipeline().runStep(stepCtx());
    const evs = await eventsOf(db, seed.conversationId);
    expect(resultsOf(evs)).toEqual([]);
    expect(startedOf(evs)).toHaveLength(1);
    const asked = evs.find((e) => e.type === "question_asked");
    expect(asked?.payload).toMatchObject({ step: 1, callId: "c1", form: { title: "t" } });
    expect(out).toMatchObject({
      kind: "suspended",
      waitingFor: {
        kind: "input",
        id: (asked?.payload as { questionId: string } | undefined)?.questionId,
      },
    });
    // 仍 pending：继续等，处理函数不再被调用
    expect(await pipeline().runStep(stepCtx())).toEqual(out);
    expect(handlerCalls.form).toHaveLength(1);
  });

  it("处理函数抛出非 ToolError：只给模型错误类名，不回显内部消息", async () => {
    const evs = await runCalls([{ id: "c1", name: "probe__throws", input: {} }]);
    const r = resultsOf(evs)[0];
    expect(r?.isError).toBe(true);
    expect(r?.content).toContain("Tool probe__throws failed (Error)");
    expect(r?.content).not.toContain("abc");
  });

  it("超时：不响应 signal 的插件工具也按 tools.timeoutMs 结束，给可执行的错误", async () => {
    toolsCfg = { timeoutMs: 150 };
    const t0 = Date.now();
    const evs = await runCalls([{ id: "c1", name: "probe__slow", input: {} }]);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(resultsOf(evs)[0]).toMatchObject({
      isError: true,
      content:
        "Tool probe__slow timed out after 0.15s. The operation may or may not have completed; verify before retrying.",
    });
  });

  it("应用工具超时：经 AbortSignal 中止连接器调用，会话照样关闭", async () => {
    toolsCfg = { timeoutMs: 150 };
    connCall = (_name, _input, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by signal")));
      });
    const evs = await runCalls([{ id: "c1", name: "docs__read", input: {} }]);
    expect(resultsOf(evs)[0]?.content).toMatch(/^Tool docs__read timed out after 0.15s/);
    expect(conn.signals[0]?.aborted).toBe(true);
    expect(conn).toMatchObject({ opened: 1, closed: 1 });
  });

  it("应用工具正常调用：每次调用打开并关闭会话", async () => {
    const evs = await runCalls([
      { id: "c1", name: "docs__read", input: {} },
      { id: "c2", name: "docs__read", input: {} },
    ]);
    expect(resultsOf(evs).map((r) => r.content)).toEqual(["called read", "called read"]);
    expect(conn).toMatchObject({ opened: 2, closed: 2, calls: 2 });
  });

  it("熔断：同一应用连续失败 5 次后打开，第 6 次不再调用连接器并告知多久后重试", async () => {
    connCall = async () => {
      throw new Error("upstream down");
    };
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "docs__read",
      input: {},
    }));
    const evs = await runCalls(calls);
    expect(conn.calls).toBe(5);
    const rs = resultsOf(evs);
    expect(
      rs.slice(0, 5).every((r) => r.isError && r.content.startsWith("Tool docs__read failed")),
    ).toBe(true);
    expect(rs[5]).toMatchObject({
      isError: true,
      content: "Tool temporarily unavailable: Docs failed 5 times in a row; retry after 60s.",
    });
  });

  it("熔断只计远端不可用：5 次 ToolError（JSON-RPC 错误、鉴权失败等）不打开，第 6 次照常调用", async () => {
    connCall = async () => {
      throw new ToolError("The app returned an error: bad arguments.");
    };
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "docs__read",
      input: {},
    }));
    const evs = await runCalls(calls);
    expect(conn.calls).toBe(6);
    expect(
      resultsOf(evs).every((r) => r.content === "The app returned an error: bad arguments."),
    ).toBe(true);
    expect((await breaker.check(seed.orgId, appId)).open).toBe(false);
  });

  it("熔断：5 次 ToolError(kind unavailable)（HTTP 5xx 等）→ 打开", async () => {
    connCall = async () => {
      throw new ToolError("The app's server responded with HTTP 502.", { kind: "unavailable" });
    };
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "docs__read",
      input: {},
    }));
    const evs = await runCalls(calls);
    expect(conn.calls).toBe(5);
    expect(resultsOf(evs)[5]?.content).toMatch(
      /^Tool temporarily unavailable: Docs failed 5 times/,
    );
  });

  it("熔断：5 次超时 → 打开", async () => {
    toolsCfg = { timeoutMs: 50 };
    connCall = () => new Promise<ToolResult>(() => {});
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "docs__read",
      input: {},
    }));
    const evs = await runCalls(calls);
    expect(conn.calls).toBe(5);
    expect(resultsOf(evs)[5]?.content).toMatch(
      /^Tool temporarily unavailable: Docs failed 5 times/,
    );
  });

  it("工具自己报告的 isError 结果不计入熔断", async () => {
    connCall = async () => ({ content: [{ type: "text", text: "bad input" }], isError: true });
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      name: "docs__read",
      input: {},
    }));
    const evs = await runCalls(calls);
    expect(conn.calls).toBe(6);
    expect(resultsOf(evs).every((r) => r.isError && r.content === "bad input")).toBe(true);
  });

  it("个人凭据缺失：写 connection_required 与可执行的错误结果；不计入熔断", async () => {
    const priv = await seedApp(raw, seed.orgId, seed.accountId, {
      slug: "priv",
      name: "Private Docs",
      auth: { type: "bearer", ownership: "personal" },
    });
    await seedAppTool(priv, "read");
    resolved = [appTool("priv", priv, "read")];
    const evs = await runCalls([{ id: "c1", name: "priv__read", input: {} }]);
    const cr = evs.filter((e) => e.type === "connection_required");
    expect(cr.map((e) => e.payload)).toEqual([
      { step: 1, callId: "c1", appId: priv, appName: "Private Docs" },
    ]);
    expect(resultsOf(evs)[0]).toMatchObject({
      isError: true,
      content:
        "The user has not connected Private Docs. A connect card was shown; ask the user to connect it, then retry.",
    });
    expect((await breaker.check(seed.orgId, priv)).open).toBe(false);
    expect(await redis.exists(`capk:breaker:${seed.orgId}:${priv}`)).toBe(0);
  });

  it("组织凭据缺失：不写 connection_required，提示找组织管理员", async () => {
    const orgApp = await seedApp(raw, seed.orgId, seed.accountId, {
      slug: "orgc",
      name: "Org Docs",
      auth: { type: "bearer", ownership: "org" },
    });
    await seedAppTool(orgApp, "read");
    resolved = [appTool("orgc", orgApp, "read")];
    const evs = await runCalls([{ id: "c1", name: "orgc__read", input: {} }]);
    expect(evs.some((e) => e.type === "connection_required")).toBe(false);
    expect(resultsOf(evs)[0]?.content).toBe(
      "Org Docs has no organization credential configured; ask an organization admin to set it up.",
    );
  });

  it("超大结果转存：tool_result 只含预览与存档 id", async () => {
    toolsCfg = { outputSpillChars: 100, outputPreviewChars: 10 };
    const evs = await runCalls([{ id: "c1", name: "probe__big", input: {} }]);
    const r = resultsOf(evs)[0];
    expect(r?.outputId).toBeDefined();
    expect(
      r?.content.startsWith(`${"x".repeat(10)}\n…\n[Output truncated: 300 chars, 1 lines.`),
    ).toBe(true);
    expect(
      await outputs.load(
        { orgId: seed.orgId, conversationId: seed.conversationId },
        r?.outputId as string,
      ),
    ).toBe("x".repeat(300));
    const row = await db
      .selectFrom("tool_outputs")
      .selectAll()
      .where("id", "=", r?.outputId as string)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      conversation_id: seed.conversationId,
      call_id: "c1",
      size_chars: 300,
    });
  });

  it("一步多个调用按顺序处理；已有结果的跳过，有开始无结果的记为结果未知且不执行", async () => {
    await assistant([
      { id: "c1", name: "probe__echo", input: { text: "1" } },
      { id: "c2", name: "probe__echo", input: { text: "2" } },
      { id: "c3", name: "probe__echo", input: { text: "3" } },
    ]);
    // c1 已完成、c2 已开始（进程在执行中崩溃）
    await eventLog.append(seed.conversationId, [
      {
        type: "tool_call_started",
        runId,
        idemKey: `tool_started:${runId}:c1`,
        payload: { step: 1, callId: "c1", toolKey: "probe__echo", specHash: "h" },
      },
      {
        type: "tool_result",
        runId,
        idemKey: `tool_result:${runId}:c1`,
        payload: { step: 1, callId: "c1", toolKey: "probe__echo", content: "done", isError: false },
      },
      {
        type: "tool_call_started",
        runId,
        idemKey: `tool_started:${runId}:c2`,
        payload: { step: 1, callId: "c2", toolKey: "probe__echo", specHash: "h" },
      },
    ]);
    await pipeline().runStep(stepCtx());
    // 再跑一次：全部已有结果，不再写任何事件
    await pipeline().runStep(stepCtx());
    const evs = await eventsOf(db, seed.conversationId);
    expect(handlerCalls.echo).toEqual([{ text: "3" }]);
    expect(resultsOf(evs).map((r) => [r.callId, r.content, r.isError])).toEqual([
      ["c1", "done", false],
      ["c2", UNKNOWN_RESULT_TEXT, true],
      ["c3", 'echo {"text":"3"}', false],
    ]);
    expect(startedOf(evs).map((s) => s.callId)).toEqual(["c1", "c2", "c3"]);
    // 结果未知的调用也审计（确实开始执行过）：isError true、durationMs null
    const audits = await db
      .selectFrom("audit_events")
      .select("detail")
      .where("action", "=", "tool.called")
      .orderBy("id")
      .execute();
    expect(audits.map((a) => a.detail)).toEqual([
      { toolKey: "probe__echo", isError: true, durationMs: null },
      { toolKey: "probe__echo", isError: false, durationMs: expect.any(Number) },
    ]);
  });

  it("run 已中止：剩余调用不执行，写明 run 已停止", async () => {
    const ac = new AbortController();
    ac.abort();
    const evs = await runCalls(
      [
        { id: "c1", name: "probe__echo", input: { text: "1" } },
        { id: "c2", name: "docs__read", input: {} },
      ],
      { signal: ac.signal },
    );
    expect(handlerCalls).toEqual({});
    expect(conn.opened).toBe(0);
    expect(resultsOf(evs).map((r) => [r.content, r.isError])).toEqual([
      [RUN_STOPPED_TEXT, true],
      [RUN_STOPPED_TEXT, true],
    ]);
  });

  it("执行中 run 被中止：进行中的调用以停止说明结束", async () => {
    const ac = new AbortController();
    connCall = (_n, _i, signal) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
        setTimeout(() => ac.abort(), 50);
      });
    const evs = await runCalls([{ id: "c1", name: "docs__read", input: {} }], {
      signal: ac.signal,
    });
    expect(resultsOf(evs)[0]).toMatchObject({ isError: true, content: RUN_STOPPED_DURING_TEXT });
    expect(conn.closed).toBe(1);
    // 用户中止不计入熔断
    expect(await redis.exists(`capk:breaker:${seed.orgId}:${appId}`)).toBe(0);
  });

  it("afterExecute 钩子抛错（模拟执行后崩溃）→ 续跑得到结果未知，工具只被调用一次", async () => {
    let crash = true;
    afterExecute = async () => {
      if (crash) {
        crash = false;
        throw new Error("simulated crash");
      }
    };
    await assistant([{ id: "c1", name: "probe__echo", input: { text: "1" } }]);
    await expect(pipeline().runStep(stepCtx())).rejects.toThrow("simulated crash");
    await pipeline().runStep(stepCtx());
    const evs = await eventsOf(db, seed.conversationId);
    expect(handlerCalls.echo).toHaveLength(1);
    expect(resultsOf(evs).map((r) => r.content)).toEqual([UNKNOWN_RESULT_TEXT]);
  });
});
