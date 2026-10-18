import { fileURLToPath } from "node:url";
import {
  FakeMcpRpcError,
  type FakeMcpServer,
  type FakeMcpServerOptions,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { loadToolSpec } from "../../src/tools/specs.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  waitFor,
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Task 11：connector-mcp 端到端。安装 MCP 应用（bearer，组织凭据）→ agent 调用只读工具直接执行、
 * destructive 工具触发审批；resources 的两个内核工具；超时由内核管线截断。
 *
 * Review Focus 3：假 MCP 服务把收到的 Authorization 头回显到结果、错误、JSON-RPC 错误与 HTTP 错误正文里，
 * token 原文不得出现在会话事件、工具输出存档、审计、内核日志与 HTTP 响应中（日志与结果里是 `[REDACTED]`）。
 */

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);

const TOKEN = "mcp-org-token-7f3a9c1e5b2d4086";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let mcp: FakeMcpServer;
let req: Req;
let orgId: string;
const logLines: string[] = [];
/** 测试里拿到的全部 HTTP 响应正文。 */
const httpBodies: string[] = [];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
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
        name: "leak_error",
        description: "Fails and echoes the auth header",
        annotations: { readOnlyHint: true },
        handler: ({ headers }) => ({
          content: [{ type: "text", text: `denied for ${headers.authorization}` }],
          isError: true,
        }),
      },
      {
        name: "rpc_error",
        description: "JSON-RPC error echoing the auth header",
        annotations: { readOnlyHint: true },
        handler: ({ headers }) => {
          throw new FakeMcpRpcError(-32600, `bad token ${headers.authorization}`);
        },
      },
      {
        name: "gateway",
        description: "The gateway in front of the server fails",
        annotations: { readOnlyHint: true },
      },
      {
        name: "huge",
        description: "Returns a huge result",
        annotations: { readOnlyHint: true },
        handler: ({ headers }) => ({
          content: [
            { type: "text", text: `${"x".repeat(60_000)} tail auth=${headers.authorization}` },
          ],
        }),
      },
      {
        name: "slow",
        description: "Takes longer than the tool timeout",
        annotations: { readOnlyHint: true },
        handler: async () => {
          await sleep(4_000);
          return { content: [{ type: "text", text: "late" }] };
        },
      },
      {
        name: "delete_doc",
        description: "Delete a document",
        inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        annotations: { destructiveHint: true },
        handler: ({ args }) => ({ content: [{ type: "text", text: `deleted ${args.id}` }] }),
      },
    ],
    resources: [
      { uri: "docs://handbook", name: "Handbook", mimeType: "text/markdown", text: "# Handbook" },
    ],
    intercept: (r) => {
      const params = (r.body as { params?: { name?: string } } | undefined)?.params;
      return r.method === "tools/call" && params?.name === "gateway"
        ? { status: 502, body: `gateway saw ${r.headers.authorization}` }
        : undefined;
    },
  });
  const logger = createLogger("info", { write: (l) => logLines.push(l) });
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CONNECTOR_MCP],
        // 假服务在 127.0.0.1 上跑 http：测试打开本机 http（默认关闭）
        pluginConfig: { "connector-mcp": { allowInsecureLoopback: true } },
        roles: ["api", "worker"],
        tools: { timeoutMs: 2_000 },
      },
    ),
    { env: {}, logger },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await mcp?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  orgId = await createOrg(req);
});

async function call(opts: Parameters<Req>[0]) {
  const res = await req(opts);
  httpBodies.push(res.body);
  return res;
}

async function installApp(): Promise<{ appId: string; body: Record<string, unknown> }> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/apps`,
    payload: {
      name: "Docs",
      slug: "docs",
      connector: "mcp",
      endpoint: { url: mcp.url },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: TOKEN },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  const body = res.json() as { app: { id: string } };
  return { appId: body.app.id, body: body as unknown as Record<string, unknown> };
}

async function agentFor(appId: string): Promise<string> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "app", appId, tools: "all" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** 发一条 `tool:` 指令并等第 n 个终态，返回该 run 的 tool_result。 */
async function runTool(convId: string, n: number, key: string, input: unknown) {
  await postMessage(req, orgId, convId, `tool:${key}:${JSON.stringify(input)}`);
  await waitForTerminal(db, convId, n, 20_000);
  const results = ofType(await eventsOf(db, convId), "tool_result");
  const r = results.at(-1);
  expect(r?.payload.toolKey).toBe(key);
  return r?.payload as NonNullable<typeof r>["payload"];
}

describe("connector-mcp 端到端", () => {
  it("安装：工具快照带注解推导的默认策略，resources 工具默认 allow", async () => {
    const { body } = await installApp();
    const tools = (body.app as { tools: { name: string; key: string; defaultPolicy: string }[] })
      .tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.search?.defaultPolicy).toBe("allow");
    expect(byName.delete_doc?.defaultPolicy).toBe("ask");
    expect(byName.list_resources).toMatchObject({
      key: "docs__list_resources",
      defaultPolicy: "allow",
    });
    expect(byName.read_resource).toMatchObject({
      key: "docs__read_resource",
      defaultPolicy: "allow",
    });
  });

  it("连接器自带同名工具时它优先；刷新时服务不再支持 resources → 两个工具被移除", async () => {
    const opts: FakeMcpServerOptions = {
      tools: [{ name: "list_resources", description: "Server's own listing" }],
      resources: [],
    };
    const srv = await startFakeMcpServer(opts);
    try {
      const res = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/apps`,
        payload: {
          name: "Files",
          slug: "files",
          connector: "mcp",
          endpoint: { url: srv.url },
          auth: { type: "none" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const body = res.json() as {
        app: { id: string; tools: { name: string; source: string; description: string }[] };
        issues: { name: string; reason: string }[];
      };
      expect(body.app.tools.map((t) => [t.name, t.source])).toEqual([
        ["list_resources", "connector"],
        ["read_resource", "resources"],
      ]);
      expect(body.issues).toEqual([
        {
          name: "list_resources",
          reason:
            "The app has its own tool named list_resources; the built-in resource tool is not added",
        },
      ]);

      delete opts.resources;
      const r2 = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/apps/${body.app.id}/refresh`,
      });
      expect(r2.statusCode, r2.body).toBe(200);
      const after = r2.json() as {
        app: { tools: { name: string }[] };
        changes: { removed: string[] };
      };
      expect(after.changes.removed).toEqual(["read_resource"]);
      expect(after.app.tools.map((t) => t.name)).toEqual(["list_resources"]);
    } finally {
      await srv.stop();
    }
  });

  it("刷新时 resources 工具被连接器同名工具取代 → 来源改为 connector，默认策略按注解重新推导", async () => {
    const opts: FakeMcpServerOptions = { tools: [], resources: [] };
    const srv = await startFakeMcpServer(opts);
    try {
      const res = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/apps`,
        payload: {
          name: "Notes",
          slug: "notes",
          connector: "mcp",
          endpoint: { url: srv.url },
          auth: { type: "none" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      type Tool = { name: string; source: string; defaultPolicy: string };
      const app = (res.json() as { app: { id: string; tools: Tool[] } }).app;
      expect(app.tools.find((t) => t.name === "list_resources")).toMatchObject({
        source: "resources",
        defaultPolicy: "allow",
      });

      // 服务新增了自己的 list_resources（无注解）
      opts.tools.push({ name: "list_resources", description: "Server's own listing" });
      const r2 = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/apps/${app.id}/refresh`,
      });
      expect(r2.statusCode, r2.body).toBe(200);
      const after = r2.json() as { app: { tools: Tool[] }; changes: { changed: string[] } };
      expect(after.changes.changed).toEqual(["list_resources"]);
      expect(after.app.tools.find((t) => t.name === "list_resources")).toMatchObject({
        source: "connector",
        defaultPolicy: "ask",
      });
      // 未换来源的 read_resource 不受影响
      expect(after.app.tools.find((t) => t.name === "read_resource")).toMatchObject({
        source: "resources",
        defaultPolicy: "allow",
      });
    } finally {
      await srv.stop();
    }
  });

  it("只读工具直接执行；resources；超时；Review Focus 3：凭据回显处处打码", async () => {
    const { appId } = await installApp();
    const agentId = await agentFor(appId);
    const convId = await createConv(req, orgId, agentId);

    const search = await runTool(convId, 1, "docs__search", { q: "cats" });
    expect(search).toMatchObject({ content: "results for cats; auth=[REDACTED]", isError: false });
    // 假服务确实收到并回显了 token（否则打码断言没有意义）
    expect(mcp.calls.find((c) => c.name === "search")?.headers.authorization).toBe(
      `Bearer ${TOKEN}`,
    );

    const leak = await runTool(convId, 2, "docs__leak_error", {});
    expect(leak).toMatchObject({ content: "denied for [REDACTED]", isError: true });

    const rpc = await runTool(convId, 3, "docs__rpc_error", {});
    expect(rpc).toMatchObject({
      content:
        "The app returned an error: bad token [REDACTED] (check the arguments and retry, or ask the user if it keeps failing).",
      isError: true,
    });

    const gw = await runTool(convId, 4, "docs__gateway", {});
    expect(gw).toMatchObject({
      content:
        "The app's server responded with HTTP 502. Retry later, or ask an administrator to check the app.",
      isError: true,
    });
    const failLog = logLines.find((l) => l.includes("MCP request failed"));
    expect(failLog).toContain("gateway saw [REDACTED]");

    const huge = await runTool(convId, 5, "docs__huge", {});
    expect(huge.outputId).toEqual(expect.any(String));
    const archived = await db
      .selectFrom("tool_outputs")
      .select("content")
      .where("id", "=", huge.outputId as string)
      .executeTakeFirstOrThrow();
    expect(archived.content.endsWith("tail auth=[REDACTED]")).toBe(true);

    const list = await runTool(convId, 6, "docs__list_resources", {});
    expect(list.isError).toBe(false);
    expect(JSON.parse(list.content)).toEqual([
      { uri: "docs://handbook", name: "Handbook", mimeType: "text/markdown" },
    ]);
    const read = await runTool(convId, 7, "docs__read_resource", { uri: "docs://handbook" });
    expect(read).toMatchObject({ content: "# Handbook", isError: false });

    const t0 = Date.now();
    const slow = await runTool(convId, 8, "docs__slow", {});
    expect(slow.content).toMatch(/^Tool docs__slow timed out after 2s\./);
    expect(slow.isError).toBe(true);
    expect(Date.now() - t0).toBeLessThan(4_000);

    // 没有审批：只读工具与 resources 工具都直接执行
    const evs = await eventsOf(db, convId);
    expect(ofType(evs, "approval_requested")).toEqual([]);

    // 事件（含模型回复里转述的结果）、工具输出存档、审计、日志、HTTP 响应都不含 token 原文
    const eventsRes = await call({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/events`,
    });
    expect(eventsRes.statusCode).toBe(200);
    await call({ method: "GET", url: `/api/v1/orgs/${orgId}/apps/${appId}` });
    const audits = await db.selectFrom("audit_events").selectAll().execute();
    const outputs = await db.selectFrom("tool_outputs").select("content").execute();
    const haystacks: [string, string][] = [
      ["events", JSON.stringify(evs)],
      ["tool_outputs", JSON.stringify(outputs)],
      ["audit_events", JSON.stringify(audits)],
      ["logs", logLines.join("\n")],
      ["http", httpBodies.join("\n")],
    ];
    for (const [where, text] of haystacks) {
      expect(text.includes(TOKEN), `token leaked into ${where}`).toBe(false);
    }
    expect(JSON.stringify(evs)).toContain("[REDACTED]");
    expect(logLines.join("\n")).toContain("[REDACTED]");
  }, 60_000);

  it("destructive 工具触发审批：批准前不执行，批准后执行一次", async () => {
    const { appId } = await installApp();
    const agentId = await agentFor(appId);
    const convId = await createConv(req, orgId, agentId);
    const before = mcp.calls.filter((c) => c.name === "delete_doc").length;

    await postMessage(req, orgId, convId, 'tool:docs__delete_doc:{"id":"42"}');
    const asked = (await waitForEvent(
      db,
      convId,
      (e) => e.type === "approval_requested",
      15_000,
      "approval_requested",
    )) as Extract<ConversationEvent, { type: "approval_requested" }>;
    expect(asked.payload.toolKey).toBe("docs__delete_doc");
    await waitFor(
      async () =>
        (
          await db
            .selectFrom("runs")
            .select("status")
            .where("id", "=", asked.runId as string)
            .executeTakeFirst()
        )?.status === "waiting",
      10_000,
      "run waiting",
    );
    expect(mcp.calls.filter((c) => c.name === "delete_doc").length).toBe(before);

    const ok = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${asked.payload.approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    await waitForTerminal(db, convId, 1, 20_000);
    const results = ofType(await eventsOf(db, convId), "tool_result");
    expect(results.map((r) => r.payload)).toMatchObject([
      { toolKey: "docs__delete_doc", content: "deleted 42", isError: false },
    ]);
    expect(mcp.calls.filter((c) => c.name === "delete_doc").length).toBe(before + 1);
  }, 60_000);

  it("刷新改了工具定义之后，早先 model_call 用过的定义仍可按指纹取回（请求可还原）", async () => {
    const opts: FakeMcpServerOptions = {
      tools: [
        {
          name: "lookup",
          description: "Look up v1",
          annotations: { readOnlyHint: true },
          handler: () => ({ content: [{ type: "text", text: "found" }] }),
        },
      ],
    };
    const srv = await startFakeMcpServer(opts);
    try {
      const res = await call({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/apps`,
        payload: {
          name: "Kb",
          slug: "kb",
          connector: "mcp",
          endpoint: { url: srv.url },
          auth: { type: "none" },
        },
      });
      expect(res.statusCode, res.body).toBe(201);
      const appId = (res.json() as { app: { id: string } }).app.id;
      const agentId = await agentFor(appId);
      const convId = await createConv(req, orgId, agentId);
      await runTool(convId, 1, "kb__lookup", {});
      const firstCall = ofType(await eventsOf(db, convId), "model_call")[0];
      const used = firstCall?.payload.request.tools?.find((t) => t.key === "kb__lookup");
      expect(used).toBeDefined();
      const oldHash = used?.specHash as string;

      (opts.tools[0] as { description: string }).description = "Look up v2";
      const r2 = await call({ method: "POST", url: `/api/v1/orgs/${orgId}/apps/${appId}/refresh` });
      expect(r2.statusCode, r2.body).toBe(200);
      const after = (r2.json() as { app: { tools: { name: string; specHash: string }[] } }).app;
      const newHash = after.tools.find((t) => t.name === "lookup")?.specHash as string;
      expect(newHash).not.toBe(oldHash);

      expect(await loadToolSpec(db, oldHash)).toMatchObject({
        name: "lookup",
        description: "Look up v1",
      });
      // 安装 / 刷新时也写入：新定义在任何模型请求之前就可按指纹取回
      expect(await loadToolSpec(db, newHash)).toMatchObject({ description: "Look up v2" });
    } finally {
      await srv.stop();
    }
  }, 60_000);
});
