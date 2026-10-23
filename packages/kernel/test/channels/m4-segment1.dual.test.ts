import { fileURLToPath } from "node:url";
import {
  createDualReplicaHarness,
  type FakeChannelSent,
  type FakeChannelServer,
  fakeCardAction,
  fakeDirectoryMember,
  fakeDm,
  fakeGroupMessage,
  type Harness,
  replicaOf,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * M4 第一段验收（双副本）：两个独立进程的内核副本（都含 api / worker / gateway 角色）加载 fake-im 测试插件
 * （channel@1 + identity-source@1 + directory@1，连 startFakeChannelServer 起的假 IM 平台），走完一遍：
 *
 *  1. 建渠道连接（只有一个副本连上长连接）；首轮通讯录同步把 bob 加进组织（身份 fake-im:t1 / u-bob）
 *  2. 未绑定的 alice 私聊 → 绑定卡片（群里未绑定的人只得到「去私聊」提示，Ruling A10）
 *  3. alice 登录网页，`POST /api/v1/bind/:token` 绑定
 *  4. 私聊对话：先发草稿、流式更新、以完整文本定稿
 *  5. 群聊话题里 agent 调用写工具（默认策略 ask）→ IM 审批卡片
 *  6. 另一位已绑定成员 bob（不是审批人）点批准 → 被拒并收到说明，审批仍 pending、工具未执行
 *  7. 发起人 alice 点批准 → 卡片更新为 approved，续跑执行工具并把最终回复投到话题里
 *  8. SIGKILL 持有长连接的副本 → 另一副本接管；平台重投旧消息不重复写入，之后的消息照常回复，整个过程没有重复消息
 *  9. 经 fake-im 身份源登录（SSO 发起 → 平台授权（PKCE）→ 回调带浏览器绑定 Cookie）：alice 的 IM 身份是经绑定链接
 *     建立的，未登录时不能直接登录（Ruling A18）；alice 在已登录状态下完成一次后升级，之后回到同一账号；carol 得到新账号
 * 10. 平台推 directory_changed → 同步把 carol 加入组织；通讯录移除 carol（1 人，低于大批移除阈值，Ruling A17）→
 *     离职处理：成员关系删除、会话吊销，之后在 IM 里也不再被当作成员
 *
 * 假平台的 `/send` 按幂等键去重；最后断言没有任何发送命中去重（内核自己就没有重发）。
 */

const FAKE_IM = fileURLToPath(new URL("../fixtures/plugins/fake-im/index.ts", import.meta.url));
const PUBLIC = "https://cap.example";
const SOURCE = "fake-im:t1";
const LEASE_TTL_MS = 3000;
const LONG =
  "Streaming replies reach the IM chat as a draft that keeps growing until it is final. ".repeat(2);

let pgc: TestContainer;
let rdc: TestContainer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer();
}, 120_000);

afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  await h?.stop();
  h = undefined;
});

afterAll(async () => {
  await im?.stop();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

type Json = Record<string, unknown>;
type Jar = Map<string, string>;

/** 把响应的 Set-Cookie 收进 Cookie 罐（值为空 / Max-Age=0 视为删除）。 */
function absorb(jar: Jar, res: Response): void {
  for (const c of res.headers.getSetCookie()) {
    const pair = c.split(";")[0] ?? "";
    const i = pair.indexOf("=");
    const name = pair.slice(0, i).trim();
    const value = pair.slice(i + 1).trim();
    if (value === "" || /max-age=0/i.test(c)) jar.delete(name);
    else jar.set(name, value);
  }
}

const cookieHeader = (jar: Jar) => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0] as Json | undefined;

describe("M4 第一段验收（双副本）", () => {
  it("渠道 → 绑定 → 流式对话 → IM 审批 → 杀副本接管 → SSO 登录 → 通讯录加入与离职", async () => {
    h = await createDualReplicaHarness({
      plugins: [MODEL_FAKE, FAKE_IM],
      pgUrl: pgc.url,
      redisUrl: rdc.url,
      pluginConfig: {
        "fake-im": {
          platformUrl: im.url,
          tenant: "t1",
          clientId: "cli_login",
          clientSecret: "login-secret-5f6e7d",
        },
      },
      config: {
        auth: { cookieSecure: false, loginSources: ["fake-im"] },
        http: { publicUrl: PUBLIC },
        channels: { leaseTtlMs: LEASE_TTL_MS, scanIntervalMs: 300 },
        runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
      },
    });
    const harness = h;
    const raw = createDb(harness.dbUrl, 3);
    cleanups.push(() => raw.destroy());
    const db: KernelDb = kernelDb(raw);

    // ---- HTTP：杀副本前严格交替发往两个副本；之后只发往幸存的副本 ----
    let dead: 0 | 1 | undefined;
    const send = async (path: string, init: RequestInit) => {
      if (dead === undefined) return harness.request(path, init);
      const r = harness.replicas[dead === 0 ? 1 : 0];
      const res = await fetch(`http://127.0.0.1:${r.port}${path}`, init);
      expect(replicaOf(res)).toBe(r.index);
      return Object.assign(res, { replica: r.index });
    };
    const call = async (jar: Jar, method: string, path: string, body?: unknown) => {
      const res = await send(path, {
        method,
        redirect: "manual",
        headers: {
          "x-capybara-csrf": "1",
          ...(jar.size > 0 && { cookie: cookieHeader(jar) }),
          ...(body !== undefined && { "content-type": "application/json" }),
        },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      absorb(jar, res);
      const text = await res.text();
      const isJson = res.headers.get("content-type")?.includes("json") === true && text !== "";
      return {
        status: res.status,
        replica: res.replica,
        location: res.headers.get("location") ?? "",
        json: (isJson ? JSON.parse(text) : {}) as Json,
      };
    };

    const ownerJar: Jar = new Map();
    const aliceJar: Jar = new Map();
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" });
    expect(
      (await call(ownerJar, "POST", "/api/v1/auth/login", { login: "owner", password: PW })).status,
    ).toBe(200);
    const org = await call(ownerJar, "POST", "/api/v1/orgs", { name: "Acme" });
    expect(org.status).toBe(201);
    const orgId = (org.json.org as { id: string }).id;
    const base = `/api/v1/orgs/${orgId}`;

    // alice 凭邀请注册（本地账号、组织成员，尚未绑定 IM 身份）
    const inv = await call(ownerJar, "POST", `${base}/invitations`, { role: "member" });
    expect(inv.status).toBe(201);
    const accepted = await call(aliceJar, "POST", `/api/v1/invitations/${inv.json.token}/accept`, {
      login: "alice",
      password: PW,
      displayName: "Alice",
    });
    expect(accepted.status, JSON.stringify(accepted.json)).toBe(200);
    const aliceId = (accepted.json.account as { id: string }).id;

    const membership = (accountId: string) =>
      db
        .selectFrom("memberships")
        .select(["role", "source"])
        .where("org_id", "=", orgId)
        .where("account_id", "=", accountId)
        .executeTakeFirst();
    const identityOwner = async (externalId: string) =>
      (
        await db
          .selectFrom("identities")
          .select("account_id")
          .where("source", "=", SOURCE)
          .where("external_id", "=", externalId)
          .executeTakeFirst()
      )?.account_id;
    const syncAudits = () =>
      db
        .selectFrom("audit_events")
        .select("detail")
        .where("org_id", "=", orgId)
        .where("action", "=", "org.directory.synced")
        .orderBy("id")
        .execute();

    // ================= 1. 建连接；首轮通讯录同步 =================
    const book = im.book("acme");
    book.members = [fakeDirectoryMember("u-bob", { displayName: "Bob" })];
    const en = await call(ownerJar, "PUT", `${base}/plugins/fake-im`, {
      enabled: true,
      config: { url: book.url },
    });
    expect(en.status, JSON.stringify(en.json)).toBe(200);
    const sync1 = await call(ownerJar, "POST", `${base}/plugins/fake-im/directory/sync`);
    expect(sync1.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 1, 20_000, "first directory sync");
    const bobId = await waitFor(async () => identityOwner("u-bob"), 15_000, "bob's account");
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:fake-im" });

    const ag = await call(ownerJar, "POST", `${base}/agents`, {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [{ kind: "plugin", plugin: "fake-im", name: "post_announcement" }],
      },
      visibility: "org",
    });
    expect(ag.status, JSON.stringify(ag.json)).toBe(201);
    const agentId = (ag.json.agent as { id: string }).id;
    const ch = await call(ownerJar, "POST", `${base}/channels`, {
      plugin: "fake-im",
      name: "Acme Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_acme", appSecret: "acme-secret-9a8b7c6d" },
    });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    const channel = ch.json.channel as Json;
    expect(channel).toMatchObject({ plugin: "fake-im", tenantId: "t1", botUserId: "bot-cli_acme" });
    expect(JSON.stringify(ch.json)).not.toContain("acme-secret-9a8b7c6d");
    const connId = channel.id as string;
    const first = await waitFor(async () => im.active(connId)[0], 15_000, "long connection");
    expect(first.appId).toBe("cli_acme");
    await sleep(1000);
    expect(im.maxConcurrent(connId)).toBe(1);

    const sentTo = (chatId: string) =>
      im.sent.filter((s) => s.appId === "cli_acme" && s.target.chatId === chatId);
    const threadConv = async (chatId: string) =>
      (
        await db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", connId)
          .where("chat_id", "=", chatId)
          .where("archived_at", "is", null)
          .executeTakeFirst()
      )?.conversation_id;

    // ================= 2. 未绑定的人：私聊收到绑定卡片；群里只提示去私聊 =================
    expect(im.push(connId, fakeDm("a-hello", "u-alice", "hello"))).toBe(1);
    const bindMsg = await waitFor(async () => sentTo("dm-u-alice")[0], 15_000, "bind card");
    expect(bindMsg.message.text).toBe("Please link your Capybara account before chatting with me.");
    const bindCard = cardOf(bindMsg);
    expect(bindCard?.kind).toBe("bind");
    const bindUrl = String(bindCard?.url);
    expect(bindUrl.startsWith(`${PUBLIC}/bind/cap_bind_`)).toBe(true);
    const token = bindUrl.slice(`${PUBLIC}/bind/`.length);
    expect(await threadConv("dm-u-alice")).toBeUndefined();

    im.push(connId, fakeGroupMessage("g-stranger", "u-dave", "@bot hi", { chatId: "grp-ops" }));
    const hint = await waitFor(async () => sentTo("grp-ops")[0], 15_000, "group hint");
    expect(hint.message.text).toMatch(/direct message/);
    expect(hint.message.cards ?? []).toEqual([]);
    expect(JSON.stringify(hint)).not.toMatch(/cap_bind_/);

    // ================= 3. 登录网页确认绑定（查看与确认落在不同副本） =================
    const peek = await call(aliceJar, "GET", `/api/v1/bind/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.json.binding).toMatchObject({
      connectionId: connId,
      source: SOURCE,
      externalId: "u-alice",
    });
    const bound = await call(aliceJar, "POST", `/api/v1/bind/${token}`);
    expect(bound.status).toBe(200);
    expect(bound.replica).not.toBe(peek.replica);
    expect(await identityOwner("u-alice")).toBe(aliceId);
    // 令牌单次有效
    expect((await call(aliceJar, "POST", `/api/v1/bind/${token}`)).status).toBe(404);

    // ================= 4. 私聊对话：草稿 → 流式更新 → 定稿 =================
    const dmBefore = sentTo("dm-u-alice").length;
    expect(im.push(connId, fakeDm("a-stream", "u-alice", `slow:120:${LONG}`))).toBe(1);
    const draft = await waitFor(
      async () => sentTo("dm-u-alice").slice(dmBefore)[0],
      20_000,
      "draft message",
    );
    expect(draft.message.text.length).toBeLessThan(LONG.length);
    await waitFor(
      async () => im.finalText(draft) === LONG,
      30_000,
      "draft finalized with the full text",
    );
    const updates = im.updated.filter((u) => u.messageId === draft.messageId);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.some((u) => u.message.text.length < LONG.length)).toBe(true);
    for (const u of updates) expect(LONG.startsWith(u.message.text.replace(/\s+$/, ""))).toBe(true);
    const dmConv = (await threadConv("dm-u-alice")) as string;
    const dmConvRow = await db
      .selectFrom("conversations")
      .select(["account_id", "agent_id"])
      .where("id", "=", dmConv)
      .executeTakeFirstOrThrow();
    expect(dmConvRow).toEqual({ account_id: aliceId, agent_id: agentId });
    // 回复只在草稿上更新，没有另发消息
    await sleep(500);
    expect(sentTo("dm-u-alice").slice(dmBefore)).toHaveLength(1);

    // ================= 5. 群聊话题里调用写工具 → IM 审批卡片 =================
    const tool = 'tool:fake-im__post_announcement:{"text":"Office closed on Friday"}';
    im.push(connId, fakeGroupMessage("g1", "u-alice", tool, { chatId: "grp-ops" }));
    const cardMsg = await waitFor(
      async () => sentTo("grp-ops").find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    expect(cardMsg.target).toEqual({ chatId: "grp-ops", chatType: "group", threadId: "g1" });
    const card = cardOf(cardMsg) as Json;
    expect(card).toMatchObject({ state: "pending", toolName: "post_announcement" });
    expect(String(card.inputPreview)).toContain("Office closed on Friday");
    const approvalId = card.id as string;
    const approval = () =>
      db
        .selectFrom("approvals")
        .select(["status", "requested_for", "decided_by"])
        .where("id", "=", approvalId)
        .executeTakeFirstOrThrow();
    expect(await approval()).toMatchObject({ status: "pending", requested_for: aliceId });
    expect(im.posts).toEqual([]);

    // ================= 6. 非审批人 bob 点批准 → 被拒并说明 =================
    const beforeBob = sentTo("grp-ops").length;
    im.push(
      connId,
      fakeCardAction(
        "g1-bob",
        "u-bob",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        cardMsg.target,
      ),
    );
    const refusal = await waitFor(
      async () => sentTo("grp-ops").slice(beforeBob)[0],
      15_000,
      "refusal",
    );
    expect(refusal.message.text).toBe("You can't handle this request.");
    expect(refusal.target).toEqual(cardMsg.target);
    await sleep(500);
    expect(await approval()).toMatchObject({ status: "pending", decided_by: null });
    expect(im.posts).toEqual([]);
    expect(im.updated.filter((u) => u.messageId === cardMsg.messageId)).toEqual([]);

    // ================= 7. 发起人 alice 批准 → 续跑完成、最终回复投到话题 =================
    im.push(
      connId,
      fakeCardAction(
        "g1-alice",
        "u-alice",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        cardMsg.target,
      ),
    );
    await waitFor(
      async () =>
        im.updated.some(
          (u) => u.messageId === cardMsg.messageId && cardOf(u)?.state === "approved",
        ),
      20_000,
      "card updated to approved",
    );
    expect(await approval()).toMatchObject({ status: "approved", decided_by: aliceId });
    const finalReply = await waitFor(
      async () =>
        sentTo("grp-ops").find(
          (s) => im.finalText(s) === "Tool result: Announcement posted (post_1).",
        ),
      20_000,
      "final reply after approval",
    );
    expect(finalReply.target).toEqual(cardMsg.target);
    expect(im.posts).toHaveLength(1);
    expect(im.posts[0]?.body).toMatchObject({ text: "Office closed on Friday" });
    const grpConv = (await threadConv("grp-ops")) as string;
    await waitFor(
      async () => (await eventsOf(db, grpConv)).some((e) => e.type === "run_finished"),
      20_000,
      "run completed",
    );

    // ================= 8. 杀掉持有长连接的副本 → 另一副本接管，消息不重复 =================
    const holder = harness.replicas.find((r) => r.pid === im.active(connId)[0]?.pid);
    const survivor = harness.replicas.find((r) => r.pid !== holder?.pid);
    if (!holder || !survivor) throw new Error("cannot identify the replica holding the connection");
    const killedAt = Date.now();
    await harness.kill(holder.index);
    dead = holder.index;
    const takeover = await waitFor(
      async () => im.active(connId).find((s) => s.pid === survivor.pid),
      LEASE_TTL_MS + 15_000,
      "takeover by the surviving replica",
    );
    expect(takeover.openedAt - killedAt).toBeGreaterThanOrEqual(LEASE_TTL_MS - 1000);
    expect(im.active(connId)).toHaveLength(1);
    expect(im.maxConcurrent(connId)).toBe(1);

    const userMsgIds = async (conv: string) =>
      (await eventsOf(db, conv))
        .filter((e) => e.type === "user_message")
        .map((e) => (e.payload as { clientMessageId?: string }).clientMessageId);
    // 平台重投接管前已处理过的消息，再投一条新消息（新消息也重投一次）
    const dmSent = sentTo("dm-u-alice").length;
    im.push(connId, fakeDm("a-stream", "u-alice", `slow:120:${LONG}`));
    im.push(connId, fakeDm("a-after", "u-alice", "echo:after takeover"));
    im.push(connId, fakeDm("a-after", "u-alice", "echo:after takeover"));
    const afterReply = await waitFor(
      async () => sentTo("dm-u-alice").find((s) => im.finalText(s) === "after takeover"),
      20_000,
      "reply after takeover",
    );
    expect(afterReply.pid).toBe(survivor.pid);
    await sleep(1000);
    expect(sentTo("dm-u-alice").slice(dmSent)).toHaveLength(1);
    expect(await userMsgIds(dmConv)).toEqual([`${connId}:a-stream`, `${connId}:a-after`]);

    // ================= 9. 经 fake-im 身份源登录 =================
    im.users.set("u-alice", { externalId: "u-alice", tenantId: "t1", displayName: "Alice" });
    im.users.set("u-carol", {
      externalId: "u-carol",
      tenantId: "t1",
      email: "carol@corp.example",
      emailVerified: true,
      displayName: "Carol",
    });
    /** 走一次 SSO 到回调；返回回调的 302 目标。`jar` 给了就带着它（已登录的会话）。 */
    const ssoTo = async (externalId: string, jar: Jar) => {
      const start = await call(jar, "GET", "/api/v1/auth/sso/fake-im/start?returnTo=%2Fchat");
      expect(start.status).toBe(302);
      expect(start.location.startsWith(`${im.url}/oauth/authorize?`)).toBe(true);
      expect(new URL(start.location).searchParams.get("code_challenge_method")).toBe("S256");
      expect(jar.has("cap_sso")).toBe(true);
      // 平台上「登录」为 externalId，平台带授权码 302 回内核的回调地址
      const authz = await fetch(`${start.location}&as=${externalId}`, { redirect: "manual" });
      expect(authz.status).toBe(302);
      const back = new URL(authz.headers.get("location") ?? "");
      expect(back.origin + back.pathname).toBe(`${PUBLIC}/api/v1/auth/sso/fake-im/callback`);
      const cb = await call(jar, "GET", back.pathname + back.search);
      expect(cb.status).toBe(302);
      expect(jar.has("cap_sso")).toBe(false);
      return cb.location;
    };
    const sso = async (externalId: string, jar: Jar = new Map()) => {
      expect(await ssoTo(externalId, jar)).toBe(`${PUBLIC}/chat`);
      const me = await call(jar, "GET", "/api/v1/me");
      expect(me.status).toBe(200);
      return { jar, accountId: (me.json.account as { id: string }).id };
    };
    // alice 的 IM 身份经绑定链接建立：未登录时不能直接登录（Ruling A18）
    const anon: Jar = new Map();
    expect(await ssoTo("u-alice", anon)).toBe(`${PUBLIC}/login?error=sso.identity_not_verified`);
    expect(anon.has("cap_at")).toBe(false);
    // alice 在已登录状态下完成一次：证明控制该 IM 身份，升级；之后未登录也登录到同一个账号（同一个 fake-im:t1 键）
    expect((await sso("u-alice", aliceJar)).accountId).toBe(aliceId);
    expect((await sso("u-alice")).accountId).toBe(aliceId);
    // carol 第一次出现：新账号，身份行与渠道、通讯录同键；还不是组织成员
    const carol = await sso("u-carol");
    expect(carol.accountId).not.toBe(aliceId);
    expect(await identityOwner("u-carol")).toBe(carol.accountId);
    expect(await membership(carol.accountId)).toBeUndefined();

    // ================= 10. 通讯录同步加入成员；移除后离职处理 =================
    book.members = [
      fakeDirectoryMember("u-bob", { displayName: "Bob" }),
      fakeDirectoryMember("u-carol", { displayName: "Carol" }),
    ];
    expect(im.push(connId, { type: "directory_changed", tenantId: "t1" })).toBe(1);
    await waitFor(
      async () => (await syncAudits()).length === 2,
      20_000,
      "sync on directory_changed",
    );
    expect((await syncAudits())[1]?.detail).toMatchObject({
      trigger: "changed",
      added: 1,
      removed: 0,
      partial: false,
    });
    // 同一个账号（按身份键匹配，不是按邮箱合并）
    expect(await membership(carol.accountId)).toEqual({
      role: "member",
      source: "directory:fake-im",
    });
    im.push(connId, fakeDm("c-1", "u-carol", "echo:hello from carol"));
    await waitFor(
      async () => sentTo("dm-u-carol").find((s) => im.finalText(s) === "hello from carol"),
      20_000,
      "carol chats as a member",
    );

    book.members = [fakeDirectoryMember("u-bob", { displayName: "Bob" })];
    const sync3 = await call(ownerJar, "POST", `${base}/plugins/fake-im/directory/sync`);
    expect(sync3.status).toBe(202);
    await waitFor(async () => (await syncAudits()).length === 3, 20_000, "sync after removal");
    expect((await syncAudits())[2]?.detail).toMatchObject({
      trigger: "manual",
      added: 0,
      removed: 1,
      partial: false,
    });
    expect(await membership(carol.accountId)).toBeUndefined();
    expect(await membership(bobId)).toEqual({ role: "member", source: "directory:fake-im" });
    expect(await membership(aliceId)).toMatchObject({ role: "member" });
    // 会话已吊销
    expect((await call(carol.jar, "GET", "/api/v1/me")).status).toBe(401);
    const offboarded = await db
      .selectFrom("audit_events")
      .select(["target", "detail"])
      .where("org_id", "=", orgId)
      .where("action", "=", "org.member.offboarded")
      .execute();
    expect(offboarded).toHaveLength(1);
    expect(offboarded[0]?.target).toBe(carol.accountId);
    expect(offboarded[0]?.detail).toMatchObject({ reason: "directory" });
    // IM 里也不再被当作成员（不借用任何人的身份）
    const carolBefore = sentTo("dm-u-carol").length;
    im.push(connId, fakeDm("c-2", "u-carol", "echo:still here?"));
    const notMember = await waitFor(
      async () => sentTo("dm-u-carol").slice(carolBefore)[0],
      15_000,
      "not-a-member reply",
    );
    expect(notMember.message.text).toMatch(/not a member/);
    // 离职时她的 IM 话题行已归档（重新加入后开始新的对话）；旧会话里只有离职前的那条消息
    expect(await threadConv("dm-u-carol")).toBeUndefined();
    const archivedConv = (
      await db
        .selectFrom("channel_threads")
        .select("conversation_id")
        .where("connection_id", "=", connId)
        .where("chat_id", "=", "dm-u-carol")
        .where("archived_at", "is not", null)
        .executeTakeFirstOrThrow()
    ).conversation_id;
    expect(await userMsgIds(archivedConv)).toEqual([`${connId}:c-1`]);

    // ---- 全程：没有任何发送需要靠平台的幂等键去重；所有消息都由本连接的应用发出 ----
    expect(im.duplicateSends).toEqual([]);
    expect(im.sent.every((s) => s.appId === "cli_acme")).toBe(true);
  }, 240_000);
});
