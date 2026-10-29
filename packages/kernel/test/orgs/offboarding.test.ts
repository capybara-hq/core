import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import type { ApiError } from "../../src/errors.js";
import type { Account, AccountsService } from "../../src/identity/accounts.js";
import type { ApiTokenService } from "../../src/identity/api-tokens.js";
import { createKernel, type Kernel } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import type { MembersService } from "../../src/orgs/members.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { SANDBOX_DESTROY_FOR_JOB } from "../../src/sandbox/jobs.js";
import { anonymousGuestsFor } from "../helpers/channels.js";
import { eventLogFor, legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { asUser, cookieJar } from "../helpers/http.js";
import {
  accountsFor,
  apiTokensFor,
  inTransaction,
  kernelTransaction,
  testOffboarding,
} from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { approvalsFor, credentialsFor, questionsFor } from "../helpers/tools.js";

const PW = "correct horse battery";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
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
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
      auth: { cookieSecure: false },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  await k.start();
  raw = createDb(pgc.url, 5);
  db = legacyDbFor(raw);
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
  connectorId: string;
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

async function insertConnector(orgId: string, slug: string, by: string): Promise<string> {
  const id = randomUUID();
  await sql`INSERT INTO capybara.connectors (id, org_id, slug, name, connector, auth, created_by)
    VALUES (${id}, ${orgId}, ${slug}, ${slug}, 'test',
      ${JSON.stringify({ type: "bearer", ownership: "personal" })}::jsonb, ${by})`.execute(raw);
  return id;
}

const personal = (accountId: string) => ({ kind: "user" as const, accountId });
const AUTH = { type: "bearer", ownership: "personal" } as never;

beforeEach(async () => {
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.secrets",
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

  const connectorId = await insertConnector(orgId, "docs", owner.id);
  const otherAppId = await insertConnector(otherOrgId, "docs", owner.id);
  const creds = k.tools.credentials;
  await creds.setStatic(orgId, connectorId, AUTH, personal(leaver.id), { token: "leaver-token" });
  await creds.setStatic(orgId, connectorId, AUTH, personal(bystander.id), { token: "b-token" });
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
    connectorId,
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
    connectorId,
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
      `org:credentials:app:${f.connectorId}:user:${f.bystander.id}`,
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
    const broken = testOffboarding(db, {
      credentials: credentialsFor(db, null as never),
      approvals: approvalsFor(db, eventLogFor(db, k.bus), () => k.config),
      questions: {
        cancelPendingFor: async () => {
          throw new Error("boom");
        },
      },
    });
    await expect(
      inTransaction(db, () => broken.offboard(f.orgId, f.leaver.id, "removed")),
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
      await codeOf(kernelTransaction(k, () => off.offboard(f.orgId, randomUUID(), "directory"))),
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
    await kernelTransaction(k, () =>
      k.identity.offboarding.offboard(f.orgId, f.leaver.id, "directory"),
    );
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

describe("兜底扫描：按创建时间分页、不碰现任成员的运行", () => {
  /** 在 f.orgId 里给 accountId 建一个会话与一个 running 的运行。 */
  async function runOf(accountId: string, createdAt: string): Promise<string> {
    const conv = randomUUID();
    const run = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${conv}, ${f.orgId}, ${f.agentId}, ${accountId})`.execute(raw);
    await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq, created_at)
      VALUES (${run}, ${conv}, 'running', 1, ${accountId}, 0, ${createdAt}::timestamptz)`.execute(
      raw,
    );
    return run;
  }

  it("现任成员（含匿名访客 guest 成员）的运行不被中止；超过一批的前成员运行全部处理", async () => {
    const anon = await anonymousGuestsFor(raw).ensure(f.orgId);
    const memberRun = await runOf(f.bystander.id, "2026-01-01T00:00:00Z");
    const anonRun = await runOf(anon, "2026-01-01T00:00:01Z");
    const formerRuns: string[] = [];
    for (let i = 0; i < 5; i++) {
      formerRuns.push(await runOf(f.leaver.id, `2026-01-02T00:00:0${i}Z`));
    }
    await db.transaction().execute(async (t) => {
      await t
        .deleteFrom("memberships")
        .where("org_id", "=", f.orgId)
        .where("account_id", "=", f.leaver.id)
        .execute();
    });
    const aborted: string[] = [];
    const sweeper = testOffboarding(
      db,
      {
        credentials: credentialsFor(db, null as never),
        approvals: approvalsFor(db, eventLogFor(db, k.bus), () => k.config),
        questions: questionsFor(db, eventLogFor(db, k.bus), () => k.config),
        offboardRuns: {
          abortWaiting: async () => false,
          abortIfOrphaned: async () => false,
          requestAbort: async (runId) => {
            aborted.push(runId);
          },
        },
      },
      { redis },
    );
    // pages of 2
    const n = await sweeper.sweep(2);
    // 前成员：fixture 里等待中的运行 + 5 个 running，分 2 条一批全部处理，按创建时间先后
    expect(n).toBe(6);
    expect(aborted).toEqual([...formerRuns, f.runId]);
    expect(aborted).not.toContain(memberRun);
    expect(aborted).not.toContain(anonRun);
    // 已请求中止、还在进行中的运行带着标记：下一轮不再重复广播
    expect(await redis.exists(`capk:offboard-abort:${f.runId}`)).toBe(1);
    expect(await sweeper.sweep(2)).toBe(0);
    expect(aborted).toHaveLength(6);
    // 标记过期后（真没停下来）再处理
    await redis.del(`capk:offboard-abort:${formerRuns[0]}`);
    expect(await sweeper.sweep(2)).toBe(1);
    expect(aborted.slice(6)).toEqual([formerRuns[0]]);
  });

  it("广播中止失败 → 不记标记，下一轮扫描重试", async () => {
    await db.transaction().execute(async (t) => {
      await t
        .deleteFrom("memberships")
        .where("org_id", "=", f.orgId)
        .where("account_id", "=", f.leaver.id)
        .execute();
    });
    let calls = 0;
    const sweeper = testOffboarding(
      db,
      {
        credentials: credentialsFor(db, null as never),
        approvals: approvalsFor(db, eventLogFor(db, k.bus), () => k.config),
        questions: questionsFor(db, eventLogFor(db, k.bus), () => k.config),
        offboardRuns: {
          abortWaiting: async () => false,
          abortIfOrphaned: async () => false,
          requestAbort: async () => {
            calls++;
            throw new Error("redis down");
          },
        },
      },
      { redis },
    );
    expect(await sweeper.sweep()).toBe(1);
    expect(await redis.exists(`capk:offboard-abort:${f.runId}`)).toBe(0);
    expect(await sweeper.sweep()).toBe(1);
    expect(calls).toBe(2);
  });
});

describe("修复波 W1：离职补漏", () => {
  /** f.orgId（及另一组织）里的一个渠道连接，返回连接 id。 */
  async function connection(orgId: string, agentId: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO capybara.channel_connections (id, org_id, plugin, name, agent_id, created_by)
      VALUES (${id}, ${orgId}, 'fake-im', 'bot', ${agentId}, ${f.owner.id})`.execute(raw);
    return id;
  }

  async function thread(connectionId: string, accountId: string, key: string): Promise<string> {
    const id = randomUUID();
    await sql`INSERT INTO capybara.channel_threads
        (id, connection_id, chat_id, thread_key, account_id, conversation_id)
      VALUES (${id}, ${connectionId}, 'chat-1', ${key}, ${accountId}, ${f.conversationId})`.execute(
      raw,
    );
    return id;
  }

  const archived = async (id: string) =>
    (
      await db
        .selectFrom("channel_threads")
        .select("archived_at")
        .where("id", "=", id)
        .executeTakeFirstOrThrow()
    ).archived_at !== null;

  it("归档离职者在该组织各连接上的 IM 话题行；别人的、别的组织的不动", async () => {
    const conn = await connection(f.orgId, f.agentId);
    const otherConn = await connection(f.otherOrgId, f.otherOrgAgentId);
    const mine = await thread(conn, f.leaver.id, "dm:u-leaver");
    const mineGroup = await thread(conn, f.leaver.id, "topic-1");
    const bystanders = await thread(conn, f.bystander.id, "dm:u-b");
    const otherOrg = await thread(otherConn, f.leaver.id, "dm:u-leaver");
    const res = await f.ownerReq({
      method: "DELETE",
      url: `/api/v1/orgs/${f.orgId}/members/${f.leaver.id}`,
    });
    expect(res.statusCode).toBe(204);
    expect(await archived(mine)).toBe(true);
    expect(await archived(mineGroup)).toBe(true);
    expect(await archived(bystanders)).toBe(false);
    expect(await archived(otherOrg)).toBe(false);
  });

  it("删除离职者在该组织的「以后都允许」工具授权；别的组织的、别人的不动", async () => {
    const grant = (orgId: string, accountId: string, agentId: string) =>
      sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
        VALUES (${orgId}, ${accountId}, ${agentId}, 'docs__create_doc', 'h')`.execute(raw);
    await grant(f.orgId, f.leaver.id, f.agentId);
    await grant(f.orgId, f.bystander.id, f.agentId);
    await grant(f.otherOrgId, f.leaver.id, f.otherOrgAgentId);
    const res = await f.leaverReq({ method: "POST", url: `/api/v1/orgs/${f.orgId}/leave` });
    expect(res.statusCode).toBe(204);
    const rows = await db
      .selectFrom("tool_grants")
      .select(["org_id", "account_id"])
      .orderBy("org_id")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual(
      expect.arrayContaining([
        { org_id: f.orgId, account_id: f.bystander.id },
        { org_id: f.otherOrgId, account_id: f.leaver.id },
      ]),
    );
  });

  it("事务回滚时话题行与工具授权都不变", async () => {
    const conn = await connection(f.orgId, f.agentId);
    const t1 = await thread(conn, f.leaver.id, "dm:u-leaver");
    await sql`INSERT INTO capybara.tool_grants (org_id, account_id, agent_id, tool_key, spec_hash)
      VALUES (${f.orgId}, ${f.leaver.id}, ${f.agentId}, 'docs__create_doc', 'h')`.execute(raw);
    await expect(
      kernelTransaction(k, async () => {
        await k.identity.offboarding.offboard(f.orgId, f.leaver.id, "removed");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await archived(t1)).toBe(false);
    expect(await db.selectFrom("tool_grants").select("account_id").execute()).toHaveLength(1);
  });
});

describe("修复波 W1：通讯录排除（Ruling A20）", () => {
  const exclusions = async (orgId: string) =>
    db
      .selectFrom("directory_exclusions")
      .select(["account_id", "plugin", "created_by"])
      .where("org_id", "=", orgId)
      .execute();

  const fromDirectory = (accountId: string) =>
    sql`UPDATE capybara.memberships SET source = 'directory:fake-im'
      WHERE org_id = ${f.orgId} AND account_id = ${accountId}`.execute(raw);

  it("移出通讯录加入的成员 → 同一事务写排除（created_by = 发起人）；本人离开同样写；没有启用通讯录插件的组织不写", async () => {
    await fromDirectory(f.leaver.id);
    await members.remove(f.orgId, f.leaver.id, f.owner.id);
    await fromDirectory(f.bystander.id);
    await members.leave(f.orgId, f.bystander.id);
    expect(await exclusions(f.orgId)).toEqual(
      expect.arrayContaining([
        { account_id: f.leaver.id, plugin: "fake-im", created_by: f.owner.id },
        { account_id: f.bystander.id, plugin: "fake-im", created_by: f.bystander.id },
      ]),
    );
    expect(await exclusions(f.orgId)).toHaveLength(2);
    // 另一个组织没有启用 fake-im（Ruling A24：只为启用的通讯录插件写排除）：移出不写排除
    expect(await exclusions(f.otherOrgId)).toEqual([]);
    await members.remove(f.otherOrgId, f.leaver.id, f.owner.id);
    expect(await exclusions(f.otherOrgId)).toEqual([]);
  });

  it("通讯录同步自己判定离职（reason = directory）不写排除", async () => {
    await fromDirectory(f.leaver.id);
    await kernelTransaction(k, () =>
      k.identity.offboarding.offboard(f.orgId, f.leaver.id, "directory"),
    );
    expect(await exclusions(f.orgId)).toEqual([]);
  });

  it("离职事务回滚 → 排除也不写", async () => {
    await fromDirectory(f.leaver.id);
    await expect(
      kernelTransaction(k, async () => {
        await k.identity.offboarding.offboard(f.orgId, f.leaver.id, "removed", {
          actorAccountId: f.owner.id,
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await exclusions(f.orgId)).toEqual([]);
  });

  it("手动重新加入（members.add，如接受邀请）清除排除", async () => {
    await fromDirectory(f.leaver.id);
    await members.remove(f.orgId, f.leaver.id, f.owner.id);
    expect(await exclusions(f.orgId)).toHaveLength(1);
    await members.add(f.orgId, f.leaver.id, "member", f.owner.id);
    expect(await exclusions(f.orgId)).toEqual([]);
  });
});

describe("修复波 W1：匿名访客保护", () => {
  let guestId: string;
  beforeEach(async () => {
    guestId = await anonymousGuestsFor(raw).ensure(f.orgId);
  });

  it("不能改角色、不能被授予 owner", async () => {
    for (const role of ["member", "admin", "owner"] as const) {
      const res = await f.ownerReq({
        method: "PATCH",
        url: `/api/v1/orgs/${f.orgId}/members/${guestId}`,
        payload: { role },
      });
      expect(res.statusCode, role).toBe(409);
      expect(errCode(res)).toBe("member.anonymous_guest");
    }
    expect(
      (
        await db
          .selectFrom("memberships")
          .select("role")
          .where("org_id", "=", f.orgId)
          .where("account_id", "=", guestId)
          .executeTakeFirstOrThrow()
      ).role,
    ).toBe("guest");
  });

  it("不能接受所有权转让", async () => {
    const res = await f.ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${f.orgId}/transfer`,
      payload: { toAccountId: guestId },
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("member.anonymous_guest");
  });

  it("不能被指派为 agent 负责人", async () => {
    const res = await f.ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${f.orgId}/agents/${f.agentId}/owner`,
      payload: { accountId: guestId },
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("member.anonymous_guest");
    expect((await agentRow(f.agentId)).owner_account_id).toBe(f.leaver.id);
  });

  it("不能被移出；成员列表把它标为匿名访客", async () => {
    const res = await f.ownerReq({
      method: "DELETE",
      url: `/api/v1/orgs/${f.orgId}/members/${guestId}`,
    });
    expect(res.statusCode).toBe(409);
    expect(errCode(res)).toBe("member.anonymous_guest");
    expect(await isMember(f.orgId, guestId)).toBe(true);
    const list = await f.ownerReq({ method: "GET", url: `/api/v1/orgs/${f.orgId}/members` });
    const rows = (list.json() as { members: { account: { id: string }; anonymous: boolean }[] })
      .members;
    expect(rows.find((m) => m.account.id === guestId)?.anonymous).toBe(true);
    expect(rows.find((m) => m.account.id === f.owner.id)?.anonymous).toBe(false);
  });

  it("不能被加入别的组织（members.add / 接受邀请）", async () => {
    expect(await codeOf(members.add(f.otherOrgId, guestId, "member", f.owner.id))).toBe(
      "member.anonymous_guest",
    );
    expect(await isMember(f.otherOrgId, guestId)).toBe(false);
  });
});

describe("修复波 S2：离职销毁此人对话的沙箱", () => {
  it("offboard 记下此人在该组织还没销毁的沙箱，提交后交给 sandboxes.destroy；别人的、别的组织的、已销毁的不算", async () => {
    const conv = async (orgId: string, agentId: string, accountId: string) => {
      const id = randomUUID();
      await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
        VALUES (${id}, ${orgId}, ${agentId}, ${accountId})`.execute(raw);
      return id;
    };
    const box = (conversationId: string, orgId: string, status: string) =>
      sql`INSERT INTO capybara.sandboxes (conversation_id, org_id, provider, status)
        VALUES (${conversationId}, ${orgId}, 'sandbox-fake', ${status})`.execute(raw);
    const suspended = await conv(f.orgId, f.agentId, f.leaver.id);
    const gone = await conv(f.orgId, f.agentId, f.leaver.id);
    const others = await conv(f.orgId, f.agentId, f.bystander.id);
    const otherOrg = await conv(f.otherOrgId, f.otherOrgAgentId, f.leaver.id);
    await box(f.conversationId, f.orgId, "running");
    await box(suspended, f.orgId, "suspended");
    await box(gone, f.orgId, "destroyed");
    await box(others, f.orgId, "running");
    await box(otherOrg, f.otherOrgId, "running");
    try {
      const scheduled: string[][] = [];
      const off = testOffboarding(db, {
        credentials: credentialsFor(db, null as never),
        approvals: approvalsFor(db, eventLogFor(db, k.bus), () => k.config),
        questions: questionsFor(db, eventLogFor(db, k.bus), () => k.config),
        sandboxDestroy: {
          destroy: async (ids) => {
            scheduled.push(ids);
          },
        },
      });
      const r = await inTransaction(db, () => off.offboard(f.orgId, f.leaver.id, "removed"));
      expect([...r.sandboxConversations].sort()).toEqual([f.conversationId, suspended].sort());
      await off.afterOffboard(r);
      expect(scheduled.map((ids) => [...ids].sort())).toEqual([
        [f.conversationId, suspended].sort(),
      ]);
    } finally {
      await sql`DELETE FROM capybara.sandboxes`.execute(raw);
    }
  });

  it("投递失败只记 warn，不让离职失败", async () => {
    await sql`INSERT INTO capybara.sandboxes (conversation_id, org_id, provider, status)
      VALUES (${f.conversationId}, ${f.orgId}, 'sandbox-fake', 'running')`.execute(raw);
    try {
      const warns: string[] = [];
      const off = testOffboarding(
        db,
        {
          credentials: credentialsFor(db, null as never),
          approvals: approvalsFor(db, eventLogFor(db, k.bus), () => k.config),
          questions: questionsFor(db, eventLogFor(db, k.bus), () => k.config),
          sandboxDestroy: {
            destroy: async () => {
              throw new Error("queue down");
            },
          },
        },
        { log: { warn: (m: string) => void warns.push(m) } },
      );
      const r = await inTransaction(db, () => off.offboard(f.orgId, f.leaver.id, "removed"));
      await off.afterOffboard(r);
      expect(warns).toContain("offboarding: cannot schedule sandbox destruction");
      expect(await isMember(f.orgId, f.leaver.id)).toBe(false);
    } finally {
      await sql`DELETE FROM capybara.sandboxes`.execute(raw);
    }
  });

  it("内核：删除 agent 投递 sandbox-destroy-for（它各对话还没销毁的沙箱；已销毁的不算）", async () => {
    const { agent_id: agentId } = await db
      .selectFrom("conversations")
      .select("agent_id")
      .where("id", "=", f.conversationId)
      .executeTakeFirstOrThrow();
    const other = randomUUID();
    await sql`INSERT INTO capybara.conversations (id, org_id, agent_id, account_id)
      VALUES (${other}, ${f.orgId}, ${agentId}, ${f.leaver.id})`.execute(raw);
    await sql`INSERT INTO capybara.sandboxes (conversation_id, org_id, provider, status)
      VALUES (${f.conversationId}, ${f.orgId}, 'sandbox-fake', 'running'),
             (${other}, ${f.orgId}, 'sandbox-fake', 'destroyed')`.execute(raw);
    const q = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
    // 内核自己的维护 worker 会立刻执行并删掉完成的任务（removeOnComplete）：暂停队列，读到的才是投递的任务
    await q.pause();
    try {
      const res = await f.ownerReq({
        method: "DELETE",
        url: `/api/v1/orgs/${f.orgId}/agents/${agentId}`,
      });
      expect(res.statusCode, res.body).toBe(204);
      const jobs = await q.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
      const job = jobs.find((j) => j.name === SANDBOX_DESTROY_FOR_JOB);
      expect(job?.data).toEqual({ conversationIds: [f.conversationId] });
    } finally {
      await q.resume();
      await q.close();
      await sql`DELETE FROM capybara.sandboxes`.execute(raw);
    }
  });

  it("内核：离职投递 sandbox-destroy-for 维护任务（数据为对话 id）", async () => {
    await sql`INSERT INTO capybara.sandboxes (conversation_id, org_id, provider, status)
      VALUES (${f.conversationId}, ${f.orgId}, 'sandbox-fake', 'running')`.execute(raw);
    const q = new Queue(MAINTENANCE_QUEUE_NAME, { connection: new Redis(rd.url) });
    // 内核自己的维护 worker 会立刻执行并删掉完成的任务（removeOnComplete）：暂停队列，读到的才是投递的任务
    await q.pause();
    try {
      const res = await f.ownerReq({
        method: "DELETE",
        url: `/api/v1/orgs/${f.orgId}/members/${f.leaver.id}`,
      });
      expect(res.statusCode).toBe(204);
      const jobs = await q.getJobs(["waiting", "delayed", "active", "completed", "failed"]);
      const job = jobs.find((j) => j.name === SANDBOX_DESTROY_FOR_JOB);
      expect(job?.data).toEqual({ conversationIds: [f.conversationId] });
    } finally {
      await q.resume();
      await q.close();
      await sql`DELETE FROM capybara.sandboxes`.execute(raw);
    }
  });
});
