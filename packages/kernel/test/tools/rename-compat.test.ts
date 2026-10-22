import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import {
  type FakeMcpServer,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { caseBase } from "../../src/evals/runs.service.js";
import {
  type CaseSnapshot,
  readSnapshot,
  replayableCalls,
  toEvents,
} from "../../src/evals/snapshot.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
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
  startKernel,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * T22（D17 / C27 / C28）：「应用」改名「连接器」之后的兼容性。
 * - 改名前录制的会话（MCP 连接器工具、tool_search 加载、connection_required、审批）由日志还原零漂移；
 * - 已存 agent 版本里的 `{kind:"app", appId}` 能读、能跑，工具 key 不变；
 * - `/connectors` 路由可用，旧的 `/apps` 返回 404（无兼容别名）。
 */

type Fixture = { model: ModelInfo; snapshot: CaseSnapshot; requests: ModelRequest[] };
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../evals/fixtures/pre-rename/mcp-conversation.json", import.meta.url)),
    "utf8",
  ),
) as Fixture;

describe("改名前录制的会话：还原零漂移", () => {
  const calls = toEvents(fixture.snapshot).filter(
    (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
  );

  it("夹具覆盖连接器工具、tool_search、connection_required 与审批", () => {
    const types = new Set(fixture.snapshot.events.map((e) => e.type));
    for (const t of ["connection_required", "approval_requested", "approval_decided"]) {
      expect(types.has(t as ConversationEvent["type"]), t).toBe(true);
    }
    const keys = fixture.snapshot.events
      .filter((e) => e.type === "tool_result")
      .map((e) => (e.payload as { toolKey: string }).toolKey);
    expect(keys).toEqual(["tool_search", "docs__search", "priv__search", "docs__delete_doc"]);
    expect(calls).toHaveLength(fixture.requests.length);
    expect(replayableCalls(fixture.snapshot).length).toBeGreaterThan(0);
  });

  it("每次 model_call：reconstructRequest 无漂移，请求与供应商当时收到的逐项相等", () => {
    for (const [i, c] of calls.entries()) {
      const out = reconstructRequest(fixture.snapshot, c.seq, { model: fixture.model });
      expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
      expect(out.request, `model_call seq ${c.seq}`).toEqual(fixture.requests[i]);
    }
  });
});

const CONNECTOR_MCP = fileURLToPath(
  new URL("../../../../plugins/connector-mcp/src/index.ts", import.meta.url),
);

describe("改名后的路由与旧 agent 版本", () => {
  let pgc: TestContainer;
  let rd: TestContainer;
  let k: Kernel;
  let raw: ReturnType<typeof createDb>;
  let db: KernelDb;
  let mcp: FakeMcpServer;
  let req: Req;
  let orgId: string;

  beforeAll(async () => {
    [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
    mcp = await startFakeMcpServer({
      tools: [
        {
          name: "search",
          description: "Search documents",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
          handler: ({ args }) => ({ content: [{ type: "text", text: `hits for ${args.q}` }] }),
        },
      ],
    });
    k = await startKernel(
      runConfig(
        { pg: pgc.url, redis: rd.url },
        {
          plugins: [MODEL_FAKE, CONNECTOR_MCP],
          pluginConfig: { "connector-mcp": { allowInsecureLoopback: true } },
          roles: ["api", "worker"],
        },
      ),
    );
    raw = createDb(pgc.url, 5);
    db = kernelDb(raw);
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    req = await session(k, "owner");
    orgId = await createOrg(req);
  }, 180_000);

  afterAll(async () => {
    await k?.stop();
    await mcp?.stop();
    await raw?.destroy();
    await Promise.all([pgc?.stop(), rd?.stop()]);
  });

  async function install(slug: string): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: `Docs ${slug}`,
        slug,
        connector: "mcp",
        endpoint: { url: mcp.url },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { connector: { id: string } }).connector.id;
  }

  it("/connectors 可用；旧路径 /apps 一律 404", async () => {
    const id = await install("docs");
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(list.statusCode, list.body).toBe(200);
    expect((list.json() as { connectors: { id: string }[] }).connectors.map((c) => c.id)).toEqual([
      id,
    ]);
    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${id}` });
    expect(one.statusCode, one.body).toBe(200);

    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/apps`],
      ["POST", `/api/v1/orgs/${orgId}/apps`],
      ["POST", `/api/v1/orgs/${orgId}/apps/preview`],
      ["GET", `/api/v1/orgs/${orgId}/apps/${id}`],
      ["POST", `/api/v1/orgs/${orgId}/apps/${id}/refresh`],
      ["GET", `/api/v1/orgs/${orgId}/apps/prompts`],
      ["POST", `/api/v1/orgs/${orgId}/apps/${id}/connect`],
    ] as const) {
      const r = await req({ method, url, ...(method === "POST" && { payload: {} }) });
      expect(r.statusCode, `${method} ${url}`).toBe(404);
    }
  }, 60_000);

  it("已存版本里的 {kind:'app', appId}：读入规范化为 connector 形，能运行，工具 key 不变", async () => {
    const id = await install("kb");
    // 新保存只写 connector 形；旧形仍可提交，存下来的是规范化后的 connector 形
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: {
          name: "Helper",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
          tools: [{ kind: "app", appId: id, tools: "all" }],
        },
        visibility: "org",
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const agentId = (created.json() as { agent: { id: string } }).agent.id;
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    expect((stored.definition as { tools: unknown[] }).tools).toEqual([
      { kind: "connector", connectorId: id, tools: "all" },
    ]);

    // 模拟改名前存下的版本：直接把旧形写回库
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...(stored.definition as Record<string, unknown>),
          tools: [{ kind: "app", appId: id, tools: "all" }],
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agentId}` });
    expect(got.statusCode, got.body).toBe(200);
    expect(
      (got.json() as { agent: { definition: { tools: unknown[] } } }).agent.definition.tools,
    ).toEqual([{ kind: "connector", connectorId: id, tools: "all" }]);

    const convId = await createConv(req, orgId, agentId);
    await postMessage(req, orgId, convId, 'tool:kb__search:{"q":"x"}');
    await waitForTerminal(db, convId, 1, 20_000);
    const results = (await eventsOf(db, convId)).filter((e) => e.type === "tool_result");
    expect(results.map((e) => e.payload)).toMatchObject([
      { toolKey: "kb__search", content: "hits for x", isError: false },
    ]);
  }, 60_000);

  it("改名前的评测快照：readSnapshot + caseBase 交给实时注册表，连接器工具都在（没有 app:undefined）", async () => {
    const docs = await install("fx_docs");
    const priv = await install("fx_priv");
    // 夹具定义引用的是录制库里的连接器 id：换成本库的 id，保持旧形 {kind:"app", appId}
    const raw = structuredClone(fixture.snapshot) as unknown as {
      definitions: Record<string, { tools: { kind: string; appId?: string }[] }>;
    };
    const def = raw.definitions[String(fixture.snapshot.agentVersion)];
    expect(def?.tools.map((t) => t.kind)).toEqual(["app", "app"]);
    const ids: string[] = [docs, priv];
    def?.tools.forEach((t, i) => {
      t.appId = ids[i] as string;
    });
    const snap = readSnapshot(raw);
    const base = await caseBase(db, snap);
    expect(base?.definition.tools).toEqual([
      { kind: "connector", connectorId: docs, tools: "all" },
      { kind: "connector", connectorId: priv, tools: ["search"] },
    ]);
    const resolved = await k.tools.registry.forAgent(orgId, base?.definition ?? { tools: [] });
    const keys = resolved.tools.map((t) => t.key);
    expect(keys).toEqual(expect.arrayContaining(["fx_docs__search", "fx_priv__search"]));
    expect(JSON.stringify(resolved.unavailable)).not.toContain("undefined");
    expect(resolved.unavailable).toEqual([]);
  }, 60_000);
});
