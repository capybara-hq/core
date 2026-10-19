import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { dm, type FakeIm, group, startFakeIm } from "../helpers/fake-im.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  waitFor,
} from "../helpers/runs.js";

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const SOURCE = "chan-mini:t1";

let pgc: TestContainer;
let rd: TestContainer;
let k: Kernel;
let raw: ReturnType<typeof createDb>;
let db: KernelDb;
let im: FakeIm;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let connId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeIm();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CHAN_MINI],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000 },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  const outsider = await accounts.createLocal({ login: "out", password: PW, displayName: "Out" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  agentId = await createAgent(owner, orgId);
  // 外部身份：owner ↔ u-owner（成员），outsider ↔ u-out（不是该组织成员）
  for (const [ext, acct] of [
    ["u-owner", ownerId],
    ["u-out", outsider.id],
  ] as const) {
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES (${SOURCE}, ${ext}, ${acct})`.execute(raw);
  }
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/plugins/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  connId = (res.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

interface ThreadRow {
  chat_id: string;
  thread_key: string;
  account_id: string | null;
  conversation_id: string;
  archived_at: Date | null;
}

const threads = async (): Promise<ThreadRow[]> =>
  (
    await sql<ThreadRow>`SELECT chat_id, thread_key, account_id, conversation_id, archived_at
      FROM capybara.channel_threads WHERE connection_id = ${connId} ORDER BY created_at`.execute(
      raw,
    )
  ).rows;

const userMessages = async (conversationId: string) =>
  (await eventsOf(db, conversationId)).filter((e) => e.type === "user_message");

/** 推送并等到机器人回复第 n 条消息（从 0 计）。 */
const sentAfter = async (n: number) => {
  await waitFor(async () => im.sent.length > n, 10_000, `reply #${n}`);
  return im.sent[n];
};

/** 推送一条消息，等它被处理完：它之后再推一条哨兵（未绑定私聊 → 必回绑定卡片）并等哨兵的回复。 */
let sentinel = 0;
async function pushAndSettle(e: Parameters<FakeIm["push"]>[1]): Promise<void> {
  expect(im.push(connId, e)).toBe(1);
  const before = im.sent.length;
  sentinel++;
  im.push(connId, dm(`sentinel-${sentinel}`, `nobody-${sentinel}`, "hi"));
  await waitFor(
    async () => im.sent.slice(before).some((s) => s.target.chatId === `dm-nobody-${sentinel}`),
    10_000,
    "sentinel reply",
  );
}

describe("渠道入站", () => {
  it("未绑定的私聊 → 回绑定卡片（英文缺省），不建对话", async () => {
    const n = im.sent.length;
    im.push(connId, dm("m-unbound", "u-stranger", "hello"));
    const s = await sentAfter(n);
    expect(s?.target).toEqual({ chatId: "dm-u-stranger", chatType: "dm" });
    const card = s?.message.cards?.[0];
    expect(card?.kind).toBe("bind");
    expect(card && "url" in card && card.url).toMatch(/^https:\/\/cap\.example\/bind\/cap_bind_/);
    expect(s?.message.text).toMatch(/link your Capybara account/);
    expect(await threads()).toEqual([]);
  });

  it("已绑定成员的私聊 → 建对话写入用户消息；平台重投同一条只写一次", async () => {
    await pushAndSettle(dm("m1", "u-owner", "first"));
    const [t] = await threads();
    expect(t).toMatchObject({
      chat_id: "dm-u-owner",
      thread_key: "dm:u-owner",
      account_id: ownerId,
    });
    const conv = t?.conversation_id as string;
    const conversation = await db
      .selectFrom("conversations")
      .select(["account_id", "agent_id", "org_id"])
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(conversation).toEqual({ account_id: ownerId, agent_id: agentId, org_id: orgId });
    // 重投
    await pushAndSettle(dm("m1", "u-owner", "first"));
    await pushAndSettle(dm("m2", "u-owner", "second"));
    const msgs = await userMessages(conv);
    expect(msgs.map((m) => (m.payload as { clientMessageId?: string }).clientMessageId)).toEqual([
      `${connId}:m1`,
      `${connId}:m2`,
    ]);
    expect(await threads()).toHaveLength(1);
    const delivery = await sql<{ connection_id: string; target: unknown }>`
      SELECT connection_id, target FROM capybara.channel_deliveries WHERE conversation_id = ${conv}`.execute(
      raw,
    );
    expect(delivery.rows).toEqual([
      { connection_id: connId, target: { chatId: "dm-u-owner", chatType: "dm" } },
    ]);
  });

  it("群聊未 @ 机器人 → 忽略；@ 后按话题建对话，同一话题续用", async () => {
    const before = (await threads()).length;
    await pushAndSettle(group("g0", "u-owner", "chit-chat", { mentionsBot: false }));
    expect(await threads()).toHaveLength(before);
    await pushAndSettle(group("g1", "u-owner", "@bot help"));
    const t = (await threads()).find((r) => r.chat_id === "grp-1");
    expect(t).toMatchObject({ thread_key: "g1", account_id: ownerId });
    await pushAndSettle(group("g2", "u-owner", "@bot more", { threadId: "g1" }));
    expect((await threads()).filter((r) => r.chat_id === "grp-1")).toHaveLength(1);
    expect(await userMessages(t?.conversation_id as string)).toHaveLength(2);
  });

  it("私聊 /new → 归档当前对话并回「已开始新对话」（组织语言 zh）；下一条进新对话", async () => {
    const res = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { locale: "zh" },
    });
    expect(res.statusCode).toBe(200);
    const old = (await threads()).find((r) => r.thread_key === "dm:u-owner" && !r.archived_at);
    const n = im.sent.length;
    im.push(connId, dm("m-new", "u-owner", "/new"));
    const s = await sentAfter(n);
    expect(s?.message.text).toBe("已开始新对话");
    await pushAndSettle(dm("m3", "u-owner", "fresh start"));
    const dmRows = (await threads()).filter((r) => r.thread_key === "dm:u-owner");
    expect(dmRows).toHaveLength(2);
    expect(
      dmRows.find((r) => r.conversation_id === old?.conversation_id)?.archived_at,
    ).not.toBeNull();
    const live = dmRows.find((r) => r.archived_at === null);
    expect(live?.conversation_id).not.toBe(old?.conversation_id);
    expect(await userMessages(live?.conversation_id as string)).toHaveLength(1);
    // 恢复英文
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/settings`,
      payload: { locale: "en" },
    });
  });

  it("已绑定但不是成员（bind 策略）→ 回提示，不借用任何人的身份", async () => {
    const n = im.sent.length;
    im.push(connId, dm("m-out", "u-out", "let me in"));
    const s = await sentAfter(n);
    expect(s?.message.text).toMatch(/not a member/);
    expect(s?.message.cards ?? []).toEqual([]);
    expect((await threads()).filter((r) => r.chat_id === "dm-u-out")).toEqual([]);
  });

  it("匿名策略：agent 全组织可见 → 用该组织唯一的匿名访客（guest 成员）；否则回提示", async () => {
    const p = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { unboundPolicy: "anonymous" },
    });
    expect(p.statusCode).toBe(200);
    await pushAndSettleAnon(dm("a1", "anon-1", "hi"));
    await pushAndSettleAnon(dm("a2", "anon-2", "hi"));
    const rows = (await threads()).filter((r) => r.chat_id.startsWith("dm-anon-"));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.account_id === null)).toBe(true);
    const owners = await db
      .selectFrom("conversations")
      .select("account_id")
      .where(
        "id",
        "in",
        rows.map((r) => r.conversation_id),
      )
      .execute();
    const anonIds = [...new Set(owners.map((o) => o.account_id))];
    expect(anonIds).toHaveLength(1);
    const anon = anonIds[0] as string;
    expect(anon).not.toBe(ownerId);
    const m = await db
      .selectFrom("memberships")
      .select("role")
      .where("org_id", "=", orgId)
      .where("account_id", "=", anon)
      .executeTakeFirst();
    expect(m?.role).toBe("guest");
    const acct = await db
      .selectFrom("accounts")
      .select("status")
      .where("id", "=", anon)
      .executeTakeFirst();
    expect(acct?.status).toBe("active");
    const logins = await db
      .selectFrom("identities")
      .select("source")
      .where("account_id", "=", anon)
      .execute();
    expect(logins).toEqual([]);

    // agent 改为私有 → 匿名访客不可用
    const priv = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { visibility: "private" },
    });
    expect(priv.statusCode, priv.body).toBe(200);
    const n = im.sent.length;
    im.push(connId, dm("a3", "anon-3", "hi"));
    const s = await sentAfter(n);
    expect(s?.message.text).toMatch(/anonymous/i);
    expect((await threads()).filter((r) => r.chat_id === "dm-anon-3")).toEqual([]);
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { visibility: "org" },
    });
  });
});

/** 匿名策略下没有「必回」的哨兵：等该消息出现在某个对话里。 */
async function pushAndSettleAnon(e: Parameters<FakeIm["push"]>[1]): Promise<void> {
  expect(im.push(connId, e)).toBe(1);
  const id = (e as { messageId: string }).messageId;
  await waitFor(
    async () => {
      const r = await sql`SELECT 1 FROM capybara.conversation_events
        WHERE payload->>'clientMessageId' = ${`${connId}:${id}`}`.execute(raw);
      return r.rows.length > 0;
    },
    10_000,
    `message ${id}`,
  );
}
