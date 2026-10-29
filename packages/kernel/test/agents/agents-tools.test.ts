import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AgentDefinition,
  AgentDefinitionSchema,
  DEFAULT_AGENT_TOOLS,
} from "../../src/agents/definition.js";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { createLogger } from "../../src/log.js";
import {
  runModelStep,
  TOOLS_AVAILABLE_AGAIN,
  TOOLS_UNAVAILABLE_PREFIX,
} from "../../src/runtime/model-call.js";
import { RunSteps } from "../../src/runtime/run-steps.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const TOOLS_PROBE = fileURLToPath(
  new URL("../fixtures/plugins/tools-probe/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let req: ReturnType<typeof asUser>;
let orgId: string;
let ownerId: string;

const PW = "correct horse battery";
const MODEL = { provider: "model-fake", model: "fake-1" };

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [...MODEL_PLUGINS_CONFIG.extensions, MEM_CONNECTOR, TOOLS_PROBE],
      extensionPermissions: { autoApprove: true },
      extensionConfig: MODEL_PLUGINS_CONFIG.extensionConfig,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
}, 120_000);
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  memState().servers = {
    open: {
      tools: [
        {
          name: "read",
          description: "Read a document.",
          inputSchema: { type: "object" },
          annotations: { readOnlyHint: true },
        },
        { name: "write", description: "Write a document.", inputSchema: { type: "object" } },
      ],
    },
  };
  req = asUser(k.http, cookieJar());
  const login = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "owner", password: PW },
  });
  expect(login.statusCode).toBe(200);
  orgId = await createOrg("Acme");
});

async function createOrg(name: string): Promise<string> {
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(org.statusCode, org.body).toBe(201);
  return (org.json() as { org: { id: string } }).org.id;
}

async function installConnector(slug: string, inOrg = orgId): Promise<string> {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${inOrg}/connectors`,
    payload: {
      name: slug,
      slug,
      connector: "mem",
      endpoint: { server: "open" },
      auth: { type: "none" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { connector: { id: string } }).connector.id;
}

type AgentRes = { agent: { id: string; definition: AgentDefinition } };

const createAgent = (definition: Record<string, unknown>) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition: { name: "Helper", model: MODEL, ...definition }, visibility: "org" },
  });

const detailPaths = (res: { json(): unknown }): string[] =>
  (res.json() as { error: { details?: { path: string }[] } }).error.details?.map((d) => d.path) ??
  [];

describe("agent 定义的工具", () => {
  it("旧定义（tools: []、没有 toolPolicies）解析与读出都正常", async () => {
    const parsed = AgentDefinitionSchema.parse({ name: "Old", model: MODEL, tools: [] });
    expect(parsed.tools).toEqual([]);
    expect(parsed.toolPolicies).toEqual({});

    const res = await createAgent({ tools: [] });
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json() as AgentRes;
    expect(agent.definition.tools).toEqual([]);
    // 模拟 M2 存下的版本：没有 toolPolicies 字段
    await sql`UPDATE capybara.agent_versions
      SET definition = definition - 'toolPolicies' WHERE agent_id = ${agent.id}`.execute(raw);
    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${agent.id}` });
    expect(got.statusCode).toBe(200);
    expect((got.json() as AgentRes).agent.definition.tools).toEqual([]);
  });

  it("创建时省略 tools → 默认 ask_user + read_tool_output；修改时省略 tools 不注入默认值", async () => {
    const res = await createAgent({});
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json() as AgentRes;
    expect(agent.definition.tools).toEqual(DEFAULT_AGENT_TOOLS);
    expect(agent.definition.toolPolicies).toEqual({});
    const stored = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agent.id)
      .executeTakeFirstOrThrow();
    expect((stored.definition as unknown as AgentDefinition).tools).toEqual(DEFAULT_AGENT_TOOLS);

    const patched = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { definition: { name: "Helper", model: MODEL } },
    });
    expect(patched.statusCode, patched.body).toBe(200);
    expect((patched.json() as AgentRes).agent.definition.tools).toEqual([]);
  });

  it("引用存在的内置 / 插件 / 连接器工具并收紧策略 → 保存成功", async () => {
    const connectorId = await installConnector("docs");
    const res = await createAgent({
      tools: [
        { kind: "builtin", name: "ask_user" },
        { kind: "plugin", plugin: "tools-probe", name: "echo" },
        { kind: "connector", connectorId, tools: "all" },
      ],
      toolPolicies: { docs__read: "ask", docs__write: "deny", "tools-probe__echo": "deny" },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as AgentRes).agent.definition.toolPolicies).toEqual({
      docs__read: "ask",
      docs__write: "deny",
      "tools-probe__echo": "deny",
    });
  });

  it("引用不存在的连接器 / 其他组织的连接器 / 连接器里不存在的工具 → 400 validation_failed（path tools.<i>）", async () => {
    const connectorId = await installConnector("docs");
    const missing = await createAgent({
      tools: [
        { kind: "builtin", name: "ask_user" },
        { kind: "connector", connectorId: randomUUID(), tools: "all" },
      ],
    });
    expect(missing.statusCode).toBe(400);
    expect((missing.json() as { error: { code: string } }).error.code).toBe("validation_failed");
    expect(detailPaths(missing)).toEqual(["tools.1"]);

    const otherOrg = await createOrg("Other");
    const foreign = await installConnector("theirs", otherOrg);
    const cross = await createAgent({
      tools: [{ kind: "connector", connectorId: foreign, tools: "all" }],
    });
    expect(cross.statusCode).toBe(400);
    expect(detailPaths(cross)).toEqual(["tools.0"]);

    const noTool = await createAgent({
      tools: [{ kind: "connector", connectorId, tools: ["read", "nope"] }],
    });
    expect(noTool.statusCode).toBe(400);
    expect(detailPaths(noTool)).toEqual(["tools.0"]);

    // 软删除的连接器同样视为不存在
    expect(
      (await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` }))
        .statusCode,
    ).toBe(204);
    const deleted = await createAgent({
      tools: [{ kind: "connector", connectorId, tools: "all" }],
    });
    expect(deleted.statusCode).toBe(400);
  });

  it("不存在的内置工具 / 插件工具 → 400", async () => {
    const builtin = await createAgent({ tools: [{ kind: "builtin", name: "rm_rf" }] });
    expect(builtin.statusCode).toBe(400);
    expect(detailPaths(builtin)).toEqual(["tools.0"]);
    const plugin = await createAgent({
      tools: [{ kind: "plugin", plugin: "tools-probe", name: "missing" }],
    });
    expect(plugin.statusCode).toBe(400);
    expect(detailPaths(plugin)).toEqual(["tools.0"]);
  });

  it("toolPolicies 放宽（allow）→ 400；键不是该 agent 的工具 → 400（path toolPolicies.<key>）", async () => {
    const connectorId = await installConnector("docs");
    const loosen = await createAgent({
      tools: [{ kind: "connector", connectorId, tools: "all" }],
      toolPolicies: { docs__write: "allow" },
    });
    expect(loosen.statusCode).toBe(400);
    expect(detailPaths(loosen)).toEqual(["definition.toolPolicies.docs__write"]);

    const unknown = await createAgent({
      tools: [{ kind: "connector", connectorId, tools: ["read"] }],
      toolPolicies: { docs__write: "deny", ask_user: "ask" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(detailPaths(unknown)).toEqual(["toolPolicies.docs__write", "toolPolicies.ask_user"]);

    // PATCH 同样校验
    const ok = await createAgent({ tools: [{ kind: "connector", connectorId, tools: ["read"] }] });
    const { agent } = ok.json() as AgentRes;
    const patched = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: {
        definition: {
          name: "Helper",
          model: MODEL,
          tools: [{ kind: "connector", connectorId, tools: ["read"] }],
          toolPolicies: { docs__write: "deny" },
        },
      },
    });
    expect(patched.statusCode).toBe(400);
    expect(detailPaths(patched)).toEqual(["toolPolicies.docs__write"]);
  });
});

describe("运行时：工具带入请求，不可用工具写提醒（Review Focus 4）", () => {
  /** 建会话行并写一条用户消息；返回会话 id。 */
  async function conversation(agentId: string, text: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${id}, ${orgId}, ${agentId}, ${ownerId})`.execute(raw);
    await k.app.get(EventLog).append(id, [
      {
        type: "user_message",
        payload: { content: [{ type: "text", text }], authorAccountId: ownerId },
      },
    ]);
    return id;
  }

  const step = (agent: AgentDefinition, conversationId: string, runId: string, n: number) =>
    runModelStep(k.app.get(RunSteps).deps, {
      orgId,
      conversationId,
      runId,
      step: n,
      agent,
      agentVersion: 1,
      absorbedUpToSeq: 1_000_000,
      signal: new AbortController().signal,
      sink: () => {},
    });

  const ofType = async <T extends ConversationEvent["type"]>(id: string, type: T) =>
    (await k.app.get(EventLog).readAfter(id, 0, 1000)).filter(
      (e) => e.type === type,
    ) as (ConversationEvent & {
      payload: EventPayload<T>;
    })[];

  it("model_call.request.tools 记录按 key 排序的工具与指纹", async () => {
    const connectorId = await installConnector("docs");
    const res = await createAgent({
      tools: [{ kind: "connector", connectorId, tools: ["write", "read"] }],
    });
    const { agent } = res.json() as AgentRes;
    const convId = await conversation(agent.id, "hello");
    const r = await step(agent.definition, convId, randomUUID(), 1);
    expect(r.aborted).toBe(false);
    const [call] = await ofType(convId, "model_call");
    const { tools } = await k.app.get(ToolRegistry).forAgent(orgId, agent.definition);
    const hash = (key: string) => tools.find((t) => t.key === key)?.specHash;
    expect(call?.payload.request.tools).toEqual([
      { key: "docs__read", specHash: hash("docs__read") },
      { key: "docs__write", specHash: hash("docs__write") },
    ]);
    expect(await ofType(convId, "reminder")).toEqual([]);
  });

  it("引用的连接器被删除：写一条英文提醒、请求不带它的工具、本步照常完成；同样的提醒不逐步重复", async () => {
    const connectorId = await installConnector("docs");
    const res = await createAgent({
      tools: [
        { kind: "plugin", plugin: "tools-probe", name: "echo" },
        { kind: "connector", connectorId, tools: "all" },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const { agent } = res.json() as AgentRes;
    expect(
      (await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${connectorId}` }))
        .statusCode,
    ).toBe(204);

    const convId = await conversation(agent.id, "hello");
    const runId = randomUUID();
    const r = await step(agent.definition, convId, runId, 1);
    expect(r.aborted).toBe(false);
    expect(r.stopReason).toBe("end_turn");

    const reminders = await ofType(convId, "reminder");
    expect(reminders.map((e) => e.payload.text)).toEqual([
      `${TOOLS_UNAVAILABLE_PREFIX}tools-probe__echo (Plugin tools-probe is not enabled in this organization), docs__* (App docs was deleted)`,
    ]);
    const [call] = await ofType(convId, "model_call");
    expect(call?.payload.request.tools).toEqual([]);
    expect(call?.payload.request.reminderSeqs).toEqual([reminders[0]?.seq]);

    // 下一步：不可用情况未变 → 不再写同样的提醒
    await step(agent.definition, convId, runId, 2);
    expect(await ofType(convId, "reminder")).toHaveLength(1);
    expect(await ofType(convId, "assistant_message")).toHaveLength(2);
  });

  it("同一 run 内不可用工具全部恢复：写一条「已恢复」提醒，之后不重复", async () => {
    const res = await createAgent({
      tools: [{ kind: "plugin", plugin: "tools-probe", name: "echo" }],
    });
    const { agent } = res.json() as AgentRes;
    const convId = await conversation(agent.id, "hello");
    const runId = randomUUID();
    await step(agent.definition, convId, runId, 1);
    const enable = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/tools-probe`,
      payload: { enabled: true },
    });
    expect(enable.statusCode, enable.body).toBe(200);
    await step(agent.definition, convId, runId, 2);
    await step(agent.definition, convId, runId, 3);
    const texts = (await ofType(convId, "reminder")).map((e) => e.payload.text);
    expect(texts).toEqual([
      `${TOOLS_UNAVAILABLE_PREFIX}tools-probe__echo (Plugin tools-probe is not enabled in this organization)`,
      TOOLS_AVAILABLE_AGAIN,
    ]);
    const calls = await ofType(convId, "model_call");
    expect(calls.at(-1)?.payload.request.tools?.map((t) => t.key)).toEqual(["tools-probe__echo"]);
  });
});
