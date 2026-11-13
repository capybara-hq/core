import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import { createLogger } from "../../src/log.js";
import { AdminConnectors } from "../../src/tools/admin-connectors.js";
import { ConnectorsService } from "../../src/tools/connectors.service.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { enableConnectorExtensions, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * The connector extension's HTTP and admin surfaces, on one kernel:
 * - the platform admin's `AdminConnectors` (list, filter, detail, status, remove across orgs);
 * - the connector preview (`POST /connectors/preview`, Ruling A20) with the test connector
 *   `mem` (no `inspect`): listing tools with a credential opens and closes one session and writes
 *   nothing; no credential or an OAuth code flow lists nothing; a wrong credential is a 502
 *   without the credential; validation and permissions. The preview of a connector with `inspect`
 *   (auth hints, operations) is tested on the real OpenAPI connector in that plugin's
 *   `test/kernel/openapi-e2e.test.ts`, and in core on `fake-connector` (`m3-segment2.dual.test.ts`:
 *   auth hints -> install).
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);

const PW = "correct horse battery";
const ORG_SECRET = "SENTINEL-ORG-SECRET";
const MEMBER_SECRET = "SENTINEL-MEMBER-SECRET";
const MEM_TOKEN = "mem_secret_value_0123456789";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let accounts: AccountsService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      extensions: [MEM_CONNECTOR, MODEL_FAKE],
      extensionPermissions: { autoApprove: true },
      // the preview opens one session with this timeout
      tools: { timeoutMs: 5_000 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
});
afterAll(async () => {
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

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

async function createOrg(req: Req, name: string): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name } });
  expect(res.statusCode).toBe(201);
  const id = (res.json() as { org: { id: string } }).org.id;
  await enableConnectorExtensions(k, id);
  return id;
}

describe("AdminConnectors", () => {
  let owner: Account;
  let outsider: Account;

  interface Fixture {
    acme: string;
    beta: string;
    /** Acme, org credential. */
    docs: string;
    /** Acme, personal credential. */
    mine: string;
    /** Beta, no credential. */
    open: string;
    /** Beta, soft-deleted. */
    gone: string;
  }
  let fx: Fixture;

  async function createConnector(req: Req, orgId: string, body: Record<string, unknown>) {
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/connectors`,
      payload: { connector: "mem", ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { connector: { id: string } }).connector.id;
  }

  beforeEach(async () => {
    await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
    await redis.flushdb();
    owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
    outsider = await accounts.createLocal({ login: "root", password: PW, displayName: "Root" });
    const st = memState();
    st.servers = {
      docs: {
        tools: [
          { name: "search", description: "Search.", inputSchema: { type: "object" } },
          { name: "create_doc", description: "Create.", inputSchema: { type: "object" } },
        ],
        requireAuth: `Bearer ${ORG_SECRET}`,
      },
      mine: {
        tools: [{ name: "me", description: "Me.", inputSchema: { type: "object" } }],
        requireAuth: `Bearer ${MEMBER_SECRET}`,
      },
      open: { tools: [{ name: "ping", description: "Ping.", inputSchema: { type: "object" } }] },
    };
    st.opened = 0;
    st.closed = 0;
    st.auths = [];

    const req = await session("owner");
    const acme = await createOrg(req, "Acme");
    const beta = await createOrg(req, "Beta");
    const docs = await createConnector(req, acme, {
      name: "Docs",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: ORG_SECRET },
    });
    const mine = await createConnector(req, acme, {
      name: "Mine",
      endpoint: { server: "mine" },
      auth: { type: "bearer", ownership: "personal" },
      credential: { token: MEMBER_SECRET },
    });
    const open = await createConnector(req, beta, {
      name: "Open",
      endpoint: { server: "open" },
      auth: { type: "none" },
    });
    const gone = await createConnector(req, beta, {
      name: "Gone",
      endpoint: { server: "open" },
      auth: { type: "none" },
    });
    const del = await req({ method: "DELETE", url: `/api/v1/orgs/${beta}/connectors/${gone}` });
    expect(del.statusCode, del.body).toBe(204);
    fx = { acme, beta, docs, mine, open, gone };
  });

  const admin = () => k.app.get(AdminConnectors);
  const svc = () => k.app.get(ConnectorsService);

  async function auditOf(action: string, target: string) {
    return db
      .selectFrom("audit_events")
      .select(["actor_account_id", "org_id", "detail"])
      .where("action", "=", action)
      .where("target", "=", target)
      .execute();
  }

  it("lists live connectors of every org with tool counts", async () => {
    const { connectors, next } = await admin().list({ limit: 50 });
    expect(next).toBeNull();
    const ids = [fx.docs, fx.mine, fx.open].sort();
    expect(connectors.map((c) => c.id)).toEqual(ids);
    const byId = Object.fromEntries(connectors.map((c) => [c.id, c]));
    expect(byId[fx.docs]).toMatchObject({
      orgId: fx.acme,
      orgName: "Acme",
      name: "Docs",
      slug: "docs",
      connector: "mem",
      status: "active",
      platformTemplateId: null,
      templateName: null,
      catalogItemId: null,
      toolCount: 2,
      createdBy: owner.id,
      createdByName: "Owner",
    });
    expect(byId[fx.docs]?.toolsSyncedAt).toBeInstanceOf(Date);
    expect(byId[fx.open]).toMatchObject({ orgId: fx.beta, orgName: "Beta", toolCount: 1 });

    // a connector made from a platform template names it
    const itemId = randomUUID();
    const templateId = randomUUID();
    await db
      .insertInto("catalog_items")
      .values({
        id: itemId,
        name: `item-${itemId}`,
        package_name: `@acme/plugin-${itemId}`,
        publisher: "Acme",
        description: "d",
        latest_version: "1.0.0",
        policy: "allow",
      })
      .execute();
    await db
      .insertInto("platform_connector_templates")
      .values({
        id: templateId,
        catalog_item_id: itemId,
        template_id: "docs-kit",
        current_version: "1.0.0",
        file: JSON.stringify({ template: { plugin: "mem" } }),
      })
      .execute();
    await sql`UPDATE capybara.connectors SET platform_template_id = ${templateId}
      WHERE id = ${fx.docs}`.execute(raw);
    const made = await admin().list({ limit: 50 });
    expect(made.connectors.find((c) => c.id === fx.docs)).toMatchObject({
      platformTemplateId: templateId,
      templateName: "docs-kit",
    });
    expect((await admin().get(fx.docs)).templateName).toBe("docs-kit");

    // connectors of a soft-deleted org are not listed
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${fx.beta}`.execute(raw);
    const after = await admin().list({ limit: 50 });
    expect(after.connectors.map((c) => c.id)).toEqual([fx.docs, fx.mine].sort());
  });

  it("filters by org, status and name; pages with next", async () => {
    const byOrg = await admin().list({ orgId: fx.acme, limit: 50 });
    expect(byOrg.connectors.map((c) => c.id)).toEqual([fx.docs, fx.mine].sort());

    await svc().setStatusAsPlatform(fx.mine, "disabled", { accountId: outsider.id });
    const disabled = await admin().list({ status: "disabled", limit: 50 });
    expect(disabled.connectors.map((c) => c.id)).toEqual([fx.mine]);
    const active = await admin().list({ status: "active", limit: 50 });
    expect(active.connectors.map((c) => c.id)).toEqual([fx.docs, fx.open].sort());

    const named = await admin().list({ q: "DOC", limit: 50 });
    expect(named.connectors.map((c) => c.id)).toEqual([fx.docs]);
    // LIKE wildcards in the search are matched literally
    expect((await admin().list({ q: "%", limit: 50 })).connectors).toEqual([]);

    const ids = [fx.docs, fx.mine, fx.open].sort();
    const p1 = await admin().list({ limit: 2 });
    expect(p1.connectors.map((c) => c.id)).toEqual(ids.slice(0, 2));
    expect(p1.next).toBe(ids[1]);
    const p2 = await admin().list({ limit: 2, after: p1.next ?? undefined });
    expect(p2.connectors.map((c) => c.id)).toEqual(ids.slice(2));
    expect(p2.next).toBeNull();
  });

  it("detail never contains a credential", async () => {
    for (const id of [fx.docs, fx.mine, fx.open]) {
      const detail = await admin().get(id);
      const text = JSON.stringify(detail);
      expect(text).not.toContain(ORG_SECRET);
      expect(text).not.toContain(MEMBER_SECRET);
      expect(detail).not.toHaveProperty("credential");
    }
    const list = JSON.stringify(await admin().list({ limit: 50 }));
    expect(list).not.toContain(ORG_SECRET);
    expect(list).not.toContain(MEMBER_SECRET);
  });

  it("detail shows auth type and ownership only", async () => {
    const docs = await admin().get(fx.docs);
    expect(docs.auth).toEqual({ type: "bearer", ownership: "org" });
    expect(docs).toMatchObject({
      id: fx.docs,
      orgId: fx.acme,
      orgName: "Acme",
      endpoint: { server: "docs" },
      toolCount: 2,
    });
    expect(docs.tools).toEqual([
      { name: "create_doc", title: null, status: "enabled", defaultPolicy: "ask" },
      { name: "search", title: null, status: "enabled", defaultPolicy: "ask" },
    ]);
    expect((await admin().get(fx.mine)).auth).toEqual({ type: "bearer", ownership: "personal" });
    expect((await admin().get(fx.open)).auth).toEqual({ type: "none", ownership: null });
  });

  it("setStatusAsPlatform disables for an account outside the org", async () => {
    await svc().setStatusAsPlatform(fx.docs, "disabled", { accountId: outsider.id });
    expect((await admin().get(fx.docs)).status).toBe("disabled");
    const rows = await auditOf("connector.updated", fx.docs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_account_id: outsider.id,
      org_id: fx.acme,
      detail: { status: { from: "active", to: "disabled" }, via: "platform" },
    });

    await svc().setStatusAsPlatform(fx.docs, "active", { accountId: outsider.id });
    expect((await admin().get(fx.docs)).status).toBe("active");

    await expect(
      svc().setStatusAsPlatform(fx.gone, "disabled", { accountId: outsider.id }),
    ).rejects.toMatchObject({ code: "connector.not_found" });
  });

  it("removeAsPlatform soft-deletes and clears credentials", async () => {
    const secrets = async () =>
      Number(
        (
          await sql<{ n: string }>`SELECT count(*)::text AS n FROM capybara.secrets
            WHERE org_id = ${fx.acme}`.execute(raw)
        ).rows[0]?.n,
      );
    const before = await secrets();
    expect(before).toBeGreaterThan(0);
    await svc().removeAsPlatform(fx.docs, { accountId: outsider.id });
    await svc().removeAsPlatform(fx.mine, { accountId: outsider.id });
    const rows = await db
      .selectFrom("connectors")
      .select(["id", "deleted_at"])
      .where("id", "in", [fx.docs, fx.mine])
      .execute();
    for (const r of rows) expect(r.deleted_at).toBeInstanceOf(Date);
    expect(await secrets()).toBe(0);
    const audits = await auditOf("connector.deleted", fx.docs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_account_id: outsider.id,
      org_id: fx.acme,
      detail: { slug: "docs", via: "platform" },
    });
    await expect(admin().get(fx.docs)).rejects.toMatchObject({ code: "connector.not_found" });
    await expect(svc().removeAsPlatform(fx.docs, { accountId: outsider.id })).rejects.toMatchObject(
      { code: "connector.not_found" },
    );
  });

  it("get of a deleted connector is connector.not_found", async () => {
    await expect(admin().get(fx.gone)).rejects.toMatchObject({ code: "connector.not_found" });
    await expect(admin().get("nope")).rejects.toMatchObject({ code: "connector.not_found" });
    // a connector of a soft-deleted org is not found either
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${fx.beta}`.execute(raw);
    await expect(admin().get(fx.open)).rejects.toMatchObject({ code: "connector.not_found" });
  });
});

describe("连接器预览", () => {
  let req: Req;
  let orgId: string;
  let ownerId: string;

  beforeEach(async () => {
    await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
    ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
    req = await session("owner");
    orgId = await createOrg(req, "Preview");
    const st = memState();
    st.servers = {
      docs: {
        tools: [
          {
            name: "search",
            description: "Search documents.",
            inputSchema: { type: "object" },
            annotations: { readOnlyHint: true },
          },
          { name: "bad name!", description: "Bad.", inputSchema: { type: "object" } },
        ],
        requireAuth: `Bearer ${MEM_TOKEN}`,
      },
    };
    st.opened = 0;
    st.closed = 0;
    st.auths = [];
  });

  const countRows = async (table: "connectors" | "connector_tools" | "secrets" | "audit_events") =>
    Number(
      (
        await sql<{
          n: string;
        }>`SELECT count(*)::text AS n FROM ${sql.table(`capybara.${table}`)}`.execute(raw)
      ).rows[0]?.n,
    );

  const preview = (payload: Record<string, unknown>, r: Req = req) =>
    r({ method: "POST", url: `/api/v1/orgs/${orgId}/connectors/preview`, payload });

  interface PreviewJson {
    tools:
      | {
          name: string;
          key: string;
          description: string;
          inputSchema: Record<string, unknown>;
          annotations: Record<string, unknown> | null;
          defaultPolicy: string;
          issue: string | null;
          source: string;
        }[]
      | null;
    authHints: Record<string, unknown>[];
    operations?: { id: string; method: string; path: string; summary?: string }[];
  }

  const errOf = (res: { json(): unknown }) =>
    (res.json() as { error: { code: string; message: string } }).error;

  it("凭据错误的列工具失败 → 502，凭据不出现在响应里", async () => {
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: `wrong-${MEM_TOKEN}` },
    });
    expect(res.statusCode).toBe(502);
    expect(errOf(res).code).toBe("connector.connect_failed");
    expect(res.body).not.toContain(MEM_TOKEN);
  });

  it("没有 inspect 的连接器：authHints 为空、没有 operations；有凭据时列工具并关闭会话；什么都不写", async () => {
    const before = {
      connectors: await countRows("connectors"),
      secrets: await countRows("secrets"),
      audit: await countRows("audit_events"),
    };
    const res = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "bearer", ownership: "org" },
      credential: { token: MEM_TOKEN },
    });
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as PreviewJson;
    expect(body.authHints).toEqual([]);
    expect(body.operations).toBeUndefined();
    // 没给 slug / name：key 用占位 slug `app`
    expect(body.tools?.map((t) => [t.key, t.issue === null])).toEqual([
      ["mcp__app__search", true],
      ["mcp__app__bad name!", false],
    ]);
    expect(memState().opened).toBe(1);
    expect(memState().closed).toBe(1);
    expect(res.body).not.toContain(MEM_TOKEN);
    expect(await countRows("connectors")).toBe(before.connectors);
    expect(await countRows("secrets")).toBe(before.secrets);
    expect(await countRows("connector_tools")).toBe(0);
    expect(await countRows("audit_events")).toBe(before.audit);
  });

  it("需要凭据但没给 / OAuth 授权码 → 不列工具", async () => {
    for (const auth of [
      { type: "bearer", ownership: "org" },
      {
        type: "oauth_code",
        ownership: "personal",
        discovery: "manual",
        authorizationUrl: "https://auth.example.com/a",
        tokenUrl: "https://auth.example.com/t",
        client: "manual",
      },
    ]) {
      const res = await preview({ connector: "mem", endpoint: { server: "docs" }, auth });
      expect(res.statusCode, res.body).toBe(200);
      expect((res.json() as PreviewJson).tools).toBeNull();
    }
    expect(memState().opened).toBe(0);
  });

  it("校验：未知连接器 / 凭据形状 → 400", async () => {
    const unknown = await preview({ connector: "nope", endpoint: {} });
    expect(unknown.statusCode).toBe(400);
    const shape = await preview({
      connector: "mem",
      endpoint: { server: "docs" },
      auth: { type: "basic", ownership: "org" },
      credential: { token: "x" },
    });
    expect(shape.statusCode).toBe(400);
  });

  it("权限：member → 403", async () => {
    const acc = await accounts.createLocal({
      login: "mem",
      password: PW,
      displayName: "m",
    });
    await testMembers(db).add(orgId, acc.id, "member", ownerId);
    const memberReq = await session("mem");
    const res = await preview({ connector: "mem", endpoint: { server: "docs" } }, memberReq);
    expect(res.statusCode).toBe(403);
  });
});
