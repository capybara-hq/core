import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { BUILTIN_TOOL_KINDS, type ToolInfo } from "../../src/tools/info.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

// Tool presentation metadata for the conversation page (UI refresh B, Task 4):
// GET /orgs/:orgId/conversations/:id/tools?keys=… -> titles, kinds, key arguments and sources.

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let owner: Account;

const PW = "correct horse battery";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      roles: ["api"],
      ...MODEL_PLUGINS_CONFIG,
      extensions: [...MODEL_PLUGINS_CONFIG.extensions, MEM_CONNECTOR],
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
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
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  memState().servers = {
    slack: {
      tools: [
        {
          name: "search",
          title: "Search messages",
          keyArgs: ["query", "channel"],
          description: "Search messages.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string" }, channel: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
        { name: "post", description: "Post a message.", inputSchema: { type: "object" } },
      ],
    },
  };
});

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;

type Req = ReturnType<typeof asUser>;

async function session(login: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

async function setup(): Promise<{ req: Req; orgId: string; conversationId: string }> {
  const req = await session("owner");
  const org = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(org.statusCode).toBe(201);
  const orgId = (org.json() as { org: { id: string } }).org.id;
  const agent = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
      },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  const agentId = (agent.json() as { agent: { id: string } }).agent.id;
  const conv = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/conversations`,
    payload: { agentId },
  });
  expect(conv.statusCode).toBe(201);
  return {
    req,
    orgId,
    conversationId: (conv.json() as { conversation: { id: string } }).conversation.id,
  };
}

async function tools(req: Req, orgId: string, conversationId: string, keys: string[]) {
  return req({
    method: "GET",
    url: `/api/v1/orgs/${orgId}/conversations/${conversationId}/tools?keys=${encodeURIComponent(keys.join(","))}`,
  });
}

const byKey = (res: { json(): unknown }) =>
  Object.fromEntries((res.json() as { tools: ToolInfo[] }).tools.map((t) => [t.key, t]));

describe("tool kinds", () => {
  it("map every builtin per the table, and nothing else", () => {
    expect(BUILTIN_TOOL_KINDS).toEqual({
      sandbox_bash: "command",
      sandbox_read: "read",
      sandbox_write: "edit",
      sandbox_edit: "edit",
      sandbox_glob: "search",
      sandbox_grep: "search",
      sandbox_deliver: "tool",
      tool_search: "meta",
      skill_load: "meta",
      skill_write: "meta",
      read_tool_output: "meta",
      ask_user: "meta",
    });
  });
});

describe("GET /conversations/:id/tools", () => {
  it("builtins: kind and key arguments, no title, source builtin", async () => {
    const { req, orgId, conversationId } = await setup();
    const res = await tools(req, orgId, conversationId, [
      "sandbox_bash",
      "sandbox_read",
      "sandbox_write",
      "sandbox_edit",
      "sandbox_glob",
      "sandbox_grep",
      "sandbox_deliver",
      "skill_load",
      "tool_search",
      "ask_user",
      "agent",
    ]);
    expect(res.statusCode, res.body).toBe(200);
    const t = byKey(res);
    expect(t.sandbox_bash).toEqual({
      key: "sandbox_bash",
      title: null,
      kind: "command",
      keyArgs: ["command"],
      source: { kind: "builtin" },
    });
    expect(t.sandbox_read?.keyArgs).toEqual(["path"]);
    expect(t.sandbox_write).toMatchObject({ kind: "edit", keyArgs: ["path"] });
    expect(t.sandbox_edit).toMatchObject({ kind: "edit", keyArgs: ["path"] });
    expect(t.sandbox_glob).toMatchObject({ kind: "search", keyArgs: ["pattern"] });
    expect(t.sandbox_grep).toMatchObject({ kind: "search", keyArgs: ["pattern", "path"] });
    expect(t.sandbox_deliver).toMatchObject({ kind: "tool", keyArgs: ["path"] });
    expect(t.skill_load).toMatchObject({ kind: "meta", keyArgs: ["name"] });
    expect(t.tool_search).toMatchObject({ kind: "meta", keyArgs: ["query"] });
    expect(t.ask_user).toMatchObject({ kind: "meta", keyArgs: [], title: null });
    // a sub-agent's task name, then its type (the page shows agent calls as sub-agent rows)
    expect(t.agent).toMatchObject({ kind: "tool", keyArgs: ["description", "subagent_type"] });
  });

  it("a connector tool returns its MCP title and key arguments, named by the connector", async () => {
    const { req, orgId, conversationId } = await setup();
    const inst = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Acme Chat",
        slug: "chat",
        connector: "mem",
        endpoint: { server: "slack" },
        auth: { type: "none" },
      },
    });
    expect(inst.statusCode, inst.body).toBe(201);
    const connectorId = (inst.json() as { connector: { id: string } }).connector.id;
    const res = await tools(req, orgId, conversationId, ["chat__search", "chat__post"]);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { tools: ToolInfo[] }).tools).toEqual([
      {
        key: "chat__search",
        title: "Search messages",
        kind: "connector",
        keyArgs: ["query", "channel"],
        source: { kind: "connector", id: connectorId, name: "Acme Chat" },
      },
      {
        key: "chat__post",
        title: null,
        kind: "connector",
        keyArgs: [],
        source: { kind: "connector", id: connectorId, name: "Acme Chat" },
      },
    ]);
  });

  it("titles come from the connector's current tool, never from tool_specs", async () => {
    // tool_specs keeps the first spec stored under a hash; display must not read a stale title there.
    const { req, orgId, conversationId } = await setup();
    const inst = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: "Acme Chat",
        slug: "chat",
        connector: "mem",
        endpoint: { server: "slack" },
        auth: { type: "none" },
      },
    });
    expect(inst.statusCode, inst.body).toBe(201);
    const connectorId = (inst.json() as { connector: { id: string } }).connector.id;
    const row = await db
      .selectFrom("connector_tools")
      .select(["spec_hash", "spec"])
      .where("connector_id", "=", connectorId)
      .where("name", "=", "search")
      .executeTakeFirstOrThrow();
    const stale = JSON.stringify({ ...(row.spec as object), title: "Stale title" });
    await db
      .insertInto("tool_specs")
      .values({ spec_hash: row.spec_hash, spec: stale })
      .onConflict((oc) => oc.column("spec_hash").doUpdateSet({ spec: stale }))
      .execute();
    const res = await tools(req, orgId, conversationId, ["chat__search"]);
    expect(res.statusCode, res.body).toBe(200);
    expect(byKey(res).chat__search?.title).toBe("Search messages");
  });

  it("an extension tool returns its registration's title and key arguments", async () => {
    const { req, orgId, conversationId } = await setup();
    const res = await tools(req, orgId, conversationId, ["mem-connector__echo"]);
    expect(res.statusCode, res.body).toBe(200);
    expect(byKey(res)["mem-connector__echo"]).toEqual({
      key: "mem-connector__echo",
      title: "Echo",
      kind: "tool",
      keyArgs: ["text"],
      source: { kind: "extension", name: "mem-connector" },
    });
  });

  it("an unknown key comes back as a plain tool; repeated keys once, in request order", async () => {
    const { req, orgId, conversationId } = await setup();
    const res = await tools(req, orgId, conversationId, [
      "nope__x",
      "mystery",
      "ask_user",
      "nope__x",
    ]);
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as { tools: ToolInfo[] }).tools).toEqual([
      { key: "nope__x", title: null, kind: "tool", keyArgs: [], source: { kind: "unknown" } },
      { key: "mystery", title: null, kind: "tool", keyArgs: [], source: { kind: "unknown" } },
      expect.objectContaining({ key: "ask_user", kind: "meta" }),
    ]);
  });

  it("another user's conversation -> 404; bad keys -> 400; service token -> 403", async () => {
    const { req, orgId, conversationId } = await setup();
    const other = await accounts.createLocal({ login: "mem", password: PW, displayName: "M" });
    await members.add(orgId, other.id, "member", owner.id);
    const m = await session("mem");
    const hidden = await tools(m, orgId, conversationId, ["ask_user"]);
    expect(hidden.statusCode).toBe(404);
    expect(errCode(hidden)).toBe("conversation.not_found");
    const notUuid = await tools(req, orgId, "not-a-uuid", ["ask_user"]);
    expect(notUuid.statusCode).toBe(404);
    expect(errCode(notUuid)).toBe("conversation.not_found");

    const many = Array.from({ length: 101 }, (_, i) => `k${i}`);
    for (const bad of [many, ["x".repeat(201)], [""]]) {
      const res = await tools(req, orgId, conversationId, bad);
      expect(res.statusCode).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
    const none = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conversationId}/tools`,
    });
    expect(none.statusCode).toBe(400);
    expect((await tools(req, orgId, conversationId, many.slice(0, 100))).statusCode).toBe(200);

    const { token } = await apiTokensFor(db).createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const svc = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/conversations/${conversationId}/tools?keys=ask_user`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(svc.statusCode).toBe(403);
    expect(errCode(svc)).toBe("forbidden");
  });
});
