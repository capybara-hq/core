import { randomUUID } from "node:crypto";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FakeMcpServer,
  fakeExtensionEntry,
  startFakeMcpServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { KERNEL_MIGRATIONS_DIR, KERNEL_SCHEMA } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createConv,
  createOrgWithProviders,
  enableConnectorExtensions,
  eventsOf,
  postMessage,
  session as runSession,
  runsOf,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";

/** The core fake MCP connector (kind `fake`), for the release-candidate data suites. */
const FAKE_CONNECTOR = fakeExtensionEntry("fake-connector");

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
let tokens: ApiTokenService;
let owner: Account;
let mcp: FakeMcpServer;

const PW = "correct horse battery";
const TOKEN = "tok_secret_value_0123456789";

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
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [MEM_CONNECTOR, MODEL_FAKE, FAKE_CONNECTOR],
      extensionConfig: { "fake-connector": { allowInsecureLoopback: true } },
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  tokens = apiTokensFor(db);
});
afterAll(async () => {
  await k?.close();
  await mcp?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await redis.flushdb();
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const st = memState();
  st.servers = {
    docs: {
      tools: [
        {
          name: "search",
          title: "Search documents",
          description: "Search documents.",
          inputSchema: { type: "object", properties: { q: { type: "string" } } },
          annotations: { readOnlyHint: true },
        },
        {
          name: "delete_doc",
          description: "Delete a document.",
          inputSchema: { type: "object" },
          annotations: { destructiveHint: true },
        },
        { name: "create_doc", description: "Create a document.", inputSchema: { type: "object" } },
      ],
      requireAuth: `Bearer ${TOKEN}`,
    },
    open: {
      tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object" } }],
    },
  };
  st.opened = 0;
  st.closed = 0;
  st.auths = [];
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

async function createOrg(req: Req, name = "Acme", enableKinds = true): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { org: { id: string } }).org.id;
  if (enableKinds) await enableConnectorExtensions(k, id);
  return id;
}

async function memberSession(orgId: string, login: string, role: "admin" | "member" | "guest") {
  const a = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, a.id, role, owner.id);
  return { account: a, req: await session(login) };
}

interface ToolJson {
  name: string;
  key: string;
  status: string;
  defaultPolicy: string;
  specHash: string;
  issue: string | null;
  description: string;
}
interface ConnectorJson {
  id: string;
  slug: string;
  name: string;
  status: string;
  connector: string;
  auth: Record<string, unknown>;
  tools: ToolJson[];
  credential: { ownership: string | null; status: string };
}

const docsConnector = {
  name: "Docs",
  connector: "mem",
  endpoint: { server: "docs" },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: TOKEN },
};

async function createConnector(req: Req, orgId: string, body: Record<string, unknown> = {}) {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/connectors`,
    payload: { ...docsConnector, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { connector: ConnectorJson; issues: { name: string; reason: string }[] };
}

const countRows = async (table: "connectors" | "connector_tools" | "secrets" | "audit_events") =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM ${sql.table(`capybara.${table}`)}`.execute(raw)
    ).rows[0]?.n,
  );

/** 给该连接器的工具写一条「以后都允许」与一条「本会话都允许」授权（需要 agent 与会话）。 */
async function seedGrants(orgId: string, connectorId: string): Promise<void> {
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES ('ag-g', ${orgId}, ${owner.id}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES ('cv-g', ${orgId}, 'ag-g', ${owner.id})`.execute(raw);
  await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash, connector_id)
    VALUES (${orgId}, ${owner.id}, 'ag-g', 'mcp__docs__create_doc', 'h', ${connectorId})`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash, connector_id)
    VALUES ('cv-g', 'mcp__docs__create_doc', 'h', ${connectorId})`.execute(raw);
}

describe("连接器 HTTP", () => {
  it("未登录 → 401", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/connectors`],
      ["POST", `/api/v1/orgs/${orgId}/connectors`],
      ["GET", `/api/v1/orgs/${orgId}/connectors/x`],
    ] as const) {
      const res = await k.http.inject({ method, url, headers: { "x-capybara-csrf": "1" } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("创建：连上并拍工具快照，默认策略按注解推导，会话用后即关，审计不含凭据", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app, issues } = await createConnector(req, orgId);
    expect(issues).toEqual([]);
    expect(app).toMatchObject({
      slug: "docs",
      name: "Docs",
      connector: "mem",
      status: "active",
      auth: { type: "bearer", ownership: "org" },
      credential: { ownership: "org", status: "connected" },
    });
    const byName = Object.fromEntries(app.tools.map((t) => [t.name, t]));
    expect(byName.search).toMatchObject({
      key: "mcp__docs__search",
      // the display-only title of the reviewed definition (the agent page's tool rows)
      title: "Search documents",
      status: "enabled",
      defaultPolicy: "allow",
      issue: null,
    });
    expect(byName.delete_doc).toMatchObject({ key: "mcp__docs__delete_doc", defaultPolicy: "ask" });
    expect(byName.create_doc).toMatchObject({
      key: "mcp__docs__create_doc",
      title: null,
      defaultPolicy: "ask",
    });
    expect(byName.search?.specHash).toMatch(/^[0-9a-f]{16}$/);
    // 用的是请求里带的凭据；会话已关闭
    expect(memState().auths[0]).toEqual({ headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(memState().opened).toBe(1);
    expect(memState().closed).toBe(1);

    const auditRows = await db
      .selectFrom("audit_events")
      .select(["action", "target", "detail"])
      .where("action", "=", "connector.created")
      .execute();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.target).toBe(app.id);
    expect(JSON.stringify(auditRows[0]?.detail)).not.toContain(TOKEN);

    // GET 单个 / 列表
    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${app.id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { connector: ConnectorJson }).connector.tools).toHaveLength(3);
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { connectors: ConnectorJson[] }).connectors.map((a) => a.id)).toEqual([
      app.id,
    ]);
    expect(list.body).not.toContain(TOKEN);
    expect(one.body).not.toContain(TOKEN);
  });

  it("slug：由名称推导；冲突 → 409 connector.slug_taken；不合法 / 推导不出 → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    await createConnector(req, orgId, { name: "My Docs!" }).then(({ connector }) =>
      expect(connector.slug).toBe("my_docs"),
    );
    const dup = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, name: "Other", slug: "my_docs" },
    });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("connector.slug_taken");
    // 冲突时什么都不写
    expect(await countRows("connectors")).toBe(1);

    const bad = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, slug: "Bad-Slug" },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");

    const cjk = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, name: "飞书文档" },
    });
    expect(cjk.statusCode).toBe(400);
    expect(errCode(cjk)).toBe("validation_failed");
    await createConnector(req, orgId, { name: "飞书文档", slug: "feishu" });
  });

  it("member / 服务令牌不能创建；guest 可读", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const { connector: app } = await createConnector(ownerReq, orgId);
    const member = await memberSession(orgId, "mem", "member");
    const res = await member.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, slug: "docs2" },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");

    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const svc = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ...docsConnector, slug: "docs3" },
    });
    expect(svc.statusCode).toBe(403);
    expect(memState().opened).toBe(1);

    const guest = await memberSession(orgId, "gst", "guest");
    const list = await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(list.statusCode).toBe(200);
    const one = await guest.req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
    });
    expect(one.statusCode).toBe(200);

    const outsider = await accounts.createLocal({ login: "out", password: PW, displayName: "o" });
    expect(outsider.id).toBeTruthy();
    const outReq = await session("out");
    const nf = await outReq({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    expect(nf.statusCode).toBe(404);
  });

  it("kinds: only the connector kinds whose extension is enabled in the org; admins only", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq, "Acme", false);
    const url = `/api/v1/orgs/${orgId}/connectors/kinds`;
    const before = await ownerReq({ method: "GET", url });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({ kinds: [] });

    await sql`INSERT INTO capybara.extension_org_configs (plugin, org_id, enabled)
      VALUES ('mem-connector', ${orgId}, true)`.execute(raw);
    const after = await ownerReq({ method: "GET", url });
    expect(after.json()).toEqual({ kinds: [{ kind: "mem", plugin: "mem-connector" }] });

    const member = await memberSession(orgId, "mem", "member");
    const denied = await member.req({ method: "GET", url });
    expect(denied.statusCode).toBe(403);
  });

  it("create and preview refuse a kind whose extension is off in the org", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req, "Acme", false);
    const url = `/api/v1/orgs/${orgId}/connectors`;
    const created = await req({ method: "POST", url, payload: docsConnector });
    expect(created.statusCode, created.body).toBe(409);
    expect(errCode(created)).toBe("connector.kind_unavailable");
    const previewed = await req({
      method: "POST",
      url: `${url}/preview`,
      payload: { connector: "mem", endpoint: { server: "docs" } },
    });
    expect(previewed.statusCode, previewed.body).toBe(409);
    expect(errCode(previewed)).toBe("connector.kind_unavailable");

    await enableConnectorExtensions(k, orgId);
    const ok = await req({ method: "POST", url, payload: docsConnector });
    expect(ok.statusCode, ok.body).toBe(201);
    // a custom connector names no platform connector template (ruling P4-7), in the list too
    expect(ok.json().connector.platformTemplateId).toBeNull();
    const listed = await req({ method: "GET", url });
    expect(
      (listed.json().connectors as { platformTemplateId: string | null }[]).map(
        (c) => c.platformTemplateId,
      ),
    ).toEqual([null]);
  });

  it("A4：连接失败 → 502 connector.connect_failed，什么都不写（含凭据）", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const before = {
      connectors: await countRows("connectors"),
      secrets: await countRows("secrets"),
      audit: await countRows("audit_events"),
    };
    class UpstreamTimeout extends Error {
      override name = "UpstreamTimeout";
    }
    (memState().servers.docs as { fail?: Error }).fail = new UpstreamTimeout(`boom with ${TOKEN}`);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: docsConnector,
    });
    expect(res.statusCode).toBe(502);
    expect(errCode(res)).toBe("connector.connect_failed");
    expect((res.json() as { error: { message: string } }).error.message).toContain(
      "UpstreamTimeout",
    );
    expect(res.body).not.toContain(TOKEN);
    expect(await countRows("connectors")).toBe(before.connectors);
    expect(await countRows("connector_tools")).toBe(0);
    expect(await countRows("secrets")).toBe(before.secrets);
    expect(await countRows("audit_events")).toBe(before.audit);
    expect(memState().closed).toBe(memState().opened);

    // 凭据错误（上游拒绝）同样 502
    delete (memState().servers.docs as { fail?: Error }).fail;
    const wrong = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, credential: { token: "wrong-token-value-xyz" } },
    });
    expect(wrong.statusCode).toBe(502);
    expect(await countRows("connectors")).toBe(0);
  });

  it("需要凭据却没带 → 409 credential.missing；none 不需要凭据；凭据形状不对 → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { credential: _omit, ...noCred } = docsConnector;
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: noCred,
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("credential.missing");
    expect(await countRows("connectors")).toBe(0);

    const badShape = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, credential: { username: "a", password: "b" } },
    });
    expect(badShape.statusCode).toBe(400);
    expect(memState().opened).toBe(1);

    const { connector: app } = await createConnector(req, orgId, {
      name: "Open",
      endpoint: { server: "open" },
      auth: { type: "none" },
      credential: undefined,
    });
    expect(app.credential).toEqual({ ownership: null, status: "connected" });
    expect(app.tools.map((t) => t.key)).toEqual(["mcp__open__ping"]);
  });

  it("未知连接器 / 端点不合法 → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const unknown = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, connector: "nope" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(errCode(unknown)).toBe("validation_failed");
    const badEndpoint = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { ...docsConnector, endpoint: { server: "" } },
    });
    expect(badEndpoint.statusCode).toBe(400);
    const details = (badEndpoint.json() as { error: { details: { path: string }[] } }).error
      .details;
    expect(details.map((d) => d.path)).toContain("endpoint.server");
  });

  it("工具 key 超长或含非法字符：该工具停用并给出原因，不挡住连接器", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    (memState().servers.open as { tools: unknown[] }).tools.push(
      { name: "x".repeat(70), description: "Too long.", inputSchema: { type: "object" } },
      { name: "has space", description: "Bad chars.", inputSchema: { type: "object" } },
    );
    const { connector: app, issues } = await createConnector(req, orgId, {
      name: "Open",
      endpoint: { server: "open" },
      auth: { type: "none" },
      credential: undefined,
    });
    expect(issues.map((i) => i.name).sort()).toEqual(["has space", "x".repeat(70)].sort());
    const bad = app.tools.filter((t) => t.status === "disabled");
    expect(bad).toHaveLength(2);
    for (const t of bad) expect(t.issue).toMatch(/key/i);
    expect(app.tools.find((t) => t.name === "ping")?.status).toBe("enabled");

    // 尝试启用 → 400
    const res = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { tools: { "has space": { status: "enabled" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("PATCH：改名、停用连接器、工具启停与默认策略、批量把无注解工具改为允许", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app } = await createConnector(req, orgId);
    const res = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: {
        name: "Docs 2",
        status: "disabled",
        tools: { search: { status: "disabled" }, delete_doc: { defaultPolicy: "deny" } },
        allowUnannotated: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = (res.json() as { connector: ConnectorJson }).connector;
    expect(updated).toMatchObject({ name: "Docs 2", status: "disabled", slug: "docs" });
    const byName = Object.fromEntries(updated.tools.map((t) => [t.name, t]));
    expect(byName.search?.status).toBe("disabled");
    expect(byName.delete_doc?.defaultPolicy).toBe("deny");
    expect(byName.create_doc?.defaultPolicy).toBe("allow");

    const unknownTool = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { tools: { nope: { status: "enabled" } } },
    });
    expect(unknownTool.statusCode).toBe(400);

    const admin = await memberSession(orgId, "adm", "admin");
    expect(
      (
        await admin.req({
          method: "PATCH",
          url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
          payload: { name: "By admin" },
        })
      ).statusCode,
    ).toBe(200);
    const member = await memberSession(orgId, "mem", "member");
    const denied = await member.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { name: "x" },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      await db
        .selectFrom("audit_events")
        .select("action")
        .where("action", "=", "connector.updated")
        .execute(),
    ).toHaveLength(2);
  });

  it("refresh：走漂移检测（新增 / 变化 → 待复核，旧定义保留；消失 → 停用）", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app } = await createConnector(req, orgId);
    await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { tools: { search: { status: "disabled" } } },
    });
    const srv = memState().servers.docs as { tools: { name: string; description: string }[] };
    srv.tools = srv.tools.filter((t) => t.name !== "create_doc");
    (srv.tools[0] as { description: string }).description = "Search documents, v2.";
    srv.tools.push({
      name: "list_docs",
      description: "List docs.",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    } as never);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/refresh`,
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      connector: ConnectorJson;
      changes: { added: string[]; removed: string[]; changed: string[] };
    };
    expect(body.changes).toEqual({
      added: ["list_docs"],
      removed: ["create_doc"],
      changed: ["search"],
    });
    const byName = Object.fromEntries(body.connector.tools.map((t) => [t.name, t]));
    // 变化：待复核，当前定义仍是旧的（新定义在 pending 里）
    expect(byName.search).toMatchObject({
      status: "pending_review",
      description: "Search documents.",
    });
    expect(byName.search?.specHash).toBe(app.tools.find((t) => t.name === "search")?.specHash);
    expect(byName.list_docs).toMatchObject({ status: "pending_review", defaultPolicy: "allow" });
    expect(byName.create_doc).toMatchObject({ status: "disabled" });
    expect(memState().closed).toBe(memState().opened);

    const member = await memberSession(orgId, "mem", "member");
    expect(
      (
        await member.req({
          method: "POST",
          url: `/api/v1/orgs/${orgId}/connectors/${app.id}/refresh`,
        })
      ).statusCode,
    ).toBe(403);
  });

  it("凭据：组织凭据只有管理员能设；个人凭据接口只影响本人", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: orgApp } = await createConnector(req, orgId);
    const a = await memberSession(orgId, "alice", "member");
    const b = await memberSession(orgId, "bob", "guest");

    const orgCred = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${orgApp.id}/credentials/org`,
      payload: { token: "another-token-123456" },
    });
    expect(orgCred.statusCode).toBe(403);
    const ownerSet = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${orgApp.id}/credentials/org`,
      payload: { token: "another-token-123456" },
    });
    expect(ownerSet.statusCode).toBe(204);
    // 组织凭据型连接器不接受个人凭据
    const wrongOwner = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${orgApp.id}/credentials/me`,
      payload: { token: "personal-token-12345" },
    });
    expect(wrongOwner.statusCode).toBe(400);

    // 个人凭据型连接器：创建者带的是自己的个人凭据
    memState().servers.mine = {
      tools: [{ name: "me", description: "Me.", inputSchema: { type: "object" } }],
    };
    const { connector: app } = await createConnector(req, orgId, {
      name: "Mine",
      endpoint: { server: "mine" },
      auth: { type: "bearer", ownership: "personal" },
      credential: { token: "owner-personal-token-1" },
    });
    expect(app.credential).toEqual({ ownership: "personal", status: "connected" });
    const statusOf = async (r: Req) =>
      (
        (await r({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${app.id}` })).json() as {
          connector: ConnectorJson;
        }
      ).connector.credential.status;
    expect(await statusOf(a.req)).toBe("missing");
    expect(await statusOf(b.req)).toBe("missing");

    const put = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/credentials/me`,
      payload: { token: "alice-personal-token-1" },
    });
    expect(put.statusCode).toBe(204);
    expect(await statusOf(a.req)).toBe("connected");
    expect(await statusOf(b.req)).toBe("missing");
    expect(await statusOf(req)).toBe("connected");

    const del = await a.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/credentials/me`,
    });
    expect(del.statusCode).toBe(204);
    expect(await statusOf(a.req)).toBe("missing");
    expect(await statusOf(req)).toBe("connected");

    const badShape = await b.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/credentials/me`,
      payload: { nope: 1 },
    });
    expect(badShape.statusCode).toBe(400);

    const auditRows = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "like", "connector.credential%")
      .execute();
    expect(auditRows.map((r) => r.action).sort()).toEqual([
      "connector.credential.cleared",
      "connector.credential.set",
      "connector.credential.set",
    ]);
    expect(JSON.stringify(auditRows)).not.toMatch(/token-/);
  });

  it("端点里不能放凭据样式的头 / query 参数 → 400，提示改用凭据设置", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const cases: [Record<string, unknown>, string][] = [
      [{ server: "open", headers: { "X-Api-Key": "k" } }, "endpoint.headers.X-Api-Key"],
      [{ server: "open", headers: { "api-key": "k" } }, "endpoint.headers.api-key"],
      [{ server: "open", headers: { "X-Auth-Token": "k" } }, "endpoint.headers.X-Auth-Token"],
      [{ server: "open", headers: { "X-Client-Secret": "k" } }, "endpoint.headers.X-Client-Secret"],
      [
        { server: "open", headers: { "Proxy-Authorization": "k" } },
        "endpoint.headers.Proxy-Authorization",
      ],
      [{ server: "open", url: "https://h.example/mcp?api_key=k" }, "endpoint.url"],
      [{ server: "open", url: "https://h.example/mcp?Token=k" }, "endpoint.url"],
      [{ server: "open", url: "https://h.example/mcp?access_token=k" }, "endpoint.url"],
      [{ server: "open", url: "https://user:pw@h.example/mcp" }, "endpoint.url"],
    ];
    for (const [endpoint, path] of cases) {
      const res = await req({
        method: "POST",
        url: `/api/v1/orgs/${orgId}/connectors`,
        payload: { name: "Open", connector: "mem", endpoint, auth: { type: "none" } },
      });
      expect(res.statusCode, JSON.stringify(endpoint)).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
      const details = (res.json() as { error: { details: { path: string; message: string }[] } })
        .error.details;
      expect(details).toEqual([{ path, message: expect.stringContaining("credential settings") }]);
    }
    expect(await countRows("connectors")).toBe(0);
  });

  it("端点的固定头值与 URL query 只对 connectors.manage 可见：其他人只看到 URL 的源（路径打码）与头名", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app } = await createConnector(req, orgId, {
      name: "Open",
      endpoint: {
        server: "open",
        url: "https://h.example/mcp?tenant=acme-hidden",
        headers: { "X-Tenant": "acme-hidden" },
      },
      auth: { type: "none" },
      credential: undefined,
    });
    expect(app).toMatchObject({
      endpoint: {
        url: "https://h.example/mcp?tenant=acme-hidden",
        headers: { "X-Tenant": "acme-hidden" },
      },
    });
    const ownerOne = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
    });
    expect(ownerOne.body).toContain("acme-hidden");

    const guest = await memberSession(orgId, "gst", "guest");
    const one = await guest.req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
    });
    const list = await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors` });
    for (const res of [one, list]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("acme-hidden");
    }
    expect((one.json() as { connector: { endpoint: unknown } }).connector.endpoint).toEqual({
      server: "open",
      url: "https://h.example/…",
      headerNames: ["X-Tenant"],
    });
    expect(
      (list.json() as { connectors: { endpoint: unknown }[] }).connectors[0]?.endpoint,
    ).toEqual({
      server: "open",
      url: "https://h.example/…",
      headerNames: ["X-Tenant"],
    });
  });

  it("DELETE：软删后 404 connector.not_found，凭据一并清除，slug 可复用", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app } = await createConnector(req, orgId);
    const member = await memberSession(orgId, "mem", "member");
    expect(
      (await member.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${app.id}` }))
        .statusCode,
    ).toBe(403);
    await seedGrants(orgId, app.id);
    const del = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/connectors/${app.id}` });
    expect(del.statusCode).toBe(204);
    const get = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/connectors/${app.id}` });
    expect(get.statusCode).toBe(404);
    expect(errCode(get)).toBe("connector.not_found");
    const secrets = await db
      .selectFrom("secrets")
      .select("key")
      .where("key", "like", `credentials:app:${app.id}:%`)
      .execute();
    expect(secrets).toEqual([]);
    // 绑定该连接器的授权一并删除（同 slug 重新安装的连接器不继承）
    expect(await db.selectFrom("tool_grants").selectAll().execute()).toEqual([]);
    expect(await db.selectFrom("conversation_tool_grants").selectAll().execute()).toEqual([]);
    await createConnector(req, orgId);
    // 另一个组织看不到本组织的连接器
    const other = await createOrg(req, "Other");
    const cross = await req({ method: "GET", url: `/api/v1/orgs/${other}/connectors/${app.id}` });
    expect(cross.statusCode).toBe(404);
  });
});

describe("a member's own tool policies (the card's 权限, decision 2026-11-09)", () => {
  type Row = {
    name: string;
    defaultPolicy: string;
    annotationPolicy: string;
    policy: string | null;
    locked: string | null;
  };
  it("each account reads and writes only its own settings on a personal connector", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const a = await memberSession(orgId, "alice", "member");
    const b = await memberSession(orgId, "bob", "member");
    const { connector: app } = await createConnector(req, orgId, {
      auth: { type: "bearer", ownership: "personal" },
      credential: { token: TOKEN },
    });
    const url = `/api/v1/orgs/${orgId}/connectors/${app.id}/tool-policies/me`;
    const read = async (r: Req) => {
      const res = await r({ method: "GET", url });
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as { tools: Row[] }).tools;
    };
    // defaults by annotations: read-only allows, destructive and unannotated ask
    const before = await read(a.req);
    expect(before.map((t) => [t.name, t.annotationPolicy, t.defaultPolicy, t.policy])).toEqual([
      ["create_doc", "ask", "ask", null],
      ["delete_doc", "ask", "ask", null],
      ["search", "allow", "allow", null],
    ]);
    const put = await a.req({
      method: "PUT",
      url,
      payload: { tools: { delete_doc: "deny", search: "ask" } },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect((await read(a.req)).map((t) => t.policy)).toEqual([null, "deny", "ask"]);
    // bob's sheet is untouched; his write never reaches alice's rows
    expect((await read(b.req)).map((t) => t.policy)).toEqual([null, null, null]);
    await b.req({ method: "PUT", url, payload: { tools: { search: "allow" } } });
    expect((await read(a.req)).map((t) => t.policy)).toEqual([null, "deny", "ask"]);
    // null clears
    await a.req({ method: "PUT", url, payload: { tools: { search: null } } });
    expect((await read(a.req)).map((t) => t.policy)).toEqual([null, "deny", null]);
    // an org lock shows: the admin switches create_doc off and sets search to deny
    const off = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}`,
      payload: { tools: { create_doc: { status: "disabled" }, search: { defaultPolicy: "deny" } } },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect((await read(a.req)).map((t) => t.locked)).toEqual(["disabled", null, "org_deny"]);
    // unknown tool, and a body that is not a policy
    const unknown = await a.req({ method: "PUT", url, payload: { tools: { nope: "allow" } } });
    expect(unknown.statusCode).toBe(404);
    expect(errCode(unknown)).toBe("connector.tool_not_found");
    const bad = await a.req({ method: "PUT", url, payload: { tools: { search: "always" } } });
    expect(bad.statusCode).toBe(400);
    const audits = await db
      .selectFrom("audit_events")
      .select(["actor_account_id"])
      .where("action", "=", "connector.member_policies_changed")
      .execute();
    expect(audits.map((x) => x.actor_account_id).sort()).toEqual(
      [a.account.id, a.account.id, b.account.id].sort(),
    );
  });

  it("a connector with one org credential has none: 409 connector.not_personal; another org's: 404", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector: app } = await createConnector(req, orgId);
    const res = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/connectors/${app.id}/tool-policies/me`,
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("connector.not_personal");
    const other = await createOrg(req, "Other");
    const cross = await req({
      method: "GET",
      url: `/api/v1/orgs/${other}/connectors/${app.id}/tool-policies/me`,
    });
    expect(cross.statusCode).toBe(404);
  });
});

describe("the connector routes after the rename (T22)", () => {
  it("/connectors works; the old /apps paths are all 404 (no alias)", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { connector } = await createConnector(req, orgId);
    const id = connector.id;
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
  });
});

/**
 * Tool naming spec §8: release-candidate data after the upgrade. Mutable state (grants, pending
 * approvals and questions) is rewritten by migration 0063; agent versions and templates by
 * migration 0139 (no compatibility before 0.1.0: the kernel reads only current keys), which also
 * deletes the grants 0063 could not map. Saving an old key is refused.
 */
const MIGRATION = "0063_tool_keys_claude_code.sql";
const RETIRE = "0139_retire_legacy_forms.sql";

describe("release-candidate tool keys in stored data", () => {
  let req: Req;
  let ownerId: string;
  let orgA: string;
  let orgB: string;
  let docsId: string;

  beforeEach(async () => {
    ownerId = (
      await accountsFor(db).createLocal({ login: "legacy", password: PW, displayName: "O" })
    ).id;
    req = await runSession(k, "legacy");
    orgA = await createOrgWithProviders(k, req, "A");
    orgB = await createOrgWithProviders(k, req, "B");
    await enableConnectorExtensions(k, orgA);
    await enableConnectorExtensions(k, orgB);
    docsId = await install(orgA, "docs");
    await install(orgB, "todo");
    // the deployment has an extension named `todo` (an rc key `todo__write` was its tool)
    await db
      .insertInto("extension_name_owners")
      .values({ name: "todo", package_name: "@example/plugin-todo" })
      .onConflict((oc) => oc.doNothing())
      .execute();
  });

  async function install(orgId: string, slug: string): Promise<string> {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: {
        name: `Docs ${slug}`,
        slug,
        connector: "fake",
        endpoint: { url: mcp.url },
        auth: { type: "none" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { connector: { id: string } }).connector.id;
  }

  /**
   * Runs migration `name` again, as on a database that has the rc rows and not the migration. The
   * migrator refuses a migration numbered below an applied one, so the later migrations' records
   * are set aside while it runs (from a directory that ends at `name`) and put back afterwards.
   */
  async function rerunMigration(name = MIGRATION): Promise<string[]> {
    await sql`delete from capybara._migrations where name = ${name}`.execute(raw);
    const later = await sql<{ name: string; checksum: string; applied_at: Date }>`
      select name, checksum, applied_at from capybara._migrations where name > ${name}`.execute(
      raw,
    );
    await sql`delete from capybara._migrations where name > ${name}`.execute(raw);
    const upTo = mkdtempSync(join(tmpdir(), "cap-mig-rerun-"));
    try {
      for (const f of readdirSync(KERNEL_MIGRATIONS_DIR)) {
        if (f.endsWith(".sql") && f <= name) {
          copyFileSync(join(KERNEL_MIGRATIONS_DIR, f), join(upTo, f));
        }
      }
      return (await migrate(pgc.url, { schema: KERNEL_SCHEMA, dir: upTo })).applied;
    } finally {
      for (const r of later.rows) {
        await sql`insert into capybara._migrations (name, checksum, applied_at)
          values (${r.name}, ${r.checksum}, ${r.applied_at})`.execute(raw);
      }
      rmSync(upTo, { recursive: true, force: true });
    }
  }

  it("migration 0063 rewrites grants, pending approvals and questions; 0139 deletes the grants it could not map", async () => {
    const agentA = await createAgent(req, orgA);
    const agentB = await createAgent(req, orgB);
    const conv = await createConv(req, orgA, agentA);
    await postMessage(req, orgA, conv, "hello");
    await waitForTerminal(db, conv, 1, 20_000);
    const runId = (await runsOf(db, conv))[0]?.id as string;

    const grant = (
      orgId: string,
      agentId: string,
      toolKey: string,
      connectorId: string | null,
    ) => ({
      org_id: orgId,
      account_id: ownerId,
      agent_id: agentId,
      tool_key: toolKey,
      spec_hash: "h",
      connector_id: connectorId,
    });
    await db
      .insertInto("tool_grants")
      .values([
        grant(orgA, agentA, "sandbox_bash", null),
        grant(orgA, agentA, "docs__search", docsId),
        grant(orgA, agentA, "todo__write", null),
        grant(orgA, agentA, "nope__thing", null),
        grant(orgA, agentA, "mcp__docs__other", docsId),
        grant(orgB, agentB, "todo__x", null),
      ])
      .execute();
    await db
      .insertInto("conversation_tool_grants")
      .values([
        { conversation_id: conv, tool_key: "sandbox_read", spec_hash: "h", connector_id: null },
        // no connector id recorded: the slug of the conversation's org decides
        { conversation_id: conv, tool_key: "docs__search", spec_hash: "h", connector_id: null },
      ])
      .execute();
    const approval = (callId: string, toolKey: string, status: "pending" | "approved") => ({
      id: randomUUID(),
      org_id: orgA,
      conversation_id: conv,
      run_id: runId,
      call_id: callId,
      tool_key: toolKey,
      input: JSON.stringify({ path: "/a.txt" }),
      requested_for: ownerId,
      approver_role: null,
      status,
      expires_at: new Date(Date.now() + 3_600_000),
      spec_hash: "h",
      connector_id: null,
    });
    await db
      .insertInto("approvals")
      .values([
        approval("c1", "sandbox_edit", "pending"),
        approval("c2", "sandbox_bash", "approved"),
      ])
      .execute();
    const question = (callId: string, toolKey: string, status: "pending" | "answered") => ({
      id: randomUUID(),
      org_id: orgA,
      conversation_id: conv,
      run_id: runId,
      call_id: callId,
      spec: JSON.stringify({ form: {}, state: null, toolKey, step: 1 }),
      status,
      answer: null,
      answered_by: null,
      expires_at: new Date(Date.now() + 3_600_000),
    });
    await db
      .insertInto("questions")
      .values([question("q1", "docs__search", "pending"), question("q2", "ask_user", "answered")])
      .execute();

    expect(await rerunMigration()).toEqual([MIGRATION]);

    const grants = async () =>
      (
        await db
          .selectFrom("tool_grants")
          .select(["org_id", "tool_key"])
          .where("org_id", "in", [orgA, orgB])
          .orderBy("org_id")
          .orderBy("tool_key")
          .execute()
      ).map((r) => `${r.org_id === orgA ? "A" : "B"}:${r.tool_key}`);
    const expected = [
      "A:Bash",
      "A:mcp__docs__other",
      "A:mcp__docs__search",
      "A:nope__thing",
      "A:plugin__todo__write",
      "B:todo__x",
    ].sort();
    expect((await grants()).sort()).toEqual(expected);
    const convGrants = async () =>
      (
        await db
          .selectFrom("conversation_tool_grants")
          .select("tool_key")
          .where("conversation_id", "=", conv)
          .execute()
      )
        .map((r) => r.tool_key)
        .sort();
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
    const approvals = await db
      .selectFrom("approvals")
      .select(["call_id", "tool_key"])
      .where("conversation_id", "=", conv)
      .orderBy("call_id")
      .execute();
    // decided approvals are history and stay
    expect(approvals).toEqual([
      { call_id: "c1", tool_key: "Edit" },
      { call_id: "c2", tool_key: "sandbox_bash" },
    ]);
    const questions = await db
      .selectFrom("questions")
      .select(["call_id", "spec"])
      .where("conversation_id", "=", conv)
      .orderBy("call_id")
      .execute();
    expect(questions.map((q) => [q.call_id, (q.spec as { toolKey: string }).toolKey])).toEqual([
      ["q1", "mcp__docs__search"],
      ["q2", "ask_user"],
    ]);

    // a pending approval for sandbox_edit shows Edit in the inbox
    const list = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgA}/approvals?status=pending`,
    });
    expect(list.statusCode, list.body).toBe(200);
    expect(
      (list.json() as { approvals: { callId: string; toolKey: string }[] }).approvals.map((a) => [
        a.callId,
        a.toolKey,
      ]),
    ).toEqual([["c1", "Edit"]]);

    // idempotent: a second run changes nothing
    expect(await rerunMigration()).toEqual([MIGRATION]);
    expect((await grants()).sort()).toEqual(expected);
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);

    // 0139: the rows 0063 could not map (nope__thing, the ambiguous todo__x) name no tool and go
    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    expect((await grants()).sort()).toEqual(
      expected.filter((g) => g !== "A:nope__thing" && g !== "B:todo__x"),
    );
    expect(await convGrants()).toEqual(["Read", "mcp__docs__search"]);
  });

  it("migration 0139 rewrites rc keys in agent versions and templates; the agent runs with them", async () => {
    const created = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgA}/agents`,
      payload: {
        definition: {
          name: "Legacy",
          instructions: "Be helpful.",
          model: { provider: "model-fake", model: "fake-1" },
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
    // an rc version: old builtin and connector policy keys, an ambiguous key (`todo` is both an
    // extension of the deployment and, in org B only, a connector: here only an extension), the
    // removed skill_write, and an inline template
    const current = stored.definition as Record<string, unknown>;
    await db
      .updateTable("agent_versions")
      .set({
        definition: JSON.stringify({
          ...current,
          toolPolicies: {
            sandbox_bash: "deny",
            docs__search: "ask",
            todo__write: "ask",
            skill_write: "deny",
            Read: "ask",
          },
          subagents: {
            inline: [
              {
                name: "reader",
                description: "Reads files",
                instructions: "Read what you are asked to.",
                tools: ["sandbox_read", "Read", "nope__x"],
                disallowedTools: ["docs__search"],
              },
            ],
          },
        }),
      })
      .where("agent_id", "=", agentId)
      .execute();
    // an org template with rc keys
    const tpl = { id: randomUUID() };
    await db
      .insertInto("agent_templates")
      .values({ id: tpl.id, org_id: orgA, name: "rc-template", current_version: 1 } as never)
      .execute();
    await db
      .insertInto("agent_template_versions")
      .values({
        template_id: tpl.id,
        version: 1,
        definition: JSON.stringify({
          name: "rc-template",
          description: "d",
          instructions: "i",
          tools: ["sandbox_read", "docs__search"],
          toolPolicies: { ask_user: "ask" },
          subagents: {
            inline: [
              {
                name: "helper",
                description: "d",
                instructions: "i",
                tools: ["sandbox_grep"],
                disallowedTools: ["docs__search"],
                toolPolicies: { sandbox_bash: "deny" },
              },
            ],
          },
        }),
      } as never)
      .execute();
    // a platform template (no org: only extension names resolve) with an inline sub-agent
    const ptpl = { id: randomUUID() };
    await db
      .insertInto("platform_agent_templates")
      .values({ id: ptpl.id, name: "rc-platform-template", current_version: 1 } as never)
      .execute();
    await db
      .insertInto("platform_agent_template_versions")
      .values({
        template_id: ptpl.id,
        version: 1,
        definition: JSON.stringify({
          name: "rc-platform-template",
          description: "d",
          instructions: "i",
          tools: ["sandbox_read", "docs__search"],
          subagents: {
            inline: [
              {
                name: "helper",
                description: "d",
                instructions: "i",
                tools: ["sandbox_glob", "todo__write"],
                toolPolicies: { ask_user: "deny", todo__write: "ask" },
              },
            ],
          },
        }),
      } as never)
      .execute();

    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    const after = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .executeTakeFirstOrThrow();
    const def = after.definition as Record<string, unknown>;
    expect(def.toolPolicies).toEqual({
      Bash: "deny",
      mcp__docs__search: "ask",
      plugin__todo__write: "ask",
      Read: "ask",
    });
    expect(def.subagents).toMatchObject({
      inline: [
        { name: "reader", tools: ["Read", "nope__x"], disallowedTools: ["mcp__docs__search"] },
      ],
    });
    expect(def.instructions).toBe(current.instructions);
    const tplAfter = await db
      .selectFrom("agent_template_versions")
      .select("definition")
      .where("template_id", "=", tpl.id)
      .executeTakeFirstOrThrow();
    expect(tplAfter.definition).toMatchObject({
      tools: ["Read", "mcp__docs__search"],
      toolPolicies: { AskUserQuestion: "ask" },
      subagents: {
        inline: [
          {
            name: "helper",
            tools: ["Grep"],
            disallowedTools: ["mcp__docs__search"],
            toolPolicies: { Bash: "deny" },
          },
        ],
      },
    });
    const ptplAfter = await db
      .selectFrom("platform_agent_template_versions")
      .select("definition")
      .where("template_id", "=", ptpl.id)
      .executeTakeFirstOrThrow();
    // no org connectors: `docs` stays as it is (inert), `todo` is an extension of the deployment
    expect(ptplAfter.definition).toMatchObject({
      tools: ["Read", "docs__search"],
      subagents: {
        inline: [
          {
            name: "helper",
            tools: ["Glob", "plugin__todo__write"],
            toolPolicies: { AskUserQuestion: "deny", plugin__todo__write: "ask" },
          },
        ],
      },
    });
    // idempotent: a second run leaves the rows as they are
    await db
      .insertInto("audit_events")
      .values([
        { org_id: orgA, action: "app.created", target: "c-1", detail: "{}" },
        { org_id: orgA, action: "app.credential.cleared", target: "c-1", detail: "{}" },
        { org_id: orgA, action: "app.installed", target: "x", detail: "{}" },
      ] as never)
      .execute();
    expect(await rerunMigration(RETIRE)).toEqual([RETIRE]);
    // connector actions written before the D17 rename take their current names; an `app.` action
    // that was never a connector's stays
    const actions = await db
      .selectFrom("audit_events")
      .select("action")
      .where("org_id", "=", orgA)
      .where("target", "in", ["c-1", "x"])
      .orderBy("id")
      .execute();
    expect(actions.map((r) => r.action)).toEqual([
      "connector.created",
      "connector.credential.cleared",
      "app.installed",
    ]);
    expect(
      (
        await db
          .selectFrom("agent_versions")
          .select("definition")
          .where("agent_id", "=", agentId)
          .executeTakeFirstOrThrow()
      ).definition,
    ).toEqual(after.definition);

    const got = await req({ method: "GET", url: `/api/v1/orgs/${orgA}/agents/${agentId}` });
    expect(got.statusCode, got.body).toBe(200);
    // runs: the rewritten `ask` policy applies to the connector tool (its default is allow)
    const conv = await createConv(req, orgA, agentId);
    await postMessage(req, orgA, conv, 'tool:mcp__docs__search:{"q":"x"}');
    const asked = await waitFor(
      async () => (await eventsOf(db, conv)).find((e) => e.type === "approval_requested") ?? null,
      20_000,
      "approval_requested",
    );
    expect(asked.payload).toMatchObject({ toolKey: "mcp__docs__search" });
  });

  it("saving a definition with an rc key is 400 validation_failed", async () => {
    const save = (definition: Record<string, unknown>) =>
      req({
        method: "POST",
        url: `/api/v1/orgs/${orgA}/agents`,
        payload: {
          definition: {
            name: "Old",
            instructions: "",
            model: { provider: "model-fake", model: "fake-1" },
            ...definition,
          },
          visibility: "org",
        },
      });
    const builtin = await save({ disabledTools: [{ kind: "builtin", name: "sandbox_bash" }] });
    expect(builtin.statusCode, builtin.body).toBe(400);
    expect(builtin.json()).toMatchObject({ error: { code: "validation_failed" } });

    const policy = await save({
      toolPolicies: { sandbox_read: "ask", docs__search: "deny" },
    });
    expect(policy.statusCode, policy.body).toBe(400);
    expect(policy.json()).toMatchObject({ error: { code: "validation_failed" } });

    const inline = await save({
      subagents: {
        inline: [{ name: "r", description: "d", instructions: "i", tools: ["sandbox_read"] }],
      },
    });
    expect(inline.statusCode, inline.body).toBe(400);
  });
});
