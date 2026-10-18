import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { MembersService } from "../../src/orgs/members.service.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { asUser, cookieJar } from "../helpers/http.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
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
      http: { port: 0 },
      plugins: [MEM_CONNECTOR],
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = new MembersService(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events CASCADE`.execute(raw);
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
interface AppJson {
  id: string;
  slug: string;
  name: string;
  status: string;
  connector: string;
  auth: Record<string, unknown>;
  tools: ToolJson[];
  credential: { ownership: string | null; status: string };
}

const docsApp = {
  name: "Docs",
  connector: "mem",
  endpoint: { server: "docs" },
  auth: { type: "bearer", ownership: "org" },
  credential: { token: TOKEN },
};

async function createApp(req: Req, orgId: string, body: Record<string, unknown> = {}) {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/apps`,
    payload: { ...docsApp, ...body },
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json() as { app: AppJson; issues: { name: string; reason: string }[] };
}

const countRows = async (table: "apps" | "app_tools" | "secrets" | "audit_events") =>
  Number(
    (
      await sql<{
        n: string;
      }>`SELECT count(*)::text AS n FROM ${sql.table(`capybara.${table}`)}`.execute(raw)
    ).rows[0]?.n,
  );

describe("应用 HTTP", () => {
  it("未登录 → 401", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/apps`],
      ["POST", `/api/v1/orgs/${orgId}/apps`],
      ["GET", `/api/v1/orgs/${orgId}/apps/x`],
    ] as const) {
      const res = await k.http.inject({ method, url, headers: { "x-capybara-csrf": "1" } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("创建：连上并拍工具快照，默认策略按注解推导，会话用后即关，审计不含凭据", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { app, issues } = await createApp(req, orgId);
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
      .where("action", "=", "app.created")
      .execute();
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.target).toBe(app.id);
    expect(JSON.stringify(auditRows[0]?.detail)).not.toContain(TOKEN);

    // GET 单个 / 列表
    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/apps/${app.id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { app: AppJson }).app.tools).toHaveLength(3);
    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/apps` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { apps: AppJson[] }).apps.map((a) => a.id)).toEqual([app.id]);
    expect(list.body).not.toContain(TOKEN);
    expect(one.body).not.toContain(TOKEN);
  });

  it("slug：由名称推导；冲突 → 409 app.slug_taken；不合法 / 推导不出 → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    await createApp(req, orgId, { name: "My Docs!" }).then(({ app }) =>
      expect(app.slug).toBe("my_docs"),
    );
    const dup = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, name: "Other", slug: "my_docs" },
    });
    expect(dup.statusCode).toBe(409);
    expect(errCode(dup)).toBe("app.slug_taken");
    // 冲突时什么都不写
    expect(await countRows("apps")).toBe(1);

    const bad = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, slug: "Bad-Slug" },
    });
    expect(bad.statusCode).toBe(400);
    expect(errCode(bad)).toBe("validation_failed");

    const cjk = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, name: "飞书文档" },
    });
    expect(cjk.statusCode).toBe(400);
    expect(errCode(cjk)).toBe("validation_failed");
    await createApp(req, orgId, { name: "飞书文档", slug: "feishu" });
  });

  it("member / 服务令牌不能创建；guest 可读", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const { app } = await createApp(ownerReq, orgId);
    const member = await memberSession(orgId, "mem", "member");
    const res = await member.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, slug: "docs2" },
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
      url: `/api/v1/orgs/${orgId}/apps`,
      headers: { authorization: `Bearer ${token}` },
      payload: { ...docsApp, slug: "docs3" },
    });
    expect(svc.statusCode).toBe(403);
    expect(memState().opened).toBe(1);

    const guest = await memberSession(orgId, "gst", "guest");
    const list = await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/apps` });
    expect(list.statusCode).toBe(200);
    const one = await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/apps/${app.id}` });
    expect(one.statusCode).toBe(200);

    const outsider = await accounts.createLocal({ login: "out", password: PW, displayName: "o" });
    expect(outsider.id).toBeTruthy();
    const outReq = await session("out");
    const nf = await outReq({ method: "GET", url: `/api/v1/orgs/${orgId}/apps` });
    expect(nf.statusCode).toBe(404);
  });

  it("A4：连接失败 → 502 app.connect_failed，什么都不写（含凭据）", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const before = {
      apps: await countRows("apps"),
      secrets: await countRows("secrets"),
      audit: await countRows("audit_events"),
    };
    class UpstreamTimeout extends Error {
      override name = "UpstreamTimeout";
    }
    (memState().servers.docs as { fail?: Error }).fail = new UpstreamTimeout(`boom with ${TOKEN}`);
    const res = await req({ method: "POST", url: `/api/v1/orgs/${orgId}/apps`, payload: docsApp });
    expect(res.statusCode).toBe(502);
    expect(errCode(res)).toBe("app.connect_failed");
    expect((res.json() as { error: { message: string } }).error.message).toContain(
      "UpstreamTimeout",
    );
    expect(res.body).not.toContain(TOKEN);
    expect(await countRows("apps")).toBe(before.apps);
    expect(await countRows("app_tools")).toBe(0);
    expect(await countRows("secrets")).toBe(before.secrets);
    expect(await countRows("audit_events")).toBe(before.audit);
    expect(memState().closed).toBe(memState().opened);

    // 凭据错误（上游拒绝）同样 502
    delete (memState().servers.docs as { fail?: Error }).fail;
    const wrong = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, credential: { token: "wrong-token-value-xyz" } },
    });
    expect(wrong.statusCode).toBe(502);
    expect(await countRows("apps")).toBe(0);
  });

  it("需要凭据却没带 → 409 credential.missing；none 不需要凭据；凭据形状不对 → 400", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { credential: _omit, ...noCred } = docsApp;
    const res = await req({ method: "POST", url: `/api/v1/orgs/${orgId}/apps`, payload: noCred });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("credential.missing");
    expect(await countRows("apps")).toBe(0);

    const badShape = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, credential: { username: "a", password: "b" } },
    });
    expect(badShape.statusCode).toBe(400);
    expect(memState().opened).toBe(1);

    const { app } = await createApp(req, orgId, {
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
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, connector: "nope" },
    });
    expect(unknown.statusCode).toBe(400);
    expect(errCode(unknown)).toBe("validation_failed");
    const badEndpoint = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/apps`,
      payload: { ...docsApp, endpoint: { server: "" } },
    });
    expect(badEndpoint.statusCode).toBe(400);
    const details = (badEndpoint.json() as { error: { details: { path: string }[] } }).error
      .details;
    expect(details.map((d) => d.path)).toContain("endpoint.server");
  });

  it("工具 key 超长或含非法字符：该工具停用并给出原因，不挡住应用", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    (memState().servers.open as { tools: unknown[] }).tools.push(
      { name: "x".repeat(70), description: "Too long.", inputSchema: { type: "object" } },
      { name: "has space", description: "Bad chars.", inputSchema: { type: "object" } },
    );
    const { app, issues } = await createApp(req, orgId, {
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
      url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
      payload: { tools: { "has space": { status: "enabled" } } },
    });
    expect(res.statusCode).toBe(400);
    expect(errCode(res)).toBe("validation_failed");
  });

  it("PATCH：改名、停用应用、工具启停与默认策略、批量把无注解工具改为允许", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { app } = await createApp(req, orgId);
    const res = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
      payload: {
        name: "Docs 2",
        status: "disabled",
        tools: { search: { status: "disabled" }, delete_doc: { defaultPolicy: "deny" } },
        allowUnannotated: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    const updated = (res.json() as { app: AppJson }).app;
    expect(updated).toMatchObject({ name: "Docs 2", status: "disabled", slug: "docs" });
    const byName = Object.fromEntries(updated.tools.map((t) => [t.name, t]));
    expect(byName.search?.status).toBe("disabled");
    expect(byName.delete_doc?.defaultPolicy).toBe("deny");
    expect(byName.create_doc?.defaultPolicy).toBe("allow");

    const unknownTool = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
      payload: { tools: { nope: { status: "enabled" } } },
    });
    expect(unknownTool.statusCode).toBe(400);

    const admin = await memberSession(orgId, "adm", "admin");
    expect(
      (
        await admin.req({
          method: "PATCH",
          url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
          payload: { name: "By admin" },
        })
      ).statusCode,
    ).toBe(200);
    const member = await memberSession(orgId, "mem", "member");
    const denied = await member.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
      payload: { name: "x" },
    });
    expect(denied.statusCode).toBe(403);
    expect(
      await db
        .selectFrom("audit_events")
        .select("action")
        .where("action", "=", "app.updated")
        .execute(),
    ).toHaveLength(2);
  });

  it("refresh：重新 listTools 直接覆盖（保留管理员的启停与策略）", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { app } = await createApp(req, orgId);
    await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}`,
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
    const res = await req({ method: "POST", url: `/api/v1/orgs/${orgId}/apps/${app.id}/refresh` });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as {
      app: AppJson;
      changes: { added: string[]; removed: string[]; changed: string[] };
    };
    expect(body.changes).toEqual({
      added: ["list_docs"],
      removed: ["create_doc"],
      changed: ["search"],
    });
    const byName = Object.fromEntries(body.app.tools.map((t) => [t.name, t]));
    expect(byName.search).toMatchObject({
      status: "disabled",
      description: "Search documents, v2.",
    });
    expect(byName.search?.specHash).not.toBe(app.tools.find((t) => t.name === "search")?.specHash);
    expect(byName.list_docs).toMatchObject({ status: "enabled", defaultPolicy: "allow" });
    expect(byName.create_doc).toBeUndefined();
    expect(memState().closed).toBe(memState().opened);

    const member = await memberSession(orgId, "mem", "member");
    expect(
      (await member.req({ method: "POST", url: `/api/v1/orgs/${orgId}/apps/${app.id}/refresh` }))
        .statusCode,
    ).toBe(403);
  });

  it("凭据：组织凭据只有管理员能设；个人凭据接口只影响本人", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { app: orgApp } = await createApp(req, orgId);
    const a = await memberSession(orgId, "alice", "member");
    const b = await memberSession(orgId, "bob", "guest");

    const orgCred = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/apps/${orgApp.id}/credentials/org`,
      payload: { token: "another-token-123456" },
    });
    expect(orgCred.statusCode).toBe(403);
    const ownerSet = await req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/apps/${orgApp.id}/credentials/org`,
      payload: { token: "another-token-123456" },
    });
    expect(ownerSet.statusCode).toBe(204);
    // 组织凭据型应用不接受个人凭据
    const wrongOwner = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/apps/${orgApp.id}/credentials/me`,
      payload: { token: "personal-token-12345" },
    });
    expect(wrongOwner.statusCode).toBe(400);

    // 个人凭据型应用：创建者带的是自己的个人凭据
    memState().servers.mine = {
      tools: [{ name: "me", description: "Me.", inputSchema: { type: "object" } }],
    };
    const { app } = await createApp(req, orgId, {
      name: "Mine",
      endpoint: { server: "mine" },
      auth: { type: "bearer", ownership: "personal" },
      credential: { token: "owner-personal-token-1" },
    });
    expect(app.credential).toEqual({ ownership: "personal", status: "connected" });
    const statusOf = async (r: Req) =>
      (
        (await r({ method: "GET", url: `/api/v1/orgs/${orgId}/apps/${app.id}` })).json() as {
          app: AppJson;
        }
      ).app.credential.status;
    expect(await statusOf(a.req)).toBe("missing");
    expect(await statusOf(b.req)).toBe("missing");

    const put = await a.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}/credentials/me`,
      payload: { token: "alice-personal-token-1" },
    });
    expect(put.statusCode).toBe(204);
    expect(await statusOf(a.req)).toBe("connected");
    expect(await statusOf(b.req)).toBe("missing");
    expect(await statusOf(req)).toBe("connected");

    const del = await a.req({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}/credentials/me`,
    });
    expect(del.statusCode).toBe(204);
    expect(await statusOf(a.req)).toBe("missing");
    expect(await statusOf(req)).toBe("connected");

    const badShape = await b.req({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/apps/${app.id}/credentials/me`,
      payload: { nope: 1 },
    });
    expect(badShape.statusCode).toBe(400);

    const auditRows = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "like", "app.credential%")
      .execute();
    expect(auditRows.map((r) => r.action).sort()).toEqual([
      "app.credential.cleared",
      "app.credential.set",
      "app.credential.set",
    ]);
    expect(JSON.stringify(auditRows)).not.toMatch(/token-/);
  });

  it("DELETE：软删后 404 app.not_found，凭据一并清除，slug 可复用", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const { app } = await createApp(req, orgId);
    const member = await memberSession(orgId, "mem", "member");
    expect(
      (await member.req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/apps/${app.id}` }))
        .statusCode,
    ).toBe(403);
    const del = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/apps/${app.id}` });
    expect(del.statusCode).toBe(204);
    const get = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/apps/${app.id}` });
    expect(get.statusCode).toBe(404);
    expect(errCode(get)).toBe("app.not_found");
    const secrets = await db
      .selectFrom("secrets")
      .select("key")
      .where("key", "like", `credentials:app:${app.id}:%`)
      .execute();
    expect(secrets).toEqual([]);
    await createApp(req, orgId);
    // 另一个组织看不到本组织的应用
    const other = await createOrg(req, "Other");
    const cross = await req({ method: "GET", url: `/api/v1/orgs/${other}/apps/${app.id}` });
    expect(cross.statusCode).toBe(404);
  });
});
