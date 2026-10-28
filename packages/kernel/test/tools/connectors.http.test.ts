import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;
let owner: Account;

const PW = "correct horse battery";
const TOKEN = "tok_secret_value_0123456789";

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [MEM_CONNECTOR],
      extensionPermissions: { autoApprove: true },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  tokens = apiTokensFor(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
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

async function createOrg(req: Req, name = "Acme"): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
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
    VALUES (${orgId}, ${owner.id}, 'ag-g', 'docs__create_doc', 'h', ${connectorId})`.execute(raw);
  await sql`INSERT INTO capybara.conversation_tool_grants (conversation_id, tool_key, spec_hash, connector_id)
    VALUES ('cv-g', 'docs__create_doc', 'h', ${connectorId})`.execute(raw);
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
      key: "docs__search",
      status: "enabled",
      defaultPolicy: "allow",
      issue: null,
    });
    expect(byName.delete_doc).toMatchObject({ key: "docs__delete_doc", defaultPolicy: "ask" });
    expect(byName.create_doc).toMatchObject({ key: "docs__create_doc", defaultPolicy: "ask" });
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
    expect(app.tools.map((t) => t.key)).toEqual(["open__ping"]);
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
