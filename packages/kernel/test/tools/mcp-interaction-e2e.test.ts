import { fileURLToPath } from "node:url";
import {
  FakeMcpRpcError,
  type FakeMcpServer,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { UNSUPPORTED_ELICITATION_NOTE } from "../../src/tools/elicitation.js";
import { truncateTables } from "../helpers/db.js";
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
 * Task 20：MCP elicitation（表单 / URL / `-32042`）经通用输入请求续跑；prompts 列表与渲染；resources 搜索；
 * 用户消息附带资源（内核用发送者凭据读取、打码、限长）。假服务把收到的 Authorization 头回显到 elicitation 文案、
 * 提示与资源正文里：token 原文不得出现在事件与 HTTP 响应中。
 */

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);

const TOKEN = "mcp-elicit-token-5c2e8a71d94b";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let mcp: FakeMcpServer;
let req: Req;
let orgId: string;
let payCalls = 0;
const httpBodies: string[] = [];

const ofType = <T extends ConversationEvent["type"]>(evs: ConversationEvent[], type: T) =>
  evs.filter((e): e is Extract<ConversationEvent, { type: T }> => e.type === type);

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  mcp = await startFakeMcpServer({
    sessions: true,
    requireBearer: TOKEN,
    tools: [
      {
        name: "signup",
        description: "Sign the user up",
        annotations: { readOnlyHint: true },
        handler: async ({ headers }, ctx) => {
          const r = await ctx.elicit({
            message: `Sign up (seen ${headers.authorization})`,
            requestedSchema: {
              type: "object",
              properties: { name: { type: "string", title: "Name" } },
              required: ["name"],
            },
          });
          return {
            content: [
              {
                type: "text",
                text: r.action === "accept" ? `welcome ${r.content?.name}` : `signup ${r.action}`,
              },
            ],
          };
        },
      },
      {
        name: "connect",
        description: "Connect an account",
        annotations: { readOnlyHint: true },
        handler: async (_info, ctx) => {
          const r = await ctx.elicit({
            mode: "url",
            message: "Connect your account",
            url: `https://auth.example.com/connect?state=${Math.random()}`,
            elicitationId: `el-${Math.random()}`,
          });
          return {
            content: [
              { type: "text", text: r.action === "accept" ? "connected" : `connect ${r.action}` },
            ],
          };
        },
      },
      {
        name: "nested",
        description: "Asks for a constrained field",
        annotations: { readOnlyHint: true },
        handler: async (_info, ctx) => {
          const r = await ctx.elicit({
            message: "Address",
            // MCP 的扁平子集之内，但超出 InputForm 子集（minLength > 1）
            requestedSchema: {
              type: "object",
              properties: { zip: { type: "string", minLength: 5 } },
            },
          });
          return { content: [{ type: "text", text: `nested ${r.action}` }] };
        },
      },
      {
        name: "pay",
        description: "Pay an invoice",
        annotations: { readOnlyHint: true },
        handler: () => {
          payCalls++;
          if (payCalls === 1) {
            throw new FakeMcpRpcError(-32042, "Bank connection required", {
              elicitations: [
                {
                  mode: "url",
                  message: "Connect your bank",
                  url: "https://bank.example.com/connect",
                  elicitationId: "el-bank",
                },
              ],
            });
          }
          return { content: [{ type: "text", text: "paid" }] };
        },
      },
    ],
    prompts: [
      {
        name: "summarize",
        title: "Summarize",
        description: "Summarize a topic",
        arguments: [{ name: "topic", description: "Topic", required: true }],
        render: (args, headers) => [
          {
            role: "user",
            content: { type: "text", text: `Summarize ${args.topic} (${headers.authorization})` },
          },
        ],
      },
    ],
    resources: [
      {
        uri: "docs://handbook",
        name: "Handbook",
        mimeType: "text/markdown",
        text: `# Handbook ${"x".repeat(10)} token=${TOKEN}`,
      },
      { uri: "docs://big", name: "Big file", text: "y".repeat(60_000) },
    ],
  });
  const logger = createLogger("info", { write: () => {} });
  k = await createKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CONNECTOR_MCP],
        pluginPermissions: { autoApprove: true },
        pluginConfig: { "connector-mcp": { allowInsecureLoopback: true } },
        roles: ["api", "worker"],
        // 足够长：断言「为问用户而中止」立即结束，而不是等满工具超时
        tools: { timeoutMs: 30_000 },
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
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  orgId = await createOrg(req);
  payCalls = 0;
  mcp.elicitations.length = 0;
  mcp.calls.length = 0;
});

async function call(opts: Parameters<Req>[0]) {
  const res = await req(opts);
  httpBodies.push(res.body);
  return res;
}

async function installConnector(
  slug = "forms",
  ownership: "org" | "personal" = "org",
): Promise<string> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: {
      name: slug === "forms" ? "Forms" : `App ${slug}`,
      slug,
      connector: "mcp",
      endpoint: { url: mcp.url },
      auth: { type: "bearer", ownership },
      credential: { token: TOKEN },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

async function agentFor(connectorId: string): Promise<string> {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "connector", connectorId, tools: "all" }],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { agent: { id: string } }).agent.id;
}

/** 发 `tool:` 指令，等第 n 个输入请求（question_asked）并等运行进入 waiting。 */
async function askedBy(convId: string, key: string, n = 1) {
  await postMessage(req, orgId, convId, `tool:${key}:{}`);
  const ev = (await waitFor(
    async () => ofType(await eventsOf(db, convId), "question_asked")[n - 1],
    15_000,
    "question_asked",
  )) as Extract<ConversationEvent, { type: "question_asked" }>;
  await waitFor(
    async () =>
      (
        await db
          .selectFrom("runs")
          .select("status")
          .where("id", "=", ev.runId as string)
          .executeTakeFirst()
      )?.status === "waiting",
    10_000,
    "run waiting",
  );
  return ev;
}

async function answer(questionId: string, body: Record<string, unknown>) {
  const res = await call({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/questions/${questionId}/answer`,
    payload: { answer: body },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function lastResult(convId: string, n: number) {
  await waitForTerminal(db, convId, n, 20_000);
  return ofType(await eventsOf(db, convId), "tool_result").at(-1)?.payload;
}

describe("MCP elicitation", () => {
  it("表单：中止调用并转成输入请求（文案打码）；回答后重新发起调用，用答案答复同一 elicitation", async () => {
    const agentId = await agentFor(await installConnector());
    const convId = await createConv(req, orgId, agentId);
    const q = await askedBy(convId, "forms__signup");
    expect(q.payload.form).toEqual({
      title: "Sign up (seen [REDACTED])",
      fields: [{ key: "name", label: "Name", schema: { type: "string" }, required: true }],
    });
    // 第一次调用在 elicitation 处被中止，还没有结果
    expect(ofType(await eventsOf(db, convId), "tool_result")).toEqual([]);

    await answer(q.payload.questionId, { name: "Ada" });
    const r = await lastResult(convId, 1);
    expect(r).toMatchObject({ toolKey: "forms__signup", content: "welcome Ada", isError: false });
    expect(mcp.calls.filter((c) => c.name === "signup")).toHaveLength(2);
    expect(mcp.elicitations.map((e) => e.result)).toEqual([
      "error",
      { action: "accept", content: { name: "Ada" } },
    ]);
    const evs = JSON.stringify(await eventsOf(db, convId));
    expect(evs.includes(TOKEN)).toBe(false);
  }, 60_000);

  it("URL 模式：卡片带链接与「已完成」；确认后远端收到 accept", async () => {
    const agentId = await agentFor(await installConnector());
    const convId = await createConv(req, orgId, agentId);
    const q = await askedBy(convId, "forms__connect");
    expect(q.payload.form).toMatchObject({
      title: "Connect your account",
      url: expect.stringMatching(/^https:\/\/auth\.example\.com\/connect\?state=/),
      fields: [{ key: "completed", schema: { type: "boolean" }, required: true }],
    });
    await answer(q.payload.questionId, { completed: true });
    expect(await lastResult(convId, 1)).toMatchObject({ content: "connected", isError: false });
  }, 60_000);

  it("URL 模式未勾选「已完成」→ decline 给远端", async () => {
    const agentId = await agentFor(await installConnector());
    const convId = await createConv(req, orgId, agentId);
    const q = await askedBy(convId, "forms__connect");
    await answer(q.payload.questionId, { completed: false });
    expect(await lastResult(convId, 1)).toMatchObject({ content: "connect decline" });
  }, 60_000);

  it("超出子集的表单：立即 decline，结果附说明，不暂停", async () => {
    const agentId = await agentFor(await installConnector());
    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, "tool:forms__nested:{}");
    const r = await lastResult(convId, 1);
    expect(r?.content).toContain("nested decline");
    expect(r?.content).toContain(UNSUPPORTED_ELICITATION_NOTE);
    expect(ofType(await eventsOf(db, convId), "question_asked")).toEqual([]);
  }, 60_000);

  it("-32042（URL elicitation required）：转成 URL 卡片；用户确认后重新调用成功", async () => {
    const agentId = await agentFor(await installConnector());
    const convId = await createConv(req, orgId, agentId);
    const t0 = Date.now();
    const q = await askedBy(convId, "forms__pay");
    // -32042 路径里连接器 await onElicit：问用户时必须立即结束，不能等满 tools.timeoutMs（30s）
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(q.payload.form).toMatchObject({
      title: "Connect your bank",
      url: "https://bank.example.com/connect",
    });
    await answer(q.payload.questionId, { completed: true });
    expect(await lastResult(convId, 1)).toMatchObject({ content: "paid", isError: false });
    expect(payCalls).toBe(2);
  }, 60_000);
});

describe("prompts 与 resources", () => {
  it("列出可用连接器的 prompts；渲染为文本（打码）；个人连接器缺凭据 → unavailable", async () => {
    const connectorId = await installConnector();
    const personal = await installConnector("mine", "personal");
    const cleared = await call({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/connectors/${personal}/credentials/me`,
    });
    expect(cleared.statusCode, cleared.body).toBe(204);

    const list = await call({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/prompts` });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json()).toEqual({
      prompts: [
        {
          connectorId,
          connectorSlug: "forms",
          connectorName: "Forms",
          name: "summarize",
          title: "Summarize",
          description: "Summarize a topic",
          arguments: [{ name: "topic", description: "Topic", required: true }],
        },
      ],
      unavailable: [{ connectorId: personal, connectorName: "App mine", reason: "not_connected" }],
    });

    const got = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/prompts/summarize`,
      payload: { arguments: { topic: "cats" } },
    });
    expect(got.statusCode, got.body).toBe(200);
    expect(got.json()).toEqual({ text: "Summarize cats ([REDACTED])" });

    const unknown = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}/prompts/nope`,
      payload: { arguments: {} },
    });
    expect(unknown.statusCode, unknown.body).toBe(502);
    expect((unknown.json() as { error: { code: string } }).error.code).toBe(
      "connector.connect_failed",
    );

    const noCred = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${personal}/prompts/summarize`,
      payload: { arguments: { topic: "x" } },
    });
    expect(noCred.statusCode, noCred.body).toBe(409);
    expect((noCred.json() as { error: { code: string } }).error.code).toBe("credential.missing");
    expect(httpBodies.join("\n").includes(TOKEN)).toBe(false);
  }, 60_000);

  it("搜索 resources（名称 / URI 子串，不区分大小写）", async () => {
    const connectorId = await installConnector();
    const all = await call({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/resources` });
    expect(all.statusCode, all.body).toBe(200);
    expect((all.json() as { resources: { uri: string }[] }).resources.map((r) => r.uri)).toEqual([
      "docs://handbook",
      "docs://big",
    ]);
    const hit = await call({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/resources?query=HAND`,
    });
    expect(hit.json()).toEqual({
      resources: [
        {
          connectorId,
          connectorSlug: "forms",
          connectorName: "Forms",
          uri: "docs://handbook",
          name: "Handbook",
          mimeType: "text/markdown",
        },
      ],
      unavailable: [],
    });
  }, 60_000);

  it("消息附带资源：内核读取（打码、限长）存为额外文本块，并记录附件元数据", async () => {
    const connectorId = await installConnector();
    const agentId = await agentFor(connectorId);
    const convId = await createConv(req, orgId, agentId);
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: {
        text: "Please read these",
        attachments: [
          { connectorId, uri: "docs://handbook" },
          { connectorId, uri: "docs://big" },
        ],
      },
    });
    expect(res.statusCode, res.body).toBe(202);
    const ev = (await waitForEvent(db, convId, (e) => e.type === "user_message")) as Extract<
      ConversationEvent,
      { type: "user_message" }
    >;
    const blocks = ev.payload.content as { type: string; text: string }[];
    expect(blocks[0]).toEqual({ type: "text", text: "Please read these" });
    expect(blocks[1]?.text).toBe(
      `Attached resource "Handbook" (docs://handbook) from app Forms:\n\n# Handbook ${"x".repeat(10)} token=[REDACTED]`,
    );
    expect(blocks[2]?.text.length).toBeLessThan(52_000);
    expect(blocks[2]?.text).toMatch(
      /\[Attachment truncated: showing the first 50000 of 60000 characters\.\]$/,
    );
    expect(ev.payload.attachments).toEqual([
      { appId: connectorId, appName: "Forms", uri: "docs://handbook", name: "Handbook" },
      { appId: connectorId, appName: "Forms", uri: "docs://big", name: "Big file" },
    ]);
    expect(JSON.stringify(ev).includes(TOKEN)).toBe(false);

    const bad = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: {
        text: "x",
        attachments: [{ connectorId: "3f1c9a2e-8b4d-4e6f-9a1b-2c3d4e5f6a7b", uri: "a" }],
      },
    });
    expect(bad.statusCode, bad.body).toBe(404);
    expect((bad.json() as { error: { code: string } }).error.code).toBe("connector.not_found");
    const tooMany = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: {
        text: "x",
        attachments: Array.from({ length: 6 }, () => ({ connectorId, uri: "a" })),
      },
    });
    expect(tooMany.statusCode, tooMany.body).toBe(400);
  }, 60_000);

  it("管理员停用了 read_resource 工具（Ruling A23）：资源不列出，附件被拒", async () => {
    const connectorId = await installConnector();
    const off = await call({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${connectorId}`,
      payload: { tools: { read_resource: { status: "disabled" } } },
    });
    expect(off.statusCode, off.body).toBe(200);
    const list = await call({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/resources` });
    expect(list.json()).toEqual({ resources: [], unavailable: [] });
    const agentId = await agentFor(connectorId);
    const convId = await createConv(req, orgId, agentId);
    const res = await call({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/messages`,
      payload: { text: "read", attachments: [{ connectorId, uri: "docs://handbook" }] },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe(
      "connector.resources_disabled",
    );
    expect(ofType(await eventsOf(db, convId), "user_message")).toEqual([]);
  }, 60_000);
});
