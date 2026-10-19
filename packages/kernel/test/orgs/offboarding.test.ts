import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { Offboarding } from "../../src/orgs/offboarding.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { testMembers } from "../helpers/members.js";

const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let accounts: AccountsService;
let members: MembersService;
let tokens: ApiTokenService;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await createKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5 },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      http: { port: 0 },
      auth: { cookieSecure: false },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  accounts = new AccountsService(db);
  members = testMembers(db);
  tokens = new ApiTokenService(db);
}, 120_000);
afterAll(async () => {
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

type Req = ReturnType<typeof asUser>;
const errCode = (res: { json(): unknown }) =>
  (res.json() as { error?: { code?: string } }).error?.code;
const codeOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as ApiError).code;
  }
  return undefined;
};

async function login(name: string): Promise<Req> {
  const req = asUser(k.http, cookieJar());
  const res = await req({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: name, password: PW },
  });
  expect(res.statusCode).toBe(200);
  return req;
}

interface Fixture {
  owner: Account;
  ownerReq: Req;
  orgId: string;
  otherOrgId: string;
  leaver: Account;
  leaverReq: Req;
  leaverReq2: Req;
  pat: string;
  appId: string;
  otherAppId: string;
  agentId: string;
  otherOrgAgentId: string;
  approvalId: string;
  roleApprovalId: string;
  questionId: string;
  conversationId: string;
  runId: string;
  otherRunId: string;
  bystander: Account;
}

let f: Fixture;

async function insertAgent(orgId: string, ownerId: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${id}, ${orgId}, ${ownerId}, 'org', 1)`.execute(raw);
  await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
    VALUES (${id}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${ownerId})`.execute(raw);
  return id;
}

async function insertApp(orgId: string, slug: string, by: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.apps (id, org_id, slug, name, connector, auth, created_by)
    VALUES (${id}, ${orgId}, ${slug}, ${slug}, 'test',
      ${JSON.stringify({ type: "bearer", ownership: "personal" })}::jsonb, ${by})`.execute(raw);
  return id;
}

const personal = (accountId: string) => ({ kind: "user" as const, accountId });
const AUTH = { type: "bearer", ownership: "personal" } as never;

beforeEach(async () => {
  await sql`TRUNCATE capybara.accounts, capybara.orgs, capybara.audit_events, capybara.secrets CASCADE`.execute(
    raw,
  );
  await redis.flushdb();
  const owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const ownerReq = await login("owner");
  const mk = async (name: string) => {
    const res = await ownerReq({ method: "POST", url: "/api/v1/orgs", payload: { name } });
    expect(res.statusCode).toBe(201);
    return (res.json() as { org: { id: string } }).org.id;
  };
  const orgId = await mk("Acme");
  const otherOrgId = await mk("Other");
  const leaver = await accounts.createLocal({
    login: "leaver",
    password: PW,
    displayName: "Leaver",
  });
  const bystander = await accounts.createLocal({
    login: "bystander",
    password: PW,
    displayName: "B",
  });
  await members.add(orgId, leaver.id, "member", owner.id);
  await members.add(otherOrgId, leaver.id, "member", owner.id);
  await members.add(orgId, bystander.id, "member", owner.id);
  const leaverReq = await login("leaver");
  const leaverReq2 = await login("leaver");
  const pat = (await tokens.createPersonal(leaver.id, { name: "cli" })).token;

  const appId = await insertApp(orgId, "docs", owner.id);
  const otherAppId = await insertApp(otherOrgId, "docs", owner.id);
  const creds = k.tools.credentials;
  await creds.setStatic(orgId, appId, AUTH, personal(leaver.id), { token: "leaver-token" });
  await creds.setStatic(orgId, appId, AUTH, personal(bystander.id), { token: "b-token" });
  await creds.setStatic(otherOrgId, otherAppId, AUTH, personal(leaver.id), { token: "other" });

  const agentId = await insertAgent(orgId, leaver.id);
  const otherOrgAgentId = await insertAgent(otherOrgId, leaver.id);

  const conversationId = randomUUID();
  const runId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${conversationId}, ${orgId}, ${agentId}, ${leaver.id})`.execute(raw);
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${runId}, ${conversationId}, 'running', 1, ${leaver.id}, 0)`.execute(raw);
  const base = {
    orgId,
    conversationId,
    runId,
    step: 1,
    toolKey: "docs__create_doc",
    specHash: "h",
    appId,
    input: {},
  };
  const approval = await k.tools.approvals.request({
    ...base,
    callId: "c1",
    requestedFor: leaver.id,
    approverRole: null,
  });
  // 按角色升级的审批不是「其作为 requested_for」的：事务内不取消，随运行中止才取消
  const roleApproval = await k.tools.approvals.request({
    ...base,
    callId: "c2",
    requestedFor: null,
    approverRole: "admin",
  });
  const question = await k.tools.questions.ask({
    orgId,
    conversationId,
    runId,
    step: 1,
    callId: "c3",
    attempt: 1,
    toolKey: "ask_user",
    form: { title: "Q", fields: [{ key: "x", label: "X", schema: { type: "string" } }] },
    state: null,
  });
  await sql`UPDATE capybara.runs SET status = 'waiting' WHERE id = ${runId}`.execute(raw);
  // 此人在另一组织里等待中的运行：离职处理不碰
  const otherConversationId = randomUUID();
  const otherRunId = randomUUID();
  await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
    VALUES (${otherConversationId}, ${otherOrgId}, ${otherOrgAgentId}, ${leaver.id})`.execute(raw);
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${otherRunId}, ${otherConversationId}, 'waiting', 1, ${leaver.id}, 0)`.execute(raw);
  f = {
    owner,
    ownerReq,
    orgId,
    otherOrgId,
    leaver,
    leaverReq,
    leaverReq2,
    pat,
    appId,
    otherAppId,
    agentId,
    otherOrgAgentId,
    approvalId: approval.id,
    roleApprovalId: roleApproval.id,
    questionId: question.id,
    conversationId,
    runId,
    otherRunId,
    bystander,
  };
});

const secretKeys = async () =>
  (await db.selectFrom("secrets").select(["org_id", "key"]).execute())
    .map((r) => `${r.org_id === f.orgId ? "org" : "other"}:${r.key}`)
    .sort();

const status = async (table: "approvals" | "questions", id: string) =>
  (await db.selectFrom(table).select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

const agentRow = async (id: string) =>
  db
    .selectFrom("agents")
    .select(["owner_account_id", "needs_reassignment"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();

const isMember = async (orgId: string, accountId: string) =>
  (await db
    .selectFrom("memberships")
    .select("role")
    .where("org_id", "=", orgId)
    .where("account_id", "=", accountId)
    .executeTakeFirst()) !== undefined;

/** 离职处理的每一项都已发生。 */
async function expectOffboarded(reason: "removed" | "left") {
  expect(await isMember(f.orgId, f.leaver.id)).toBe(false);
  expect(await isMember(f.otherOrgId, f.leaver.id)).toBe(true);
  // 会话（全部）与个人令牌被吊销
  for (const req of [f.leaverReq, f.leaverReq2]) {
    const res = await req({ method: "GET", url: "/api/v1/me" });
    expect(res.statusCode).toBe(401);
  }
  const live = await db
    .selectFrom("sessions")
    .select("id")
    .where("account_id", "=", f.leaver.id)
    .where("revoked_at", "is", null)
    .execute();
  expect(live).toEqual([]);
  const patRes = await k.http.inject({
    method: "GET",
    url: "/api/v1/me",
    headers: { authorization: `Bearer ${f.pat}` },
  });
  expect(patRes.statusCode).toBe(401);
  // 只删除该组织里此人的个人凭据
  expect(await secretKeys()).toEqual(
    [
      `org:credentials:app:${f.appId}:user:${f.bystander.id}`,
      `other:credentials:app:${f.otherAppId}:user:${f.leaver.id}`,
    ].sort(),
  );
  // 审批 / 提问取消并写入 cancelled 事件；同一运行被中止，按角色升级的审批随之取消
  expect(await status("approvals", f.approvalId)).toBe("cancelled");
  expect(await status("approvals", f.roleApprovalId)).toBe("cancelled");
  expect(await status("questions", f.questionId)).toBe("cancelled");
  const events = await db
    .selectFrom("conversation_events")
    .select(["type", "payload"])
    .where("conversation_id", "=", f.conversationId)
    .where("type", "in", ["approval_decided", "question_answered"])
    .execute();
  expect(events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "approval_decided",
        payload: expect.objectContaining({ approvalId: f.approvalId, decision: "cancelled" }),
      }),
      expect.objectContaining({
        type: "question_answered",
        payload: expect.objectContaining({ questionId: f.questionId, outcome: "cancelled" }),
      }),
    ]),
  );
  expect(events).toHaveLength(3);
  // 该组织的 agent 转给所有者并标记待重新指派；别的组织的不动
  expect(await agentRow(f.agentId)).toEqual({
    owner_account_id: f.owner.id,
    needs_reassignment: true,
  });
  expect(await agentRow(f.otherOrgAgentId)).toEqual({
    owner_account_id: f.leaver.id,
    needs_reassignment: false,
  });
  const audit = await db
    .selectFrom("audit_events")
    .selectAll()
    .where("action", "=", "org.member.offboarded")
    .execute();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ org_id: f.orgId, target: f.leaver.id });
  expect(audit[0]?.detail).toMatchObject({ reason });
}

describe("离职处理", () => {
  it("管理员移除成员（HTTP DELETE）走离职处理：每一项都发生", async () => {
    const res = await f.ownerReq({
      method: "DELETE",
      url: `/api/v1/orgs/${f.orgId}/members/${f.leaver.id}`,
    });
    expect(res.statusCode).toBe(204);
    await expectOffboarded("removed");
    // 所有者自己的会话不受影响
    expect((await f.ownerReq({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
  });

  it("主动离开（HTTP leave）走同一路径", async () => {
    const res = await f.leaverReq({ method: "POST", url: `/api/v1/orgs/${f.orgId}/leave` });
    expect(res.statusCode).toBe(204);
    await expectOffboarded("left");
  });

  it("原子：中途失败则什么都不变", async () => {
    const broken = new Offboarding({
      credentials: k.tools.credentials,
      approvals: k.tools.approvals,
      questions: {
        cancelPendingFor: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(
      db.transaction().execute((t) => broken.offboard(t, f.orgId, f.leaver.id, "removed")),
    ).rejects.toThrow("boom");
    expect(await isMember(f.orgId, f.leaver.id)).toBe(true);
    expect((await f.leaverReq({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(200);
    const patRes = await k.http.inject({
      method: "GET",
      url: "/api/v1/me",
      headers: { authorization: `Bearer ${f.pat}` },
    });
    expect(patRes.statusCode).toBe(200);
    expect(await secretKeys()).toHaveLength(3);
    expect(await status("approvals", f.approvalId)).toBe("pending");
    expect(await status("questions", f.questionId)).toBe("pending");
    expect(await agentRow(f.agentId)).toEqual({
      owner_account_id: f.leaver.id,
      needs_reassignment: false,
    });
    expect(
      await db
        .selectFrom("audit_events")
        .select("id")
        .where("action", "=", "org.member.offboarded")
        .execute(),
    ).toEqual([]);
  });

  it("所有者保护照旧：最后一个 owner 不能离开；admin 不能移除 owner", async () => {
    expect(await codeOf(members.leave(f.orgId, f.owner.id))).toBe("org.last_owner");
    await members.changeRole(f.orgId, f.bystander.id, "admin", f.owner.id);
    expect(await codeOf(members.remove(f.orgId, f.owner.id, f.bystander.id))).toBe(
      "org.owner_required",
    );
    expect(await isMember(f.orgId, f.owner.id)).toBe(true);
  });

  it("offboard：非成员 → member.not_found", async () => {
    const off = k.identity.offboarding;
    expect(
      await codeOf(
        db.transaction().execute((t) => off.offboard(t, f.orgId, randomUUID(), "directory")),
      ),
    ).toBe("member.not_found");
  });
});

describe("agent 重新指派", () => {
  const url = () => `/api/v1/orgs/${f.orgId}/agents/${f.agentId}/owner`;

  it("admin 指派新负责人并清除 needs_reassignment；成员 403；非成员目标 404", async () => {
    await f.ownerReq({ method: "DELETE", url: `/api/v1/orgs/${f.orgId}/members/${f.leaver.id}` });
    expect((await agentRow(f.agentId)).needs_reassignment).toBe(true);

    const bReq = await login("bystander");
    const denied = await bReq({
      method: "POST",
      url: url(),
      payload: { accountId: f.bystander.id },
    });
    expect(denied.statusCode).toBe(403);
    expect(errCode(denied)).toBe("forbidden");

    const notMember = await f.ownerReq({
      method: "POST",
      url: url(),
      payload: { accountId: f.leaver.id },
    });
    expect(notMember.statusCode).toBe(404);
    expect(errCode(notMember)).toBe("member.not_found");

    const bad = await f.ownerReq({ method: "POST", url: url(), payload: {} });
    expect(bad.statusCode).toBe(400);

    const ok = await f.ownerReq({
      method: "POST",
      url: url(),
      payload: { accountId: f.bystander.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({
      agent: { id: f.agentId, ownerAccountId: f.bystander.id, needsReassignment: false },
    });
    expect(await agentRow(f.agentId)).toEqual({
      owner_account_id: f.bystander.id,
      needs_reassignment: false,
    });
    const missing = await f.ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${f.orgId}/agents/${randomUUID()}/owner`,
      payload: { accountId: f.bystander.id },
    });
    expect(missing.statusCode).toBe(404);
    expect(errCode(missing)).toBe("agent.not_found");
  });
});

const runStatus = async (id: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirstOrThrow())
    .status;

describe("修复轮 1：离职中止此人在该组织进行中的运行", () => {
  it("移除成员后：该组织里等待中的运行被中止（写 run_aborted），别的组织的运行不动", async () => {
    const res = await f.ownerReq({
      method: "DELETE",
      url: `/api/v1/orgs/${f.orgId}/members/${f.leaver.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(await runStatus(f.runId)).toBe("aborted");
    expect(await runStatus(f.otherRunId)).toBe("waiting");
    const ev = await db
      .selectFrom("conversation_events")
      .select("type")
      .where("conversation_id", "=", f.conversationId)
      .where("type", "=", "run_aborted")
      .execute();
    expect(ev).toHaveLength(1);
  });

  it("提交后的中止没做成（如进程崩溃）→ 兜底扫描中止该运行", async () => {
    await db
      .transaction()
      .execute((t) => k.identity.offboarding.offboard(t, f.orgId, f.leaver.id, "directory"));
    expect(await runStatus(f.runId)).toBe("waiting");
    // 事务内只取消其作为处理人的审批
    expect(await status("approvals", f.approvalId)).toBe("cancelled");
    expect(await status("approvals", f.roleApprovalId)).toBe("pending");
    const n = await k.identity.offboarding.sweep();
    expect(n).toBe(1);
    expect(await runStatus(f.runId)).toBe("aborted");
    expect(await runStatus(f.otherRunId)).toBe("waiting");
    expect(await k.identity.offboarding.sweep()).toBe(0);
  });
});
