import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  fakeDirectoryMember as person,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureAnonymousGuest } from "../../src/channels/threads.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { type Account, AccountsService } from "../../src/identity/accounts.js";
import { ApiTokenService } from "../../src/identity/api-tokens.js";
import type { Kernel } from "../../src/kernel.js";
import {
  DIRECTORY_SYNC_LOCK_PREFIX,
  DirectorySync,
  directorySyncDirtyKey,
  directorySyncJobId,
  hourBucket,
  minuteBucket,
} from "../../src/orgs/directory-sync.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Task 12 通讯录同步（Review Focus 4）：只撤销由该通讯录同步加入的成员关系；离职在一个事务内吊销会话与令牌、
 * 删除其在该组织的个人凭据、转交其 agent；手动加入的成员不被同步删除；中途失败不删人。
 */

const DIR_MINI = fileURLToPath(new URL("../fixtures/plugins/dir-mini/index.ts", import.meta.url));
const DIR_OPT = fileURLToPath(new URL("../fixtures/plugins/dir-opt/index.ts", import.meta.url));
const SOURCE = "dir-mini:t1";
const DIR_SOURCE = "directory:dir-mini";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let redis: Redis;
let fd: FakeChannelServer;
let accounts: AccountsService;
let owner: Account;
let ownerReq: Req;
let queue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  fd = await startFakeChannelServer();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { plugins: [MODEL_FAKE, DIR_MINI, DIR_OPT], auth: { cookieSecure: false } },
    ),
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  queue = new Queue(MAINTENANCE_QUEUE_NAME, {
    connection: new Redis(rd.url, { maxRetriesPerRequest: null }),
  });
  accounts = new AccountsService(db);
  owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  ownerReq = await session(k, "owner");
}, 120_000);

afterAll(async () => {
  await queue?.close();
  await k?.stop();
  redis?.disconnect();
  await raw?.destroy();
  await fd?.stop();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let orgSeq = 0;
/** 新建组织并启用 dir-mini（组织配置指向一份新的假通讯录）。 */
async function setupOrg(): Promise<{ orgId: string; book: ReturnType<FakeChannelServer["book"]> }> {
  orgSeq++;
  const orgId = await createOrg(ownerReq, `Dir ${orgSeq}`);
  const book = fd.book(`o${orgSeq}`);
  const res = await ownerReq({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/dir-mini`,
    payload: { enabled: true, config: { url: book.url } },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { orgId, book };
}

const sync = (orgId: string) => k.identity.directory.sync(orgId, "dir-mini");

interface MemberRow {
  account_id: string;
  role: string;
  source: string | null;
}
const membersOf = async (orgId: string): Promise<MemberRow[]> =>
  db
    .selectFrom("memberships")
    .select(["account_id", "role", "source"])
    .where("org_id", "=", orgId)
    .execute();

const accountOf = async (externalId: string): Promise<string | undefined> =>
  (
    await db
      .selectFrom("identities")
      .select("account_id")
      .where("source", "=", SOURCE)
      .where("external_id", "=", externalId)
      .executeTakeFirst()
  )?.account_id;

const memberOf = async (orgId: string, externalId: string) => {
  const id = await accountOf(externalId);
  return (await membersOf(orgId)).find((m) => m.account_id === id);
};

const audits = async (orgId: string, action: string) =>
  db
    .selectFrom("audit_events")
    .select(["actor_account_id", "target", "detail"])
    .where("org_id", "=", orgId)
    .where("action", "=", action)
    .orderBy("id")
    .execute();

async function linkIdentity(accountId: string, externalId: string): Promise<void> {
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES (${SOURCE}, ${externalId}, ${accountId})`.execute(raw);
}

async function addManual(orgId: string, accountId: string, role = "member"): Promise<void> {
  await sql`INSERT INTO capybara.memberships (org_id, account_id, role)
    VALUES (${orgId}, ${accountId}, ${role})`.execute(raw);
}

describe("通讯录同步", () => {
  it("加入在职成员（角色 member、source = directory:<插件>）；不重复加入；离职 / 不再出现的移除；手动成员不动；再入职重新加入", async () => {
    const { orgId, book } = await setupOrg();
    // 手动加入的成员：一个与通讯录无关，一个在通讯录里也有（之后在通讯录中离职）
    const manual = await accounts.createLocal({ login: "manual1", password: PW, displayName: "M" });
    await addManual(orgId, manual.id);
    const dave = await accounts.createLocal({ login: "dave1", password: PW, displayName: "Dave" });
    await linkIdentity(dave.id, "u-dave");
    await addManual(orgId, dave.id);
    // T10 的匿名访客（source = "anonymous"）：同步永远不碰
    const guestId = await ensureAnonymousGuest(db, orgId);

    book.members = [person("u-alice"), person("u-bob"), person("u-carol"), person("u-dave")];
    const r1 = await sync(orgId);
    expect(r1).toEqual({
      status: "synced",
      added: 3,
      removed: 0,
      skippedLastOwner: 0,
      failed: 0,
      total: 4,
      partial: false,
      removalBlocked: false,
    });
    for (const ext of ["u-alice", "u-bob", "u-carol"]) {
      expect(await memberOf(orgId, ext)).toMatchObject({ role: "member", source: DIR_SOURCE });
    }
    // 手动加入的 dave 已是成员：不改其 source
    expect(await memberOf(orgId, "u-dave")).toMatchObject({ source: null });
    // 新账号：不受信任的来源 → 邮箱不算已验证；不建会话
    const aliceId = (await accountOf("u-alice")) as string;
    const alice = await db
      .selectFrom("accounts")
      .select(["email", "email_verified", "display_name"])
      .where("id", "=", aliceId)
      .executeTakeFirstOrThrow();
    expect(alice).toEqual({
      email: "u-alice@corp.example",
      email_verified: false,
      display_name: "u-alice",
    });
    const sessions = await db
      .selectFrom("sessions")
      .select("id")
      .where("account_id", "=", aliceId)
      .execute();
    expect(sessions).toEqual([]);
    const added = await audits(orgId, "org.member.added");
    expect(added).toHaveLength(3);
    expect(added[0]?.detail).toMatchObject({ role: "member", source: DIR_SOURCE });

    // 再同步一次：不重复加入
    expect(await sync(orgId)).toMatchObject({ added: 0, removed: 0, total: 4 });

    // bob 离职（active=false）、carol 不再出现、dave（手动加入）离职、manual 从来不在通讯录
    const bobId = (await accountOf("u-bob")) as string;
    const carolId = (await accountOf("u-carol")) as string;
    book.members = [
      person("u-alice"),
      person("u-bob", { active: false }),
      person("u-dave", { active: false }),
    ];
    const r3 = await sync(orgId);
    expect(r3).toMatchObject({
      status: "synced",
      added: 0,
      removed: 2,
      skippedLastOwner: 0,
      total: 3,
      partial: false,
    });
    const after = await membersOf(orgId);
    const ids = after.map((m) => m.account_id);
    expect(ids).toContain(aliceId);
    expect(ids).toContain(manual.id);
    expect(ids).toContain(dave.id);
    expect(ids).toContain(owner.id);
    expect(ids).not.toContain(bobId);
    expect(ids).not.toContain(carolId);
    expect(after.find((m) => m.account_id === guestId)).toMatchObject({ source: "anonymous" });
    // 账号不被停用，只失去成员关系
    const statuses = await db
      .selectFrom("accounts")
      .select(["id", "status"])
      .where("id", "in", [bobId, carolId])
      .execute();
    expect(statuses.map((s) => s.status)).toEqual(["active", "active"]);
    const off = await audits(orgId, "org.member.offboarded");
    expect(off.map((a) => a.target).sort()).toEqual([bobId, carolId].sort());
    expect(off[0]?.detail).toMatchObject({ reason: "directory" });

    // bob 再入职：重新加入，仍是原账号
    book.members = [person("u-alice"), person("u-bob")];
    expect(await sync(orgId)).toMatchObject({ added: 1, removed: 0 });
    expect(await memberOf(orgId, "u-bob")).toMatchObject({
      account_id: bobId,
      role: "member",
      source: DIR_SOURCE,
    });

    const synced = await audits(orgId, "org.directory.synced");
    expect(synced).toHaveLength(4);
    expect(synced[2]?.target).toBe("dir-mini");
    expect(synced[2]?.detail).toMatchObject({
      plugin: "dir-mini",
      added: 0,
      removed: 2,
      skippedLastOwner: 0,
      total: 3,
      partial: false,
    });
  });

  it("分页中途失败：已处理的照常加入，但不移除任何人（审计 partial = true）", async () => {
    const { orgId, book } = await setupOrg();
    book.pageSize = 2;
    book.members = [person("p-1"), person("p-2"), person("p-3"), person("p-4")];
    expect(await sync(orgId)).toMatchObject({ added: 4, partial: false });
    // p-2 离职、p-3 不再出现，新来 p-5（在第 0 页）；第 1 页失败
    book.members = [person("p-1"), person("p-5"), person("p-2", { active: false }), person("p-4")];
    book.failOnPage = 1;
    const r = await sync(orgId);
    expect(r).toMatchObject({ status: "synced", added: 1, removed: 0, total: 2, partial: true });
    for (const ext of ["p-1", "p-2", "p-3", "p-4", "p-5"]) {
      expect(await memberOf(orgId, ext), ext).toBeDefined();
    }
    const synced = await audits(orgId, "org.directory.synced");
    expect(synced.at(-1)?.detail).toMatchObject({ added: 1, removed: 0, partial: true });
    expect(await audits(orgId, "org.member.offboarded")).toEqual([]);

    // 恢复后整轮完成：才移除
    book.failOnPage = null;
    expect(await sync(orgId)).toMatchObject({ added: 0, removed: 2, partial: false });
    expect(await memberOf(orgId, "p-2")).toBeUndefined();
    expect(await memberOf(orgId, "p-3")).toBeUndefined();
  });

  it("成员资料不合规（解析外部身份失败）也算不完整：不移除任何人", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("q-1"), person("q-2")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    book.members = [person("q-1"), person("", { tenantId: "t1" })];
    const r = await sync(orgId);
    expect(r).toMatchObject({ added: 0, removed: 0, failed: 1, partial: true });
    expect(await memberOf(orgId, "q-2")).toBeDefined();
  });

  it("最后一个 owner 离职：跳过此人并计入审计", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("boss"), person("staff")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    const bossId = (await accountOf("boss")) as string;
    // boss 被提升为唯一的 owner（原 owner 降为 admin）
    await sql`UPDATE capybara.memberships SET role = 'owner'
      WHERE org_id = ${orgId} AND account_id = ${bossId}`.execute(raw);
    await sql`UPDATE capybara.memberships SET role = 'admin'
      WHERE org_id = ${orgId} AND account_id = ${owner.id}`.execute(raw);
    book.members = [person("boss", { active: false })];
    const r = await sync(orgId);
    expect(r).toMatchObject({ removed: 1, skippedLastOwner: 1, failed: 0, partial: false });
    expect(await memberOf(orgId, "boss")).toMatchObject({ role: "owner", source: DIR_SOURCE });
    expect(await memberOf(orgId, "staff")).toBeUndefined();
    const synced = await audits(orgId, "org.directory.synced");
    expect(synced.at(-1)?.detail).toMatchObject({ removed: 1, skippedLastOwner: 1 });
    await sql`UPDATE capybara.memberships SET role = 'owner'
      WHERE org_id = ${orgId} AND account_id = ${owner.id}`.execute(raw);
  });

  describe("Review Focus 4：同步时有人离职", () => {
    const AUTH = { type: "bearer", ownership: "personal" } as never;
    const personal = (accountId: string) => ({ kind: "user" as const, accountId });

    async function insertConnector(orgId: string, slug: string): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO capybara.connectors (id, org_id, slug, name, connector, auth, created_by)
        VALUES (${id}, ${orgId}, ${slug}, ${slug}, 'test',
          ${JSON.stringify({ type: "bearer", ownership: "personal" })}::jsonb, ${owner.id})`.execute(
        raw,
      );
      return id;
    }

    async function insertAgent(orgId: string, ownerId: string): Promise<string> {
      const id = randomUUID();
      await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
        VALUES (${id}, ${orgId}, ${ownerId}, 'org', 1)`.execute(raw);
      await sql`INSERT INTO capybara.agent_versions (agent_id, version, definition, created_by)
        VALUES (${id}, 1, ${JSON.stringify({ name: "Writer" })}::jsonb, ${ownerId})`.execute(raw);
      return id;
    }

    /** 由通讯录加入的 leaver：两个会话、一个个人令牌、本组织与另一组织的个人凭据、本组织与另一组织的 agent。 */
    async function leaverFixture(login: string) {
      const { orgId, book } = await setupOrg();
      const otherOrgId = await createOrg(ownerReq, `Other ${login}`);
      const leaver = await accounts.createLocal({ login, password: PW, displayName: "Leaver" });
      await linkIdentity(leaver.id, `ext-${login}`);
      book.members = [person(`ext-${login}`)];
      expect(await sync(orgId)).toMatchObject({ added: 1 });
      expect(await memberOf(orgId, `ext-${login}`)).toMatchObject({
        account_id: leaver.id,
        source: DIR_SOURCE,
      });
      await addManual(otherOrgId, leaver.id);
      const req1 = await session(k, login);
      await session(k, login);
      const pat = (await new ApiTokenService(db).createPersonal(leaver.id, { name: "cli" })).token;
      const connectorId = await insertConnector(orgId, `docs-${login}`);
      const otherAppId = await insertConnector(otherOrgId, `docs-${login}`);
      const creds = k.tools.credentials;
      await creds.setStatic(orgId, connectorId, AUTH, personal(leaver.id), { token: "mine" });
      await creds.setStatic(orgId, connectorId, AUTH, personal(owner.id), { token: "owners" });
      await creds.setStatic(otherOrgId, otherAppId, AUTH, personal(leaver.id), { token: "other" });
      const agentId = await insertAgent(orgId, leaver.id);
      const otherAgentId = await insertAgent(otherOrgId, leaver.id);
      return { orgId, otherOrgId, book, leaver, req1, pat, agentId, otherAgentId, login };
    }

    const secretOwners = async (orgId: string) =>
      (
        await db
          .selectFrom("secrets")
          .select("key")
          .where("org_id", "=", orgId)
          .where("key", "like", "credentials:%")
          .execute()
      )
        .map((r) => r.key)
        .sort();

    it("只撤销同步加入的成员关系；同一事务内吊销会话与令牌、删本组织个人凭据、agent 转给所有者并标记", async () => {
      const f = await leaverFixture("leaver1");
      f.book.members = [];
      expect(await sync(f.orgId)).toMatchObject({ removed: 1, partial: false });

      expect(await memberOf(f.orgId, `ext-${f.login}`)).toBeUndefined();
      // 另一组织的手动成员关系不动
      expect(
        (await membersOf(f.otherOrgId)).find((m) => m.account_id === f.leaver.id),
      ).toBeDefined();
      const live = await db
        .selectFrom("sessions")
        .select("id")
        .where("account_id", "=", f.leaver.id)
        .where("revoked_at", "is", null)
        .execute();
      expect(live).toEqual([]);
      expect((await f.req1({ method: "GET", url: "/api/v1/me" })).statusCode).toBe(401);
      const tokens = await db
        .selectFrom("api_tokens")
        .select("revoked_at")
        .where("account_id", "=", f.leaver.id)
        .execute();
      expect(tokens).toHaveLength(1);
      expect(tokens[0]?.revoked_at).not.toBeNull();
      const pat = await k.http.inject({
        method: "GET",
        url: "/api/v1/me",
        headers: { authorization: `Bearer ${f.pat}` },
      });
      expect(pat.statusCode).toBe(401);
      // 本组织：只剩 owner 的个人凭据；另一组织：leaver 的凭据仍在
      const mine = await secretOwners(f.orgId);
      expect(mine.some((key) => key.includes(f.leaver.id))).toBe(false);
      expect(mine.some((key) => key.includes(owner.id))).toBe(true);
      expect((await secretOwners(f.otherOrgId)).some((key) => key.includes(f.leaver.id))).toBe(
        true,
      );
      const agent = await db
        .selectFrom("agents")
        .select(["owner_account_id", "needs_reassignment"])
        .where("id", "=", f.agentId)
        .executeTakeFirstOrThrow();
      expect(agent).toEqual({ owner_account_id: owner.id, needs_reassignment: true });
      const otherAgent = await db
        .selectFrom("agents")
        .select(["owner_account_id", "needs_reassignment"])
        .where("id", "=", f.otherAgentId)
        .executeTakeFirstOrThrow();
      expect(otherAgent).toEqual({ owner_account_id: f.leaver.id, needs_reassignment: false });
    });

    it("离职处理在一个事务内：事务中途失败则全部不生效，计入 failed", async () => {
      const f = await leaverFixture("leaver2");
      const ds = new DirectorySync({
        db,
        redis,
        host: k.host,
        orgPluginConfigs: k.orgPluginConfigs,
        external: k.identity.external,
        offboarding: {
          offboard: async (...args) => {
            await k.identity.offboarding.offboard(...args);
            throw new Error("boom after offboard");
          },
          afterCommit: (r) => k.identity.offboarding.afterCommit(r),
        },
        log: k.log,
      });
      f.book.members = [];
      expect(await ds.sync(f.orgId, "dir-mini")).toMatchObject({
        removed: 0,
        failed: 1,
        partial: false,
      });
      expect(await memberOf(f.orgId, `ext-${f.login}`)).toMatchObject({ source: DIR_SOURCE });
      const live = await db
        .selectFrom("sessions")
        .select("id")
        .where("account_id", "=", f.leaver.id)
        .where("revoked_at", "is", null)
        .execute();
      expect(live).toHaveLength(2);
      expect((await secretOwners(f.orgId)).some((key) => key.includes(f.leaver.id))).toBe(true);
      const agent = await db
        .selectFrom("agents")
        .select(["owner_account_id", "needs_reassignment"])
        .where("id", "=", f.agentId)
        .executeTakeFirstOrThrow();
      expect(agent).toEqual({ owner_account_id: f.leaver.id, needs_reassignment: false });
    });
  });

  it("插件已停用 / 不提供通讯录：同步任务什么都不做（陈旧任务无操作）", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("s-1")];
    const off = await ownerReq({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/dir-mini`,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect(await sync(orgId)).toEqual({ status: "skipped", reason: "not_enabled" });
    expect(await k.identity.directory.sync(orgId, "model-fake")).toEqual({
      status: "skipped",
      reason: "plugin_unavailable",
    });
    expect(book.requests).toEqual([]);
    expect(await audits(orgId, "org.directory.synced")).toEqual([]);
  });

  it("同一 (组织, 插件) 已有同步在跑（锁被占）：本次结束并记下脏标记；持有者跑完后补一轮", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("l-1")];
    const lock = new ConversationLock(redis, undefined, DIRECTORY_SYNC_LOCK_PREFIX);
    const lease = await lock.acquire(`${orgId}:dir-mini`, "other-replica");
    expect(lease).not.toBeNull();
    expect(await sync(orgId)).toEqual({ status: "skipped", reason: "locked" });
    expect(book.requests).toEqual([]);
    const dirty = directorySyncDirtyKey(orgId, "dir-mini");
    expect(await redis.get(dirty)).toBe("1");
    const ttl = await redis.ttl(dirty);
    expect(ttl).toBeGreaterThan(3500);
    expect(ttl).toBeLessThanOrEqual(3600);
    await lease?.release();
    // 这一轮跑完时取走脏标记，投递一次 changed 同步（worker 执行）
    expect(await sync(orgId)).toMatchObject({ status: "synced", added: 1 });
    expect(await redis.get(dirty)).toBeNull();
    await waitFor(async () => book.starts() === 2, 15_000, "rerun after dirty flag");
    const synced = await waitFor(
      async () => {
        const rows = await audits(orgId, "org.directory.synced");
        return rows.length === 2 ? rows : undefined;
      },
      15_000,
      "rerun audit",
    );
    expect(synced[1]?.detail).toMatchObject({ trigger: "changed", added: 0 });
  });

  describe("Ruling A17：大批移除保护（非手动触发）", () => {
    const blocked = (orgId: string) => audits(orgId, "org.directory.removal_blocked");

    it("计划移除数超过 max(5, 20%)：本轮当作不完整，不移除任何人并审计；手动触发不受限", async () => {
      const { orgId, book } = await setupOrg();
      const all = Array.from({ length: 10 }, (_, i) => person(`g-${i}`));
      book.members = all;
      expect(await sync(orgId)).toMatchObject({ added: 10 });
      book.members = all.slice(0, 4); // 计划移除 6 > max(5, 2)
      const r = await k.identity.directory.sync(orgId, "dir-mini", { trigger: "schedule" });
      expect(r).toMatchObject({ removed: 0, partial: true, removalBlocked: true });
      expect((await membersOf(orgId)).filter((m) => m.source === DIR_SOURCE)).toHaveLength(10);
      const b = await blocked(orgId);
      expect(b).toHaveLength(1);
      expect(b[0]?.target).toBe("dir-mini");
      expect(b[0]?.detail).toMatchObject({
        plugin: "dir-mini",
        trigger: "schedule",
        planned: 6,
        existing: 10,
        active: 4,
        threshold: 5,
      });
      expect((await audits(orgId, "org.directory.synced")).at(-1)?.detail).toMatchObject({
        partial: true,
        removed: 0,
      });
      // changed 同样受限
      expect(
        await k.identity.directory.sync(orgId, "dir-mini", { trigger: "changed" }),
      ).toMatchObject({ removed: 0, removalBlocked: true });
      // 手动触发：照常移除
      expect(
        await k.identity.directory.sync(orgId, "dir-mini", { trigger: "manual" }),
      ).toMatchObject({ removed: 6, partial: false, removalBlocked: false });
    });

    it("恰好等于阈值：照常移除", async () => {
      const { orgId, book } = await setupOrg();
      const all = Array.from({ length: 10 }, (_, i) => person(`e-${i}`));
      book.members = all;
      expect(await sync(orgId)).toMatchObject({ added: 10 });
      book.members = all.slice(0, 5); // 计划移除 5 = max(5, 2)
      expect(
        await k.identity.directory.sync(orgId, "dir-mini", { trigger: "schedule" }),
      ).toMatchObject({ removed: 5, partial: false, removalBlocked: false });
      expect(await blocked(orgId)).toEqual([]);
    });

    it("列表里一个在职的人都没有、而已有通讯录成员：不移除", async () => {
      const { orgId, book } = await setupOrg();
      book.members = [person("z-1"), person("z-2")];
      expect(await sync(orgId)).toMatchObject({ added: 2 });
      book.members = [person("z-1", { active: false })];
      expect(
        await k.identity.directory.sync(orgId, "dir-mini", { trigger: "schedule" }),
      ).toMatchObject({ removed: 0, partial: true, removalBlocked: true });
      book.members = [];
      expect(
        await k.identity.directory.sync(orgId, "dir-mini", { trigger: "changed" }),
      ).toMatchObject({ removed: 0, partial: true, removalBlocked: true });
      const b = await blocked(orgId);
      expect(b).toHaveLength(2);
      expect(b[1]?.detail).toMatchObject({ planned: 2, existing: 2, active: 0 });
      expect((await membersOf(orgId)).filter((m) => m.source === DIR_SOURCE)).toHaveLength(2);
    });
  });

  it("任务 id：小时桶 / 分钟桶不含 ':'", () => {
    const at = new Date("2026-10-20T14:05:09Z");
    expect(hourBucket(at)).toBe("2026102014");
    expect(minuteBucket(at)).toBe("202610201405");
    expect(directorySyncJobId("o1", "dir-mini", "schedule", at)).toBe(
      "directory-sync-o1-dir-mini-2026102014",
    );
    expect(directorySyncJobId("o1", "dir-mini", "changed", at)).toBe(
      "directory-sync-o1-dir-mini-changed-202610201405",
    );
    const manual = directorySyncJobId("o1", "dir-mini", "manual", at);
    expect(manual).toMatch(/^directory-sync-o1-dir-mini-manual-[0-9a-f-]{36}$/);
    expect(directorySyncJobId("o1", "dir-mini", "manual", at)).not.toBe(manual);
    for (const id of [manual, hourBucket(at), minuteBucket(at)]) expect(id).not.toContain(":");
  });

  describe("手动触发 POST /orgs/:orgId/plugins/:plugin/directory/sync", () => {
    const path = (orgId: string, plugin = "dir-mini") =>
      `/api/v1/orgs/${orgId}/plugins/${plugin}/directory/sync`;
    const code = (res: { json(): unknown }) =>
      (res.json() as { error?: { code?: string } }).error?.code;

    it("鉴权：未登录 401、非成员 404、member 403、服务令牌 403；插件不提供 404、未启用 409", async () => {
      const { orgId, book } = await setupOrg();
      book.members = [person("h-1")];
      expect((await k.http.inject({ method: "POST", url: path(orgId) })).statusCode).toBe(401);

      const outsider = await accounts.createLocal({
        login: "outsider-h",
        password: PW,
        displayName: "O",
      });
      const plain = await accounts.createLocal({
        login: "plain-h",
        password: PW,
        displayName: "P",
      });
      await addManual(orgId, plain.id, "member");
      void outsider;
      const outReq = await session(k, "outsider-h");
      const r404 = await outReq({ method: "POST", url: path(orgId) });
      expect([r404.statusCode, code(r404)]).toEqual([404, "org.not_found"]);
      const plainReq = await session(k, "plain-h");
      const r403 = await plainReq({ method: "POST", url: path(orgId) });
      expect([r403.statusCode, code(r403)]).toEqual([403, "forbidden"]);
      const svc = await new ApiTokenService(db).createService(orgId, {
        name: "svc",
        role: "admin",
        createdBy: owner.id,
      });
      const rsvc = await k.http.inject({
        method: "POST",
        url: path(orgId),
        headers: { authorization: `Bearer ${svc.token}` },
      });
      expect(rsvc.statusCode).toBe(403);

      const rnf = await ownerReq({ method: "POST", url: path(orgId, "model-fake") });
      expect([rnf.statusCode, code(rnf)]).toEqual([404, "plugin.not_found"]);
      const other = await createOrg(ownerReq, "No dir");
      const rne = await ownerReq({ method: "POST", url: path(other) });
      expect([rne.statusCode, code(rne)]).toEqual([409, "plugin.not_enabled"]);
      expect(book.requests).toEqual([]);
    });

    it("admin 触发 → 202 带 job id，任务在 worker 上执行同步并以发起人写审计", async () => {
      const { orgId, book } = await setupOrg();
      book.members = [person("h-2")];
      const admin = await accounts.createLocal({
        login: "admin-h",
        password: PW,
        displayName: "A",
      });
      await addManual(orgId, admin.id, "admin");
      const adminReq = await session(k, "admin-h");
      const res = await adminReq({ method: "POST", url: path(orgId) });
      expect(res.statusCode, res.body).toBe(202);
      const { jobId } = res.json() as { jobId: string };
      expect(jobId).toMatch(new RegExp(`^directory-sync-${orgId}-dir-mini-manual-`));
      const synced = await waitFor(
        async () => (await audits(orgId, "org.directory.synced"))[0],
        15_000,
        "directory sync audit",
      );
      expect(synced.actor_account_id).toBe(admin.id);
      expect(synced.detail).toMatchObject({ trigger: "manual", added: 1, partial: false });
      expect(await memberOf(orgId, "h-2")).toMatchObject({ source: DIR_SOURCE });
    });
  });

  it("每小时扫描：只给「提供 directory@1、在该组织启用、组织级配置完整」的 (组织, 插件) 投递，多次扫描按小时桶去重", async () => {
    const ok = await setupOrg();
    let release = () => {};
    // 任务执行时挂在第一页，直到断言完第二次扫描
    ok.book.hold = new Promise<void>((r) => {
      release = r;
    });
    ok.book.members = [person("sc-1")];
    const disabled = await setupOrg();
    await ownerReq({
      method: "PUT",
      url: `/api/v1/orgs/${disabled.orgId}/plugins/dir-mini`,
      payload: { enabled: false },
    });
    // 启用但已存配置不再满足 schema（如插件升级后）
    const invalid = await createOrg(ownerReq, "Invalid cfg");
    await sql`INSERT INTO capybara.plugin_org_configs (plugin, org_id, enabled, config)
      VALUES ('dir-mini', ${invalid}, true, '{}'::jsonb)`.execute(raw);
    const unconfigured = await createOrg(ownerReq, "Unconfigured");
    const deleted = await setupOrg();
    await sql`UPDATE capybara.orgs SET deleted_at = now() WHERE id = ${deleted.orgId}`.execute(raw);
    // 启用了不提供 directory@1 的插件
    await sql`INSERT INTO capybara.plugin_org_configs (plugin, org_id, enabled)
      VALUES ('model-fake', ${unconfigured}, true)`.execute(raw);

    const first = await k.identity.directory.scan();
    const mine = (orgId: string) => first.filter((t) => t.orgId === orgId);
    expect(mine(ok.orgId)).toEqual([
      {
        orgId: ok.orgId,
        plugin: "dir-mini",
        jobId: `directory-sync-${ok.orgId}-dir-mini-${hourBucket(new Date())}`,
      },
    ]);
    for (const o of [disabled.orgId, invalid, unconfigured, deleted.orgId]) {
      expect(mine(o), o).toEqual([]);
    }
    // 另一副本同一小时再扫一次：同一个 job id，队列里只有一个任务
    const second = await k.identity.directory.scan();
    const jobId = mine(ok.orgId)[0]?.jobId as string;
    expect(second.find((t) => t.orgId === ok.orgId)?.jobId).toBe(jobId);
    await waitFor(async () => ok.book.starts() === 1, 10_000, "scheduled sync started");
    expect(await queue.getJob(jobId)).toBeDefined();
    release();
    const synced = await waitFor(
      async () => (await audits(ok.orgId, "org.directory.synced"))[0],
      15_000,
      "scheduled sync audit",
    );
    expect(synced.detail).toMatchObject({ trigger: "schedule", added: 1 });
    // 同一小时的第三次扫描也不会再跑一轮（完成的任务按 job id 保留，重复投递被去重）
    await k.identity.directory.scan();
    await new Promise((r) => setTimeout(r, 500));
    expect(ok.book.starts()).toBe(1);
    expect(await audits(ok.orgId, "org.directory.synced")).toHaveLength(1);
  });
});

describe("修复波 W1", () => {
  it("通讯录建的身份行记 linked_via = directory", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("lv-1")];
    expect(await sync(orgId)).toMatchObject({ added: 1 });
    const row = await db
      .selectFrom("identities")
      .select("linked_via")
      .where("source", "=", SOURCE)
      .where("external_id", "=", "lv-1")
      .executeTakeFirstOrThrow();
    expect(row.linked_via).toBe("directory");
  });

  it("Ruling A20：管理员手动移出通讯录成员后，下一轮同步不再加回；手动重新加入（接受邀请）清除排除", async () => {
    const { orgId, book } = await setupOrg();
    const ex = await accounts.createLocal({ login: "ex-1", password: PW, displayName: "Ex" });
    await linkIdentity(ex.id, "u-ex");
    book.members = [person("u-ex"), person("u-stay")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    expect(await memberOf(orgId, "u-ex")).toMatchObject({ source: DIR_SOURCE });

    const del = await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${ex.id}` });
    expect(del.statusCode).toBe(204);
    const excl = await db
      .selectFrom("directory_exclusions")
      .select(["account_id", "plugin", "created_by"])
      .where("org_id", "=", orgId)
      .execute();
    expect(excl).toEqual([{ account_id: ex.id, plugin: "dir-mini", created_by: owner.id }]);

    // 仍在通讯录里在职：同步跳过被排除的人（不算失败，不影响移除阶段）
    expect(await sync(orgId)).toMatchObject({ added: 0, removed: 0, failed: 0, partial: false });
    expect(await memberOf(orgId, "u-ex")).toBeUndefined();
    expect(await memberOf(orgId, "u-stay")).toBeDefined();

    // 管理员重新邀请，本人接受：手动成员（source 为空），排除被清除
    const inv = await ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      payload: { role: "member" },
    });
    expect(inv.statusCode, inv.body).toBe(201);
    const exReq = await session(k, "ex-1");
    const acc = await exReq({
      method: "POST",
      url: `/api/v1/invitations/${(inv.json() as { token: string }).token}/accept`,
      payload: {},
    });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(
      await db
        .selectFrom("directory_exclusions")
        .select("account_id")
        .where("org_id", "=", orgId)
        .execute(),
    ).toEqual([]);
    expect(await memberOf(orgId, "u-ex")).toMatchObject({ source: null });
    expect(await sync(orgId)).toMatchObject({ added: 0, removed: 0 });
    expect(await memberOf(orgId, "u-ex")).toMatchObject({ source: null });
  });

  it("Ruling A24：手动重新加入后再被移出 → 仍写排除（按该组织启用的通讯录插件），同步不再加回", async () => {
    const { orgId, book } = await setupOrg();
    const re = await accounts.createLocal({ login: "re-1", password: PW, displayName: "Re" });
    await linkIdentity(re.id, "u-re");
    book.members = [person("u-re")];
    // 先是手动成员（source 为空），从未由通讯录加入
    await addManual(orgId, re.id);
    expect(await sync(orgId)).toMatchObject({ added: 0 });
    expect(await memberOf(orgId, "u-re")).toMatchObject({ source: null });

    const excl = async () =>
      db
        .selectFrom("directory_exclusions")
        .select(["account_id", "plugin", "created_by"])
        .where("org_id", "=", orgId)
        .execute();
    const del = await ownerReq({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${re.id}` });
    expect(del.statusCode).toBe(204);
    expect(await excl()).toEqual([{ account_id: re.id, plugin: "dir-mini", created_by: owner.id }]);
    // 仍在通讯录里在职：不被同步加回
    expect(await sync(orgId)).toMatchObject({ added: 0, failed: 0, partial: false });
    expect(await memberOf(orgId, "u-re")).toBeUndefined();

    // 本人离开同样写排除：手动重新加入（清除排除）后离开
    await k.identity.directory.sync(orgId, "dir-mini");
    const inv = await ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/invitations`,
      payload: { role: "member" },
    });
    const reReq = await session(k, "re-1");
    const acc = await reReq({
      method: "POST",
      url: `/api/v1/invitations/${(inv.json() as { token: string }).token}/accept`,
      payload: {},
    });
    expect(acc.statusCode, acc.body).toBe(200);
    expect(await excl()).toEqual([]);
    const left = await reReq({ method: "POST", url: `/api/v1/orgs/${orgId}/leave` });
    expect(left.statusCode).toBe(204);
    expect(await excl()).toEqual([{ account_id: re.id, plugin: "dir-mini", created_by: re.id }]);
    expect(await sync(orgId)).toMatchObject({ added: 0 });
    expect(await memberOf(orgId, "u-re")).toBeUndefined();
  });

  it("移除阶段前复核可同步性：插件中途停用 → 本轮不完整、不移除任何人", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("rc-1"), person("rc-2")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    book.members = [person("rc-1")];
    let calls = 0;
    const ds = new DirectorySync({
      db,
      redis,
      host: k.host,
      orgPluginConfigs: {
        // 第一次（开始时）照常；之后（移除阶段前的复核）返回已停用
        get: async (o, p) => {
          calls++;
          const cfg = await k.orgPluginConfigs.get(o, p);
          return calls === 1 || cfg === undefined ? cfg : { ...cfg, enabled: false };
        },
      },
      external: k.identity.external,
      offboarding: k.identity.offboarding,
      log: k.log,
    });
    const r = await ds.sync(orgId, "dir-mini", { trigger: "manual" });
    expect(r).toMatchObject({ status: "synced", removed: 0, partial: true });
    expect(calls).toBe(2);
    expect(await memberOf(orgId, "rc-2")).toMatchObject({ source: DIR_SOURCE });
    expect((await audits(orgId, "org.directory.synced")).at(-1)?.detail).toMatchObject({
      removed: 0,
      partial: true,
    });
  });

  it("Ruling A32：同步途中来了 directory_changed（脏标记）→ 本轮不移除、审计不完整原因；补跑那一轮移除", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("dc-1"), person("dc-2")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    book.members = [person("dc-1")];
    const dirty = directorySyncDirtyKey(orgId, "dir-mini");
    let calls = 0;
    let midSync: unknown;
    const ds = new DirectorySync({
      db,
      redis,
      host: k.host,
      orgPluginConfigs: {
        // 第二次（移除阶段前的复核）时：通讯录变更事件到达，另一个同步任务因锁被占而记下脏标记
        get: async (o, p) => {
          calls++;
          if (calls === 2) {
            midSync = await k.identity.directory.sync(o, p, { trigger: "changed" });
          }
          return k.orgPluginConfigs.get(o, p);
        },
      },
      external: k.identity.external,
      offboarding: k.identity.offboarding,
      log: k.log,
      // 补跑任务投到真实的维护队列，由内核的 worker 执行（不在这里注册处理函数）
      maintenance: {
        add: async (name, data, o) => {
          await queue.add(name, data, o);
        },
        handle: () => {},
        schedule: () => {},
      },
    });
    const r = await ds.sync(orgId, "dir-mini", { trigger: "changed" });
    expect(midSync).toEqual({ status: "skipped", reason: "locked" });
    expect(r).toMatchObject({ status: "synced", removed: 0, partial: true });
    expect(await memberOf(orgId, "dc-2")).toMatchObject({ source: DIR_SOURCE });
    expect((await audits(orgId, "org.directory.synced")).at(-1)?.detail).toMatchObject({
      removed: 0,
      partial: true,
      partialReason: "changed_during_sync",
    });
    // 本轮结束时取走脏标记、投递补跑；补跑（worker）的那一轮移除 dc-2
    expect(await redis.get(dirty)).toBeNull();
    await waitFor(
      async () => ((await memberOf(orgId, "dc-2")) === undefined ? true : undefined),
      15_000,
      "rerun removes dc-2",
    );
    const last = (await audits(orgId, "org.directory.synced")).at(-1)?.detail;
    expect(last).toMatchObject({ trigger: "changed", removed: 1, partial: false });
    expect(await memberOf(orgId, "dc-1")).toMatchObject({ source: DIR_SOURCE });
  }, 30_000);

  it("移除阶段前复核可同步性：组织级配置中途变得无效 → 不移除任何人", async () => {
    const { orgId, book } = await setupOrg();
    book.members = [person("ci-1"), person("ci-2")];
    expect(await sync(orgId)).toMatchObject({ added: 2 });
    book.members = [person("ci-1")];
    let calls = 0;
    const ds = new DirectorySync({
      db,
      redis,
      host: k.host,
      orgPluginConfigs: {
        get: async (o, p) => {
          calls++;
          if (calls > 1) throw new Error("stored config no longer matches the schema");
          return k.orgPluginConfigs.get(o, p);
        },
      },
      external: k.identity.external,
      offboarding: k.identity.offboarding,
      log: k.log,
    });
    expect(await ds.sync(orgId, "dir-mini", { trigger: "manual" })).toMatchObject({
      removed: 0,
      partial: true,
    });
    expect(await memberOf(orgId, "ci-2")).toBeDefined();
  });
});

describe("Ruling A28：directory.configured", () => {
  const enableOpt = async (orgId: string, config: Record<string, unknown>) => {
    const res = await ownerReq({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/dir-opt`,
      payload: { enabled: true, config },
    });
    expect(res.statusCode, res.body).toBe(200);
  };

  it("未配置的通讯录：扫描不投递、同步静默跳过、changed 不投递任务、无审计", async () => {
    const orgId = await createOrg(ownerReq, "Opt unconfigured");
    await enableOpt(orgId, {});
    const targets = await k.identity.directory.scan();
    expect(targets.filter((t) => t.orgId === orgId)).toEqual([]);
    expect(await k.identity.directory.sync(orgId, "dir-opt")).toEqual({
      status: "skipped",
      reason: "not_configured",
    });
    expect(await k.identity.directory.enqueue(orgId, "dir-opt")).toBeUndefined();
    expect(
      await queue.getJob(directorySyncJobId(orgId, "dir-opt", "changed", new Date())),
    ).toBeUndefined();
    expect(await audits(orgId, "org.directory.synced")).toEqual([]);
    expect(await audits(orgId, "org.directory.removal_blocked")).toEqual([]);
  });

  it("未配置时手动同步 409 directory.not_configured；配置后照常扫描与同步", async () => {
    const orgId = await createOrg(ownerReq, "Opt manual");
    await enableOpt(orgId, {});
    const res = await ownerReq({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/plugins/dir-opt/directory/sync`,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe("directory.not_configured");
    const book = fd.book(`opt-${orgId}`);
    book.members = [person("opt-1")];
    await enableOpt(orgId, { url: book.url });
    const targets = await k.identity.directory.scan();
    expect(targets.filter((t) => t.orgId === orgId).map((t) => t.plugin)).toEqual(["dir-opt"]);
    // 扫描投递的任务在 worker 上同步
    const synced = await waitFor(
      async () => (await audits(orgId, "org.directory.synced"))[0],
      15_000,
      "scheduled sync of the configured directory",
    );
    expect(synced.detail).toMatchObject({ trigger: "schedule", added: 1, partial: false });
  });
});
