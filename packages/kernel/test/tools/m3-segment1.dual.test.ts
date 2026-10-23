import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeMcpServer,
  type Harness,
  replicaOf,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { UNKNOWN_RESULT_TEXT } from "../../src/runtime/context/pairing.js";
import { runJobId } from "../../src/runtime/run-queue.js";
import { MAINTENANCE_QUEUE_NAME, waitTimeoutJobId } from "../../src/runtime/waits.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, gate, PW, waitFor, waitForEvent, waitForTerminal } from "../helpers/runs.js";

/**
 * M3 第一段验收（双副本）：两个独立进程的内核副本（角色都含 api / worker）共享 PG / Redis，加载
 * model-fake、connector-mcp（允许本机 http）与 todo。
 *
 * 1. todo 插件工具（Ruling A5）：插件未在组织启用 → 运行写不可用提醒，调用得到「不可用」错误；启用后
 *    `todo__write` 按默认 allow 直接执行，结果是清单渲染。
 * 2. 安装 MCP 连接器（bearer，组织凭据）→ 只读工具直接执行（结果里回显的凭据被打码）→ destructive 工具
 *    请求审批、运行 waiting → 在另一个副本批准（再拒绝 → 409）→ 续跑完成，工具只调用一次。
 * 3. 审批超时（改 `expires_at` 并提前执行超时任务）→ 按拒绝写结果，工具不被调用。
 * 4. 工具执行中 SIGKILL 执行它的 worker 副本 → 存活副本续跑，该调用「结果未知」，工具只被调用一次。
 */

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);
const TODO = fileURLToPath(new URL("../../../../plugins/todo/src/index.ts", import.meta.url));

const TOKEN = "mcp-org-token-5c81d2e7a94b";
const TODOS = {
  todos: [
    { content: "Plan", status: "completed", activeForm: "Planning" },
    { content: "Build", status: "in_progress", activeForm: "Building" },
    { content: "Ship", status: "pending", activeForm: "Shipping" },
  ],
};

let pgc: TestContainer;
let rdc: TestContainer;
let mcp: FakeMcpServer;
const hang = gate();
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  mcp = await startFakeMcpServer({
    requireBearer: TOKEN,
    tools: [
      {
        name: "search",
        description: "Search the docs",
        inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        annotations: { readOnlyHint: true },
        handler: ({ args, headers }) => ({
          content: [{ type: "text", text: `results for ${args.q}; auth=${headers.authorization}` }],
        }),
      },
      {
        name: "delete_doc",
        description: "Delete a document",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: { destructiveHint: true },
        handler: ({ args }) => ({ content: [{ type: "text", text: `deleted ${args.id}` }] }),
      },
      {
        name: "export",
        description: "Export everything (slow)",
        annotations: { readOnlyHint: true },
        // 一直挂起，直到测试结束放行：执行它的 worker 在调用途中被杀
        handler: async () => {
          await hang.promise;
          return { content: [{ type: "text", text: "exported" }] };
        },
      },
    ],
  });
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  hang.open();
  await mcp?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

type Json = Record<string, unknown>;
type Res = { status: number; json: Json; replica: number };

describe("M3 第一段双副本验收", () => {
  it("todo 启用前后、MCP 只读 / 审批 / 跨副本批准 / 审批超时 / 杀 worker 后结果未知", async () => {
    const redis = new Redis(rdc.url);
    cleanups.push(() => redis.disconnect());
    await redis.flushdb();
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, CONNECTOR_MCP, TODO],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      pluginConfig: { "connector-mcp": { allowInsecureLoopback: true } },
      config: {
        auth: { cookieSecure: false },
        // 短锁期与 stalled 检测间隔：被杀副本持有的运行任务约 1.5 秒后由存活副本接手
        runtime: { jobLockMs: 1000, stalledIntervalMs: 500 },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);
    const maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rdc.url) });
    cleanups.push(() => maint.close());

    let cookie = "";
    const init = (method: string, body?: unknown): RequestInit => ({
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const parse = async (res: Response): Promise<Json> => {
      const text = await res.text();
      return text === "" ? {} : (JSON.parse(text) as Json);
    };
    /** 经 harness 严格交替的入口。 */
    const alt = async (method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await harness.request(path, init(method, body));
      return { status: res.status, json: await parse(res), replica: res.replica };
    };
    /** 指定副本。 */
    const at = async (i: 0 | 1, method: string, path: string, body?: unknown): Promise<Res> => {
      const res = await fetch(`http://127.0.0.1:${harness.replicas[i].port}${path}`, {
        ...init(method, body),
      });
      const replica = replicaOf(res);
      expect(replica).toBe(i);
      return { status: res.status, json: await parse(res), replica: i };
    };

    // ---- 组织与管理员 ----
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    const login = await harness.request(
      "/api/v1/auth/login",
      init("POST", { login: "owner", password: PW }),
    );
    expect(login.status).toBe(200);
    cookie = login.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    await login.body?.cancel();
    const org = await alt("POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;

    // ---- 安装 MCP 连接器（bearer，组织凭据）----
    const app = await alt("POST", `${base}/connectors`, {
      name: "Docs",
      slug: "docs",
      connector: "mcp",
      endpoint: { url: mcp.url },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: TOKEN },
    });
    expect(app.status, JSON.stringify(app.json)).toBe(201);
    const appJson = app.json.connector as {
      id: string;
      tools: { name: string; defaultPolicy: string }[];
    };
    const policies = Object.fromEntries(appJson.tools.map((t) => [t.name, t.defaultPolicy]));
    expect(policies).toMatchObject({ search: "allow", delete_doc: "ask", export: "allow" });

    // ---- agent：连接器全部工具 + todo 插件工具 ----
    const ag = await alt("POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "connector", connectorId: appJson.id, tools: "all" },
          { kind: "plugin", plugin: "todo", name: "write" },
        ],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const newConv = async (): Promise<string> => {
      const c = await alt("POST", `${base}/conversations`, { agentId });
      expect(c.status).toBe(201);
      return (c.json.conversation as { id: string }).id;
    };
    const convId = await newConv();
    const conv = `${base}/conversations/${convId}`;
    let terminals = 0;
    /** 在指定副本发一条 `tool:` 指令。 */
    const send = async (i: 0 | 1, path: string, key: string, input: unknown) => {
      const r = await at(i, "POST", `${path}/messages`, {
        text: `tool:${key}:${JSON.stringify(input)}`,
      });
      expect(r.status, JSON.stringify(r.json)).toBe(202);
    };
    /** 等本会话下一个终态，返回最后一条 tool_result 与本 run 的全部事件。 */
    const finish = async () => {
      terminals++;
      const term = await waitForTerminal(db, convId, terminals, 30_000);
      const last = term[terminals - 1] as ConversationEvent;
      expect(last.type).toBe("run_finished");
      const evs = (await eventsOf(db, convId)).filter((e) => e.runId === last.runId);
      return { evs, result: ofType(evs, "tool_result").at(-1)?.payload };
    };

    // ---- 1. todo 未启用：不可用提醒 + 调用得到明确错误（Ruling A5）----
    await send(0, conv, "todo__write", TODOS);
    const t1 = await finish();
    expect(t1.result).toMatchObject({
      toolKey: "todo__write",
      isError: true,
      content:
        'Tool "todo__write" is unavailable: Plugin todo is not enabled in this organization.',
    });
    expect(ofType(t1.evs, "reminder").map((e) => e.payload.text)).toEqual([
      "The following tools are unavailable in this run: todo__write (Plugin todo is not enabled in this organization)",
    ]);
    expect(ofType(t1.evs, "tool_call_started")).toEqual([]);

    // 启用后：默认 allow，直接执行，结果是清单渲染
    const en = await alt("PUT", `${base}/plugins/todo`, { enabled: true });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    await send(1, conv, "todo__write", TODOS);
    const t2 = await finish();
    expect(t2.result).toMatchObject({
      toolKey: "todo__write",
      isError: false,
      content: "Todo list updated (3 items):\n[x] Plan\n[>] Building\n[ ] Ship",
    });
    expect(ofType(t2.evs, "approval_requested")).toEqual([]);
    expect(ofType(t2.evs, "reminder")).toEqual([]);
    const stored = await sql<{ items: unknown }>`
      SELECT items FROM plugin_todo.todos WHERE conversation_id = ${convId}`.execute(raw);
    expect(stored.rows.map((r) => r.items)).toEqual([TODOS.todos]);

    // ---- 2. 只读工具直接执行；回显的凭据被打码 ----
    await send(0, conv, "docs__search", { q: "cats" });
    const s = await finish();
    expect(s.result).toMatchObject({
      toolKey: "docs__search",
      isError: false,
      content: "results for cats; auth=[REDACTED]",
    });
    expect(ofType(s.evs, "approval_requested")).toEqual([]);
    expect(mcp.calls.find((c) => c.name === "search")?.headers.authorization).toBe(
      `Bearer ${TOKEN}`,
    );

    // ---- destructive 工具：审批 → 运行 waiting → 在另一个副本批准 → 续跑完成 ----
    await send(0, conv, "docs__delete_doc", { id: "d1" });
    const asked = (await waitForEvent(
      db,
      convId,
      (e) => e.type === "approval_requested",
      20_000,
      "approval_requested",
    )) as Extract<ConversationEvent, { type: "approval_requested" }>;
    const runD1 = asked.runId as string;
    await waitFor(
      async () =>
        (await db.selectFrom("runs").select("status").where("id", "=", runD1).executeTakeFirst())
          ?.status === "waiting",
      20_000,
      "run waiting for approval",
    );
    expect(mcp.calls.filter((c) => c.name === "delete_doc")).toHaveLength(0);
    const approvalId = asked.payload.approvalId;
    const ok = await at(1, "POST", `${base}/approvals/${approvalId}/decision`, {
      decision: "approve",
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    // 同一审批再在另一个副本拒绝：只生效一次
    const again = await at(0, "POST", `${base}/approvals/${approvalId}/decision`, {
      decision: "deny",
    });
    expect(again.status).toBe(409);
    expect((again.json.error as { code: string }).code).toBe("approval.already_decided");
    const d1 = await finish();
    expect(d1.evs[0]?.runId).toBe(runD1);
    expect(d1.result).toMatchObject({
      toolKey: "docs__delete_doc",
      isError: false,
      content: "deleted d1",
    });
    expect(ofType(d1.evs, "approval_decided").map((e) => e.payload.decision)).toEqual(["approved"]);
    expect(ofType(d1.evs, "run_started")).toHaveLength(1);
    // 续跑只发生一次：每一步一次模型调用
    expect(ofType(d1.evs, "model_call").map((e) => e.payload.step)).toEqual([1, 2]);
    expect(mcp.calls.filter((c) => c.name === "delete_doc").map((c) => c.args)).toEqual([
      { id: "d1" },
    ]);

    // ---- 3. 审批超时 → 按拒绝 ----
    await send(1, conv, "docs__delete_doc", { id: "d2" });
    const asked2 = (await waitForEvent(
      db,
      convId,
      (e) => e.type === "approval_requested" && e.runId !== runD1,
      20_000,
      "second approval_requested",
    )) as Extract<ConversationEvent, { type: "approval_requested" }>;
    const runD2 = asked2.runId as string;
    const approval2 = asked2.payload.approvalId;
    await waitFor(
      async () =>
        (await db.selectFrom("runs").select("status").where("id", "=", runD2).executeTakeFirst())
          ?.status === "waiting",
      20_000,
      "second run waiting",
    );
    const job = await waitFor(() => maint.getJob(waitTimeoutJobId(approval2)), 10_000, "job");
    // 到期时刻改到 1 秒后（PG 时钟），等它按 PG 时钟过期，再让延迟任务立即执行
    await sql`UPDATE capybara.approvals SET expires_at = now() + interval '1 second'
      WHERE id = ${approval2}`.execute(raw);
    await waitFor(
      async () =>
        (
          await sql<{ due: boolean }>`SELECT expires_at < now() AS due FROM capybara.approvals
            WHERE id = ${approval2}`.execute(raw)
        ).rows[0]?.due === true,
      10_000,
      "approval due",
    );
    await job.promote();
    const d2 = await finish();
    expect(d2.evs[0]?.runId).toBe(runD2);
    expect(ofType(d2.evs, "approval_decided").map((e) => e.payload.decision)).toEqual(["expired"]);
    expect(d2.result?.toolKey).toBe("docs__delete_doc");
    expect(d2.result?.isError).toBe(true);
    expect(d2.result?.content).toMatch(/^Approval timed out after \d+h; treated as denied\.$/);
    expect(ofType(d2.evs, "tool_call_started")).toEqual([]);
    expect(mcp.calls.filter((c) => c.name === "delete_doc")).toHaveLength(1);

    // ---- 4. 工具执行中杀掉执行它的 worker → 存活副本续跑：结果未知，工具只调用一次 ----
    const conv2Id = await newConv();
    const conv2 = `${base}/conversations/${conv2Id}`;
    await send(0, conv2, "docs__export", {});
    await waitFor(
      async () => mcp.calls.some((c) => c.name === "export"),
      20_000,
      "export call in flight",
    );
    const running = await db
      .selectFrom("runs")
      .select(["id", "job_id", "trigger_seq"])
      .where("conversation_id", "=", conv2Id)
      .where("status", "=", "running")
      .execute();
    expect(running).toHaveLength(1);
    const run = running[0] as (typeof running)[number];
    const jobId = run.job_id ?? runJobId(conv2Id, Number(run.trigger_seq));
    const processedBy = await redis.hget(`bull:cap-kernel-runs:${jobId}`, "pb");
    const victim = harness.replicas.find((r) => processedBy?.endsWith(`-${r.pid}`));
    expect(victim, `processedBy=${processedBy}`).toBeDefined();
    const victimIndex = (victim as { index: 0 | 1 }).index;
    const survivor: 0 | 1 = victimIndex === 0 ? 1 : 0;
    const startedBefore = ofType(await eventsOf(db, conv2Id), "tool_call_started");
    expect(startedBefore.map((e) => e.payload.toolKey)).toEqual(["docs__export"]);
    await harness.kill(victimIndex);

    const [fin] = await waitForTerminal(db, conv2Id, 1, 60_000);
    expect(fin?.type).toBe("run_finished");
    expect(fin?.runId).toBe(run.id);
    const k = await eventsOf(db, conv2Id);
    expect(ofType(k, "tool_result").map((e) => e.payload)).toEqual([
      expect.objectContaining({
        toolKey: "docs__export",
        isError: true,
        content: UNKNOWN_RESULT_TEXT,
      }),
    ]);
    expect(ofType(k, "tool_call_started")).toHaveLength(1);
    expect(ofType(k, "run_started")).toHaveLength(1);
    expect(mcp.calls.filter((c) => c.name === "export")).toHaveLength(1);
    // 模型拿到「结果未知」后收尾
    const reply = ofType(k, "assistant_message").at(-1);
    expect(JSON.stringify(reply?.payload.content)).toContain("Result unknown");

    // 存活副本上继续对话：会话锁与配额没有泄漏
    const more = await at(survivor, "POST", `${conv2}/messages`, { text: "echo:still here" });
    expect(more.status).toBe(202);
    await waitForTerminal(db, conv2Id, 2, 30_000);
    const active = await db
      .selectFrom("runs")
      .select("id")
      .where("status", "in", ["queued", "running", "waiting"])
      .execute();
    expect(active).toEqual([]);
  }, 240_000);
});
