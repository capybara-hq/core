import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ExtensionHost } from "../../src/extensions/host.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { fakeBCalls, MODEL_PLUGINS_CONFIG } from "../helpers/model-plugins.js";
import { startKernel, type TestKernel } from "../helpers/runs.js";

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
      ...MODEL_PLUGINS_CONFIG,
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = accountsFor(db);
  members = testMembers(db);
  tokens = apiTokensFor(db);
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

async function createOrg(req: Req): Promise<string> {
  const res = await req({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  expect(res.statusCode).toBe(201);
  return (res.json() as { org: { id: string } }).org.id;
}

async function memberSession(orgId: string, login: string, role: "admin" | "member" | "guest") {
  const a = await accounts.createLocal({ login, password: PW, displayName: login });
  await members.add(orgId, a.id, role, owner.id);
  return { account: a, req: await session(login) };
}

const definition = {
  name: "Helper",
  instructions: "Be helpful.",
  model: { provider: "model-fake", model: "fake-1" },
};

type AgentJson = { id: string; currentVersion: number; visibility: string };

async function createAgent(req: Req, orgId: string, body: Record<string, unknown> = {}) {
  const res = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: { definition, visibility: "org", ...body },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { agent: AgentJson }).agent;
}

describe("Agent HTTP", () => {
  it("未登录 → 401", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    for (const [method, url] of [
      ["GET", `/api/v1/orgs/${orgId}/agents`],
      ["POST", `/api/v1/orgs/${orgId}/agents`],
      ["GET", `/api/v1/orgs/${orgId}/models`],
    ] as const) {
      const res = await k.http.inject({ method, url, headers: { "x-capybara-csrf": "1" } });
      expect(res.statusCode).toBe(401);
    }
  });

  it("POST 201 { agent, warnings }；GET 列表 / 单个 / 版本；PATCH 产生新版本；DELETE 204", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const create = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: { ...definition, fallback: { provider: "model-fake", model: "fake-2" } },
        visibility: "org",
      },
    });
    expect(create.statusCode).toBe(201);
    const created = create.json() as {
      agent: AgentJson & { definition: Record<string, unknown> };
      warnings: string[];
    };
    expect(created.warnings).toEqual(["fallback_same_provider"]);
    expect(created.agent).toMatchObject({ currentVersion: 1, visibility: "org", memberIds: null });
    expect(created.agent.definition).toMatchObject({
      avatarUrl: null,
      modelParams: {},
      fallbackParams: {},
      // 创建时未给 tools → 默认工具（Ruling P7）
      tools: [
        { kind: "builtin", name: "ask_user" },
        { kind: "builtin", name: "read_tool_output" },
      ],
      toolPolicies: {},
    });
    expect(created.agent.definition).not.toHaveProperty("effort");
    const id = created.agent.id;

    const list = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents` });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { agents: AgentJson[] }).agents.map((a) => a.id)).toEqual([id]);

    const one = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${id}` });
    expect(one.statusCode).toBe(200);
    expect((one.json() as { agent: AgentJson }).agent.id).toBe(id);

    const patch = await req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${id}`,
      payload: { definition: { ...definition, instructions: "Be terse." } },
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ agent: { currentVersion: 2 }, warnings: [] });

    const versions = await req({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents/${id}/versions`,
    });
    expect(versions.statusCode).toBe(200);
    const vs = (versions.json() as { versions: { version: number; createdBy: string }[] }).versions;
    expect(vs.map((v) => v.version)).toEqual([2, 1]);
    expect(vs[0]?.createdBy).toBe(owner.id);

    const del = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/agents/${id}` });
    expect(del.statusCode).toBe(204);
    const gone = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents/${id}` });
    expect(gone.statusCode).toBe(404);
    expect(errCode(gone)).toBe("agent.not_found");
  });

  it("PATCH expectedVersion：与当前版本一致才保存；过期 → 409 agent.version_conflict，不产生新版本", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const create = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition, visibility: "org" },
    });
    const id = (create.json() as { agent: AgentJson }).agent.id;
    const url = `/api/v1/orgs/${orgId}/agents/${id}`;
    const ok = await req({
      method: "PATCH",
      url,
      payload: { definition: { ...definition, instructions: "A." }, expectedVersion: 1 },
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ agent: { currentVersion: 2 } });
    // 另一个编辑页仍以版本 1 为基础
    const stale = await req({
      method: "PATCH",
      url,
      payload: { definition: { ...definition, instructions: "B." }, expectedVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(errCode(stale)).toBe("agent.version_conflict");
    const one = await req({ method: "GET", url });
    expect(one.json()).toMatchObject({ agent: { currentVersion: 2 } });
    // 不带 expectedVersion 的旧客户端不检查
    const legacy = await req({ method: "PATCH", url, payload: { visibility: "private" } });
    expect(legacy.statusCode).toBe(200);
  });

  it("不存在的模型 → 400 agent.model_unavailable；非法定义 → 400 validation_failed", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const bad = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition: { ...definition, model: { provider: "model-fake", model: "x" } } },
    });
    expect(bad.statusCode).toBe(400);
    // a missing visibility is refused by the DTO validation first
    expect(errCode(bad)).toBe("validation_failed");
    const missing = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: { ...definition, model: { provider: "model-fake", model: "x" } },
        visibility: "org",
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(errCode(missing)).toBe("agent.model_unavailable");
    const invalid = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition: { ...definition, name: "" }, visibility: "org" },
    });
    expect(invalid.statusCode).toBe(400);
    expect(errCode(invalid)).toBe("validation_failed");
  });

  it("未知模型参数 → 400 validation_failed，details 点名 modelParams.<key>", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: {
        definition: { ...definition, modelParams: { "x.unknown": 1 } },
        visibility: "org",
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as { error: { code: string; details: unknown[] } };
    expect(body.error.code).toBe("validation_failed");
    expect(body.error.details).toEqual([
      { path: "modelParams.x.unknown", message: 'unknown parameter "x.unknown"' },
    ]);
  });

  it("非负责人的 member PATCH 别人的 agent → 403 forbidden；admin 可以", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const author = await memberSession(orgId, "author", "member");
    const other = await memberSession(orgId, "other", "member");
    const adm = await memberSession(orgId, "adm", "admin");
    const agent = await createAgent(author.req, orgId);
    const url = `/api/v1/orgs/${orgId}/agents/${agent.id}`;

    const denied = await other.req({ method: "PATCH", url, payload: { visibility: "private" } });
    expect(denied.statusCode).toBe(403);
    expect(errCode(denied)).toBe("forbidden");
    const delDenied = await other.req({ method: "DELETE", url });
    expect(delDenied.statusCode).toBe(403);

    const ok = await adm.req({ method: "PATCH", url, payload: { visibility: "private" } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ agent: { visibility: "private", currentVersion: 1 } });
  });

  it("负责人被移出组织后 PATCH 被拒", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const author = await memberSession(orgId, "author", "member");
    const agent = await createAgent(author.req, orgId);
    await members.remove(orgId, author.account.id, owner.id);
    const res = await author.req({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agent.id}`,
      payload: { visibility: "private" },
    });
    // 移出走离职处理，其会话已被吊销；锁内复核的 403 由服务层测试覆盖
    expect(res.statusCode).toBe(401);
    expect(errCode(res)).toBe("auth.session_revoked");
  });

  it("访客 POST → 403；访客可 GET 列表与模型", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const guest = await memberSession(orgId, "guest", "guest");
    const res = await guest.req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      payload: { definition, visibility: "org" },
    });
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    expect(
      (await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/agents` })).statusCode,
    ).toBe(200);
    expect(
      (await guest.req({ method: "GET", url: `/api/v1/orgs/${orgId}/models` })).statusCode,
    ).toBe(200);
  });

  it("服务令牌：POST /agents → 403；GET /agents → 200（只见 org 可见的 agent）", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    const pub = await createAgent(ownerReq, orgId, { visibility: "org" });
    await createAgent(ownerReq, orgId, { visibility: "private" });
    const { token } = await tokens.createService(orgId, {
      name: "bot",
      role: "admin",
      createdBy: owner.id,
    });
    const headers = { authorization: `Bearer ${token}` };
    const post = await k.http.inject({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/agents`,
      headers,
      payload: { definition, visibility: "org" },
    });
    expect(post.statusCode).toBe(403);
    expect(errCode(post)).toBe("forbidden");
    const list = await k.http.inject({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/agents`,
      headers,
    });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { agents: AgentJson[] }).agents.map((a) => a.id)).toEqual([pub.id]);
    const patch = await k.http.inject({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${pub.id}`,
      headers,
      payload: { visibility: "private" },
    });
    expect(patch.statusCode).toBe(403);
  });

  it("非成员 → 404 org.not_found", async () => {
    const ownerReq = await session("owner");
    const orgId = await createOrg(ownerReq);
    await accounts.createLocal({ login: "stranger", password: PW, displayName: "S" });
    const s = await session("stranger");
    const res = await s({ method: "GET", url: `/api/v1/orgs/${orgId}/agents` });
    expect(res.statusCode).toBe(404);
    expect(errCode(res)).toBe("org.not_found");
  });

  it("GET /models 列出供应商；第二次调用不再访问供应商", async () => {
    const req = await session("owner");
    const orgId = await createOrg(req);
    const before = fakeBCalls(k.app.get(ExtensionHost));
    const first = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/models` });
    expect(first.statusCode).toBe(200);
    const providers = (
      first.json() as { providers: { provider: string; models: { id: string }[] }[] }
    ).providers;
    expect(providers.map((p) => [p.provider, p.models.map((m) => m.id)])).toEqual([
      ["model-fake", ["fake-1", "fake-2"]],
      ["model-fake-b", ["b-1", "b-2"]],
    ]);
    const second = await req({ method: "GET", url: `/api/v1/orgs/${orgId}/models` });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(fakeBCalls(k.app.get(ExtensionHost)) - before).toBe(1);
  });
});
