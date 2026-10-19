import { fileURLToPath } from "node:url";
import {
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  fakeGroupMessage as group,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHANNEL_QUEUE_NAME, inboundJobId } from "../../src/channels/outbound.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createAgent,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  sleep,
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
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let connId: string;
let queue: Queue;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
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
  queue = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
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
    ["u-race", ownerId],
    ["u-retry", ownerId],
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
  await queue?.close();
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

/**
 * 等到机器人在第 n 条（从 0 计）之后发往 `chatId` 的第一条消息。按 chat 过滤：出站投递会把此前对话的模型回复
 * 异步投到别的 chat，不能假设下一条就是要等的那条。`pred` 进一步筛选（同一 chat 里也可能有迟到的模型回复）。
 */
const sentAfter = async (
  n: number,
  chatId: string,
  pred: (s: FakeChannelSent) => boolean = () => true,
) =>
  waitFor(
    async () => im.sent.slice(n).find((s) => s.target.chatId === chatId && pred(s)),
    10_000,
    `reply to ${chatId}`,
  );

/** 该消息的入站任务（Ruling A21：onEvent 只入队，worker 处理）已处理完。 */
const processed = async (messageId: string) =>
  (await queue.getJobState(inboundJobId(connId, messageId))) === "completed";

/**
 * 推送一条消息，等它被处理完：它之后再推一条哨兵（未绑定私聊 → 必回绑定卡片）并等哨兵的回复——插件逐条调用
 * onEvent，哨兵入队时前一条（含平台重投）的 onEvent 已返回；入站任务并发处理，所以还要等前一条的任务处理完。
 */
let sentinel = 0;
async function pushAndSettle(e: Parameters<FakeChannelServer["push"]>[1]): Promise<void> {
  expect(im.push(connId, e)).toBe(1);
  const before = im.sent.length;
  sentinel++;
  im.push(connId, dm(`sentinel-${sentinel}`, `nobody-${sentinel}`, "hi"));
  await waitFor(
    async () => im.sent.slice(before).some((s) => s.target.chatId === `dm-nobody-${sentinel}`),
    10_000,
    "sentinel reply",
  );
  const id = (e as { messageId: string }).messageId;
  await waitFor(() => processed(id), 10_000, `inbound job ${id}`);
}

describe("渠道入站", () => {
  it("未绑定的私聊 → 回绑定卡片（英文缺省），不建对话", async () => {
    const n = im.sent.length;
    im.push(connId, dm("m-unbound", "u-stranger", "hello"));
    const s = await sentAfter(n, "dm-u-stranger");
    expect(s?.target).toEqual({ chatId: "dm-u-stranger", chatType: "dm" });
    const card = s?.message.cards?.[0];
    expect(card?.kind).toBe("bind");
    expect(card && "url" in card && card.url).toMatch(/^https:\/\/cap\.example\/bind\/cap_bind_/);
    expect(s?.message.text).toMatch(/link your Capybara account/);
    // Ruling A22：组织语言随发送交给插件
    expect(s?.locale).toBe("en");
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
    const s = await sentAfter(
      n,
      "dm-u-owner",
      (x) => x.message.cards === undefined && x.message.text === "已开始新对话",
    );
    expect(s?.message.text).toBe("已开始新对话");
    expect(s?.locale).toBe("zh");
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

  it("群里未绑定的人 @ 机器人 → 只回「请私聊绑定」，群里不发卡片、不出现链接", async () => {
    const n = im.sent.length;
    im.push(connId, group("g-unbound", "u-grp-stranger", "@bot hi", { chatId: "grp-2" }));
    const s = await sentAfter(n, "grp-2");
    expect(s?.target).toEqual({ chatId: "grp-2", chatType: "group", threadId: "g-unbound" });
    expect(s?.message.text).toMatch(/direct message/);
    expect(s?.message.cards ?? []).toEqual([]);
    expect(JSON.stringify(s)).not.toMatch(/https?:\/\//);
    expect((await threads()).filter((r) => r.chat_id === "grp-2")).toEqual([]);
  });

  it("同一话题的首条消息并发到达 → 只有一条话题行，没有遗留的空会话", async () => {
    const convCount = async () =>
      (
        await db
          .selectFrom("conversations")
          .select("id")
          .where("account_id", "=", ownerId)
          .execute()
      ).length;
    const before = await convCount();
    await Promise.all(
      ["race-1", "race-2", "race-3"].map((m) =>
        k.channels.inbound.handle(connId, dm(m, "u-race", `hello ${m}`)),
      ),
    );
    const rows = (await threads()).filter((r) => r.chat_id === "dm-u-race");
    expect(rows).toHaveLength(1);
    expect(await convCount()).toBe(before + 1);
    expect(await userMessages(rows[0]?.conversation_id as string)).toHaveLength(3);
  });

  it("已绑定但不是成员（bind 策略）→ 回提示，不借用任何人的身份", async () => {
    const n = im.sent.length;
    im.push(connId, dm("m-out", "u-out", "let me in"));
    const s = await sentAfter(n, "dm-u-out");
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
    const s = await sentAfter(n, "dm-anon-3");
    expect(s?.message.text).toMatch(/anonymous/i);
    expect((await threads()).filter((r) => r.chat_id === "dm-anon-3")).toEqual([]);
    await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/agents/${agentId}`,
      payload: { visibility: "org" },
    });
  });
});

describe("入站持久化（Ruling A21）", () => {
  it("处理中途失败（用户消息已写入之后）→ 入站任务由队列重试，消息只写一次、投递目标补上", async () => {
    // 注入一次失败：话题 dm-u-retry 的第一次投递目标写入抛错（序列不随事务回滚，只失败一次）
    await sql.raw(`CREATE SEQUENCE IF NOT EXISTS public.w2_inbound_fail`).execute(raw);
    await sql
      .raw(
        `CREATE OR REPLACE FUNCTION public.w2_inbound_fail() RETURNS trigger AS $$
        BEGIN
          IF NEW.target->>'chatId' = 'dm-u-retry' AND nextval('public.w2_inbound_fail') = 1 THEN
            RAISE EXCEPTION 'injected failure';
          END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql`,
      )
      .execute(raw);
    await sql
      .raw(
        `CREATE TRIGGER w2_inbound_fail BEFORE INSERT ON capybara.channel_deliveries
        FOR EACH ROW EXECUTE FUNCTION public.w2_inbound_fail()`,
      )
      .execute(raw);
    try {
      expect(im.push(connId, dm("retry-1", "u-retry", "please retry"))).toBe(1);
      const conv = await waitFor(
        async () =>
          (
            await sql<{ conversation_id: string }>`SELECT d.conversation_id
              FROM capybara.channel_deliveries d WHERE d.target->>'chatId' = 'dm-u-retry'`.execute(
              raw,
            )
          ).rows[0]?.conversation_id,
        20_000,
        "delivery target after retry",
      );
      const tries = await sql<{ last_value: string }>`SELECT last_value
        FROM public.w2_inbound_fail`.execute(raw);
      expect(Number(tries.rows[0]?.last_value)).toBeGreaterThanOrEqual(2);
      await waitFor(() => processed("retry-1"), 10_000, "retry job completed");
      const msgs = await userMessages(conv);
      expect(msgs.map((m) => (m.payload as { clientMessageId?: string }).clientMessageId)).toEqual([
        `${connId}:retry-1`,
      ]);
      expect((await threads()).filter((r) => r.chat_id === "dm-u-retry")).toHaveLength(1);
    } finally {
      await sql
        .raw(`DROP TRIGGER IF EXISTS w2_inbound_fail ON capybara.channel_deliveries`)
        .execute(raw);
    }
  }, 40_000);

  it("onEvent 只去重并入队：平台重投同一条消息只排一个任务、只写一次", async () => {
    await k.channels.inbound.onEvent(connId, dm("enq-1", "u-race", "hello"));
    await k.channels.inbound.onEvent(connId, dm("enq-1", "u-race", "hello"));
    await waitFor(() => processed("enq-1"), 10_000, "job completed");
    await sleep(300);
    const r = await sql`SELECT 1 FROM capybara.conversation_events
      WHERE payload->>'clientMessageId' = ${`${connId}:enq-1`}`.execute(raw);
    expect(r.rows).toHaveLength(1);
  });
});

describe("发言人资料与外部租户（Ruling A22）", () => {
  const setPolicy = async (unboundPolicy: "bind" | "anonymous") => {
    const p = await owner({
      method: "PATCH",
      url: `/api/v1/orgs/${orgId}/channels/${connId}`,
      payload: { unboundPolicy },
    });
    expect(p.statusCode).toBe(200);
  };
  const bindTokenOf = (s: FakeChannelSent | undefined) => {
    const card = s?.message.cards?.[0];
    const url = card && "url" in card ? String(card.url) : "";
    return url.slice(url.indexOf("/bind/") + "/bind/".length);
  };

  it("绑定确认页显示平台给的显示名；没有显示名时回落到 externalId", async () => {
    await setPolicy("bind");
    let n = im.sent.length;
    im.push(connId, dm("dn-1", "u-named", "hi", "t1", { displayName: "Named Person" }));
    const named = await sentAfter(n, "dm-u-named");
    const peek = await owner({ method: "GET", url: `/api/v1/bind/${bindTokenOf(named)}` });
    expect(peek.statusCode, peek.body).toBe(200);
    expect((peek.json() as { binding: { displayName: string } }).binding.displayName).toBe(
      "Named Person",
    );
    n = im.sent.length;
    im.push(connId, dm("dn-2", "u-plain", "hi"));
    const plain = await sentAfter(n, "dm-u-plain");
    const peek2 = await owner({ method: "GET", url: `/api/v1/bind/${bindTokenOf(plain)}` });
    expect((peek2.json() as { binding: { displayName: string } }).binding.displayName).toBe(
      "u-plain",
    );
  });

  it("匿名策略下，租户与连接不同的发言人（外部联系人）只能绑定，不按匿名访客处理", async () => {
    await setPolicy("anonymous");
    try {
      const n = im.sent.length;
      im.push(connId, dm("ext-1", "u-ext", "hi", "t2"));
      const s = await sentAfter(n, "dm-u-ext");
      expect(s?.message.cards?.[0]?.kind).toBe("bind");
      await waitFor(() => processed("ext-1"), 10_000, "ext job");
      expect((await threads()).filter((r) => r.chat_id === "dm-u-ext")).toEqual([]);
    } finally {
      await setPolicy("bind");
    }
  });
});

/** 匿名策略下没有「必回」的哨兵：等该消息出现在某个对话里。 */
async function pushAndSettleAnon(e: Parameters<FakeChannelServer["push"]>[1]): Promise<void> {
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
