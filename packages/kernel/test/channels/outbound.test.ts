import { fileURLToPath } from "node:url";
import type { ChannelCard, ChannelTarget } from "@capybara-hq/plugin-sdk";
import {
  fakeCardAction as cardAction,
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
import { CHANNEL_QUEUE_NAME, idempotencyKey } from "../../src/channels/outbound.js";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { COLOR_FORM } from "../fixtures/plugins/mem-connector/index.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  cardRecorded,
  createOrg,
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  waitFor,
  waitForEvent,
} from "../helpers/runs.js";

/**
 * Task 11：出站投递（流式草稿、定稿、卡片与卡片操作、发送失败分类）。单副本；崩溃续投见 outbound.dual.test.ts。
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const CHAN_NOEDIT = fileURLToPath(
  new URL("../fixtures/plugins/chan-noedit/index.ts", import.meta.url),
);
const CHAN_PLAIN = fileURLToPath(
  new URL("../fixtures/plugins/chan-plain/index.ts", import.meta.url),
);
const CHAN_SLOWEDIT = fileURLToPath(
  new URL("../fixtures/plugins/chan-slowedit/index.ts", import.meta.url),
);
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ECHO =
  'tool:mem-connector__echo:{"text":"hi","apiKey":"sk-live-0123456789abcdef","max_tokens":42,"note":"app-secret-1234567"}';
const ASK = "tool:mem-connector__ask:{}";

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
let noEditId: string;
let failId: string;
let anonId: string;
let slowId: string;
let plainId: string;
let redis: Redis;
/** 出站投递任务空闲多久结束（测试缩短到 1s）。 */
const IDLE_MS = 1000;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CHAN_MINI, CHAN_NOEDIT, CHAN_SLOWEDIT, CHAN_PLAIN, MEM_CONNECTOR],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000, deliveryIdleMs: IDLE_MS },
        // fake-idle：流式输出停顿 400ms 即判超时（构造流式中途失败的运行）
        pluginConfig: {
          "model-fake": {
            models: [{ id: "fake-1" }, { id: "fake-idle", streamIdleTimeoutMs: 400 }],
          },
        },
      },
    ),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
  const accounts = new AccountsService(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  const member = await accounts.createLocal({ login: "mem", password: PW, displayName: "Mem" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, member.id, "member", ownerId);
  for (const plugin of [
    "chan-mini",
    "chan-noedit",
    "chan-slowedit",
    "chan-plain",
    "mem-connector",
  ]) {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/plugins/${plugin}`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  const ag = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        tools: [
          { kind: "plugin", plugin: "mem-connector", name: "echo" },
          { kind: "plugin", plugin: "mem-connector", name: "ask" },
        ],
        toolPolicies: { "mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
  for (const [source, ext, acct] of [
    ["chan-mini:t1", "u-owner", ownerId],
    ["chan-mini:t1", "u-member", member.id],
    ["chan-noedit:t1", "u-owner", ownerId],
    ["chan-slowedit:t1", "u-owner", ownerId],
    ["chan-plain:t1", "u-owner", ownerId],
  ] as const) {
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES (${source}, ${ext}, ${acct})`.execute(raw);
  }
  const flaky = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Flaky",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-idle" },
        tools: [],
      },
      visibility: "org",
    },
  });
  expect(flaky.statusCode, flaky.body).toBe(201);
  const flakyId = (flaky.json() as { agent: { id: string } }).agent.id;
  const mk = async (
    plugin: string,
    appId: string,
    agent = agentId,
    unboundPolicy: "bind" | "anonymous" = "bind",
  ) => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin,
        name: plugin,
        agentId: agent,
        unboundPolicy,
        config: { platformUrl: im.url, appId, appSecret: "app-secret-1234567" },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { channel: { id: string } }).channel.id;
    await waitFor(async () => im.active(id).length === 1, 10_000, `${plugin} long connection`);
    return id;
  };
  connId = await mk("chan-mini", "cli_out");
  noEditId = await mk("chan-noedit", "cli_noedit");
  failId = await mk("chan-mini", "cli_fail", flakyId);
  anonId = await mk("chan-mini", "cli_anon", agentId, "anonymous");
  slowId = await mk("chan-slowedit", "cli_slow");
  plainId = await mk("chan-plain", "cli_plain");
}, 120_000);

afterAll(async () => {
  redis?.disconnect();
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const chatOf = (s: FakeChannelSent) => s.target.chatId;
const sentTo = (app: string, chatId: string) =>
  im.sent.filter((s) => s.appId === app && chatOf(s) === chatId);
const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0];
/** 消息最终显示的文本：有更新取最后一次更新，否则为发出时的文本。 */
const finalText = (s: FakeChannelSent) =>
  updatesOf(s.messageId).at(-1)?.message.text ?? s.message.text;

/** 话题行 → 会话 id。 */
async function convOf(conn: string, chatId: string): Promise<string> {
  return waitFor(
    async () => {
      const r = await sql<{ conversation_id: string }>`SELECT conversation_id
        FROM capybara.channel_threads WHERE connection_id = ${conn} AND chat_id = ${chatId}
          AND archived_at IS NULL`.execute(raw);
      return r.rows[0]?.conversation_id;
    },
    10_000,
    "conversation",
  );
}

async function delivery(conversationId: string) {
  return db
    .selectFrom("channel_deliveries")
    .select(["last_seq", "draft_message_id"])
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
}

async function lastSeq(conversationId: string): Promise<number> {
  const r = await db
    .selectFrom("conversations")
    .select("last_seq")
    .where("id", "=", conversationId)
    .executeTakeFirstOrThrow();
  return Number(r.last_seq);
}

/** 投递进度追上会话日志且没有草稿。 */
async function settled(conversationId: string): Promise<void> {
  await waitFor(
    async () => {
      const d = await delivery(conversationId);
      if (!d) return false;
      const runs = await db
        .selectFrom("runs")
        .select("status")
        .where("conversation_id", "=", conversationId)
        .where("status", "in", ["queued", "running"])
        .execute();
      return (
        runs.length === 0 &&
        Number(d.last_seq) === (await lastSeq(conversationId)) &&
        d.draft_message_id === null
      );
    },
    15_000,
    "delivery settled",
  );
}

async function failCountOf(conversationId: string): Promise<number> {
  const r = await db
    .selectFrom("channel_deliveries")
    .select("fail_count")
    .where("conversation_id", "=", conversationId)
    .executeTakeFirst();
  return Number(r?.fail_count ?? 0);
}

async function lastError(connectionId: string): Promise<string | null> {
  const r = await db
    .selectFrom("channel_connections")
    .select("last_error")
    .where("id", "=", connectionId)
    .executeTakeFirstOrThrow();
  return r.last_error;
}

async function approvalStatus(id: string): Promise<string> {
  const r = await db
    .selectFrom("approvals")
    .select("status")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return r.status;
}

const LONG = "The quick brown fox jumps over the lazy dog while streaming tokens to IM. ".repeat(2);

describe("出站投递：流式回复", { timeout: 40_000 }, () => {
  it("首个增量发草稿，之后至多每秒更新一次，定稿为完整文本；不发 thinking；进度推进且清草稿", async () => {
    const chat = "dm-u-owner";
    im.push(connId, dm("s1", "u-owner", `slow:60:${LONG}`));
    const conv = await convOf(connId, chat);
    await settled(conv);
    const msgs = sentTo("cli_out", chat);
    // 只发了一条消息（草稿），其余都是更新
    expect(msgs).toHaveLength(1);
    const draft = msgs[0] as FakeChannelSent;
    expect(LONG.startsWith(draft.message.text)).toBe(true);
    expect(draft.message.text.length).toBeLessThan(LONG.length);
    const ups = updatesOf(draft.messageId);
    expect(ups.length).toBeGreaterThanOrEqual(2);
    expect(ups.at(-1)?.message.text).toBe(LONG);
    // 节流：除最后一次定稿外，相邻两次（含草稿）间隔 ≥ 1 秒
    const times = [draft.at, ...ups.slice(0, -1).map((u) => u.at)];
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(950);
    }
    for (const u of ups.slice(0, -1)) expect(LONG.startsWith(u.message.text)).toBe(true);
    expect((await delivery(conv))?.draft_message_id).toBeNull();
  });

  it("Ruling A22：features.minEditIntervalMs 放慢草稿更新（间隔取 max(1000, minEditIntervalMs)）", async () => {
    const chat = "dm-u-owner";
    im.push(slowId, dm("se1", "u-owner", `slow:200:${LONG}`));
    const conv = await convOf(slowId, chat);
    await settled(conv);
    const msgs = sentTo("cli_slow", chat);
    expect(msgs).toHaveLength(1);
    const draft = msgs[0] as FakeChannelSent;
    const ups = updatesOf(draft.messageId);
    expect(ups.at(-1)?.message.text).toBe(LONG);
    expect(ups.length).toBeGreaterThanOrEqual(2);
    const times = [draft.at, ...ups.slice(0, -1).map((u) => u.at)];
    for (let i = 1; i < times.length; i++) {
      expect((times[i] as number) - (times[i - 1] as number)).toBeGreaterThanOrEqual(2450);
    }
    // 组织语言（Ruling A22）随每次发送 / 更新交给插件
    expect(draft.locale).toBe("en");
    expect(ups.every((u) => u.locale === "en")).toBe(true);
  });

  it("features.edit = false 的渠道不发草稿、不更新，只在定稿时发一条完整消息", async () => {
    const chat = "dm-u-owner";
    im.push(noEditId, dm("n1", "u-owner", `slow:30:${LONG}`));
    const conv = await convOf(noEditId, chat);
    await settled(conv);
    const msgs = sentTo("cli_noedit", chat);
    expect(msgs.map((m) => m.message.text)).toEqual([LONG]);
    expect(im.updated.filter((u) => u.appId === "cli_noedit")).toEqual([]);
    // Ruling A15：普通消息的幂等键由 "<会话>-<事件 seq>" 稳定哈希而来，32 个 [A-Za-z0-9_-] 字符
    const final = (await eventsOf(db, conv)).filter((e) => e.type === "assistant_message").at(-1);
    expect(msgs[0]?.idempotencyKey).toBe(idempotencyKey(`${conv}-${final?.seq}`));
    expect(msgs[0]?.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it("I1：流式中途运行失败 → 草稿收尾为「已有文本 + 失败说明」并清除；下一条回复是新消息，不改旧草稿", async () => {
    const chat = "dm-u-owner";
    im.push(failId, dm("f1", "u-owner", "slow:2000:Partial answer that never finishes"));
    const conv = await convOf(failId, chat);
    await waitForEvent(db, conv, (e) => e.type === "run_failed", 15_000, "run_failed");
    const draft = await waitFor(async () => sentTo("cli_fail", chat)[0], 10_000, "draft");
    await waitFor(
      async () => finalText(draft).includes("Sorry, something went wrong"),
      10_000,
      "draft closed with the failure marker",
    );
    // 已有文本（本任务从头收到时）+ 失败说明；中途接手、不知道已有文本时只有说明
    expect(finalText(draft)).toMatch(/(^Part[\s\S]*\n\n|^)Sorry, something went wrong/);
    await settled(conv);
    const updatesBefore = updatesOf(draft.messageId).length;
    im.push(failId, dm("f2", "u-owner", "echo:next reply"));
    await waitFor(
      async () => sentTo("cli_fail", chat).some((s) => finalText(s) === "next reply"),
      15_000,
      "next reply as a new message",
    );
    await settled(conv);
    expect(updatesOf(draft.messageId)).toHaveLength(updatesBefore);
    expect(sentTo("cli_fail", chat).filter((s) => s.message.text.startsWith("Sorry"))).toEqual([]);
  });

  it("I2：投递锁丢失 → 任务推迟后重试（不是直接结束），回复照常定稿", async () => {
    const chat = "grp-lease";
    const q = new Queue(CHANNEL_QUEUE_NAME, { connection: new Redis(rd.url) });
    try {
      im.push(connId, group("l1", "u-owner", `slow:100:${LONG}`, { chatId: chat }));
      const conv = await convOf(connId, chat);
      const draft = await waitFor(async () => sentTo("cli_out", chat)[0], 10_000, "draft");
      // 别人抢走了投递锁
      await redis.set(`capk:channel-deliver:${conv}`, "intruder", "PX", 1500);
      await waitFor(
        async () =>
          (await q.getJobs(["delayed", "waiting", "active"])).some(
            (j) => (j.data as { conversationId?: string }).conversationId === conv,
          ),
        5_000,
        "requeued delivery job",
      );
      await waitFor(async () => finalText(draft) === LONG, 20_000, "final text");
      await settled(conv);
      expect(sentTo("cli_out", chat)).toHaveLength(1);
    } finally {
      await q.close();
    }
  });

  it("I3：追上后空闲即结束（不占并发槽）；之后的输出由下一个事件触发的新任务投递", async () => {
    const chat = "grp-idle";
    im.push(connId, group("i1", "u-owner", "slow:2500:abcdefgh", { chatId: chat }));
    const conv = await convOf(connId, chat);
    const draft = await waitFor(async () => sentTo("cli_out", chat)[0], 10_000, "draft");
    expect(draft.message.text).toBe("abcd");
    // 第二块要 2.5s 后才来：空闲 1s 后任务结束、释放投递锁
    await waitFor(
      async () => (await redis.get(`capk:channel-deliver:${conv}`)) === null,
      2_200,
      "idle delivery job exited",
    );
    const runs = await db
      .selectFrom("runs")
      .select("status")
      .where("conversation_id", "=", conv)
      .execute();
    expect(runs.map((r) => r.status)).toContain("running");
    await waitFor(async () => finalText(draft) === "abcdefgh", 15_000, "final text");
    await settled(conv);
    expect(sentTo("cli_out", chat)).toHaveLength(1);
  });
});

describe("出站投递：卡片与卡片操作", { timeout: 40_000 }, () => {
  let target: ChannelTarget;
  let conv: string;

  it("审批卡片（打码的参数预览、网页链接）→ 有权者点批准 → 卡片更新为已批准，运行续跑并继续投递", async () => {
    const chat = "dm-u-owner";
    const before = sentTo("cli_out", chat).length;
    im.push(connId, dm("a1", "u-owner", ECHO));
    conv = await convOf(connId, chat);
    const req = await waitForEvent(db, conv, (e) => e.type === "approval_requested");
    const approvalId = (req.payload as { approvalId: string }).approvalId;
    const cardMsg = await waitFor(
      async () =>
        sentTo("cli_out", chat)
          .slice(before)
          .find((s) => cardOf(s)?.kind === "approval"),
      10_000,
      "approval card",
    );
    target = cardMsg.target;
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "approval" }>;
    expect(card).toMatchObject({
      kind: "approval",
      id: approvalId,
      toolName: "echo",
      agentName: "Helper",
      state: "pending",
      scopes: ["once", "session", "always"],
      webUrl: `https://cap.example/chat/${conv}`,
    });
    expect(card.inputPreview).toContain('"text":"hi"');
    expect(card.inputPreview).not.toContain("sk-live-0123456789abcdef");
    // 按值打码（连接的密钥）；max_tokens 这类键不误伤
    expect(card.inputPreview).not.toContain("app-secret-1234567");
    expect(card.inputPreview).toContain('"max_tokens":42');
    expect(card.inputPreview.length).toBeLessThanOrEqual(500);
    // 卡片消息 id 与 last_seq 在发送之后的同一事务里写入
    const rows = await waitFor(
      async () => {
        const r = await sql<{ message_id: string }>`SELECT message_id
          FROM capybara.channel_card_messages WHERE conversation_id = ${conv}
            AND card_kind = 'approval' AND card_id = ${approvalId}`.execute(raw);
        return r.rows.length > 0 ? r.rows : null;
      },
      10_000,
      "card message row",
    );
    expect(rows).toEqual([{ message_id: cardMsg.messageId }]);

    const n = sentTo("cli_out", chat).length;
    im.push(
      connId,
      cardAction(
        "a1-act",
        "u-owner",
        { cardKind: "approval", cardId: approvalId, action: "approve", scope: "once" },
        target,
      ),
    );
    await waitFor(
      async () => (await approvalStatus(approvalId)) === "approved",
      10_000,
      "approved",
    );
    const up = await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).find(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "approved",
        ),
      10_000,
      "card updated",
    );
    expect(cardOf(up)).toMatchObject({ kind: "approval", state: "approved", decidedBy: "Owner" });
    // 续跑后的回复继续投递
    await waitFor(
      async () =>
        sentTo("cli_out", chat)
          .slice(n)
          .some((s) => finalText(s).startsWith("Tool result:")),
      15_000,
      "reply after approval",
    );
    await settled(conv);
  });

  it("Review Focus 2：非审批人点击无效且收到一句说明；未绑定的人在卡片所在私聊得到绑定卡片；卡片 id 在别的会话被点只回「不能处理」", async () => {
    const chat = "dm-u-owner";
    const approvals = async () =>
      (await eventsOf(db, conv)).filter((e) => e.type === "approval_requested");
    const known = (await approvals()).length;
    im.push(connId, dm("a2", "u-owner", ECHO));
    const evs = await waitFor(
      async () => {
        const a = await approvals();
        return a.length > known ? a : null;
      },
      10_000,
      "second approval",
    );
    const approvalId = (evs[evs.length - 1]?.payload as { approvalId: string } | undefined)
      ?.approvalId as string;
    const cardMsg = await waitFor(
      async () =>
        sentTo("cli_out", chat).find((s) => (cardOf(s) as { id?: string })?.id === approvalId),
      10_000,
      "second approval card",
    );
    await cardRecorded(db, cardMsg);
    const updatesBefore = updatesOf(cardMsg.messageId).length;

    // 组织里的另一个成员（不是审批人）点了批准
    const n = im.sent.length;
    im.push(
      connId,
      cardAction(
        "a2-x",
        "u-member",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        target,
      ),
    );
    const reply = await waitFor(async () => im.sent.slice(n)[0], 10_000, "explanation");
    expect(reply.target).toEqual(target);
    expect(reply.message.text).toBe("You can't handle this request.");
    expect(reply.message.cards).toBeUndefined();

    // 未绑定的人在卡片所在的私聊里点卡片 → 绑定卡片（会话类型取发卡片时记下的）
    const n2 = im.sent.length;
    im.push(
      connId,
      cardAction(
        "a2-g",
        "u-ghost",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        { chatId: target.chatId, chatType: "group" },
      ),
    );
    const bind = await waitFor(async () => im.sent.slice(n2)[0], 10_000, "bind prompt");
    expect(bind.target).toEqual(target);
    expect(cardOf(bind)?.kind).toBe("bind");

    // 私聊卡片的 id 在群里被点（转发 / 重放）：不解析发言人、不发绑定链接，只回「不能处理」（按群处理）
    // ——插件给的会话类型只是参考，声称是私聊也一样
    for (const [id, claimed] of [
      ["a2-h", { chatId: "grp-9", chatType: "group", threadId: "t9" }],
      ["a2-i", { chatId: "grp-9", chatType: "dm" }],
    ] as const) {
      const n3 = im.sent.length;
      im.push(
        connId,
        cardAction(
          id,
          "u-ghost",
          { cardKind: "approval", cardId: approvalId, action: "deny" },
          claimed,
        ),
      );
      const refusal = await waitFor(async () => im.sent.slice(n3)[0], 10_000, "cross-chat refusal");
      expect(refusal.target).toEqual(
        "threadId" in claimed
          ? { chatId: "grp-9", chatType: "group", threadId: "t9" }
          : { chatId: "grp-9", chatType: "group" },
      );
      expect(refusal.message.cards).toBeUndefined();
      expect(refusal.message.text).toBe("You can't handle this request.");
      expect(JSON.stringify(refusal.message)).not.toMatch(/https?:|bind/);
      await sleep(200);
      expect(im.sent.slice(n3)).toHaveLength(1);
    }

    // Ruling A13：伪造的卡片——审批人本人，但这张卡片并没有发在这个会话里 → 不处理
    const forged: ChannelTarget = { chatId: "grp-forge", chatType: "group", threadId: "x" };
    const n4 = im.sent.length;
    im.push(
      connId,
      cardAction(
        "a2-f",
        "u-owner",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        forged,
      ),
    );
    const refused = await waitFor(async () => im.sent.slice(n4)[0], 10_000, "forged refusal");
    expect(refused.target).toEqual(forged);
    expect(refused.message.text).toBe("You can't handle this request.");

    await sleep(300);
    expect(await approvalStatus(approvalId)).toBe("pending");
    expect(updatesOf(cardMsg.messageId)).toHaveLength(updatesBefore);

    // 收尾：审批人拒绝
    im.push(
      connId,
      cardAction(
        "a2-d",
        "u-owner",
        { cardKind: "approval", cardId: approvalId, action: "deny" },
        target,
      ),
    );
    await waitFor(async () => (await approvalStatus(approvalId)) === "denied", 10_000, "denied");
    await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).some(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "denied",
        ),
      10_000,
      "card denied",
    );
    await settled(conv);
  });

  it("提问卡片（单选可在 IM 内答）→ 发起人在卡片上回答 → 卡片显示答案，运行续跑", async () => {
    const chat = "dm-u-owner";
    const before = sentTo("cli_out", chat).length;
    im.push(connId, dm("q1", "u-owner", ASK));
    const cardMsg = await waitFor(
      async () =>
        sentTo("cli_out", chat)
          .slice(before)
          .find((s) => cardOf(s)?.kind === "question"),
      10_000,
      "question card",
    );
    await cardRecorded(db, cardMsg);
    const card = cardOf(cardMsg) as Extract<ChannelCard, { kind: "question" }>;
    expect(card).toMatchObject({
      kind: "question",
      state: "pending",
      form: COLOR_FORM,
      webUrl: `https://cap.example/chat/${conv}`,
    });
    const n = sentTo("cli_out", chat).length;
    im.push(
      connId,
      cardAction(
        "q1-a",
        "u-owner",
        { cardKind: "question", cardId: card.id, action: "answer", answer: { color: "blue" } },
        cardMsg.target,
      ),
    );
    const up = await waitFor(
      async () =>
        updatesOf(cardMsg.messageId).find(
          (u) => (cardOf(u) as { state?: string } | undefined)?.state === "answered",
        ),
      20_000,
      "question card answered",
    );
    expect(cardOf(up)).toMatchObject({
      kind: "question",
      state: "answered",
      answerSummary: "blue",
    });
    await waitFor(
      async () =>
        sentTo("cli_out", chat)
          .slice(n)
          .some((s) => finalText(s).includes("color=blue")),
      15_000,
      "reply after answer",
    );
    await settled(conv);
  });

  it("Ruling A13：匿名访客只能处理自己话题里的卡片，且范围强制为仅此一次", async () => {
    const chat = "grp-anon";
    im.push(anonId, group("an1", "u-anon-a", ECHO, { chatId: chat }));
    const cardMsg = await waitFor(
      async () =>
        im.sent.find(
          (s) => s.appId === "cli_anon" && chatOf(s) === chat && cardOf(s)?.kind === "approval",
        ),
      15_000,
      "anonymous approval card",
    );
    const approvalId = (cardOf(cardMsg) as { id: string }).id;
    expect(cardMsg.target).toEqual({ chatId: chat, chatType: "group", threadId: "an1" });
    await cardRecorded(db, cardMsg);
    // 另一个匿名访客（同一个共享访客账号）在别的话题里点了这张卡片
    const other: ChannelTarget = { chatId: chat, chatType: "group", threadId: "an-b" };
    const n = im.sent.length;
    im.push(
      anonId,
      cardAction(
        "an-b",
        "u-anon-b",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        other,
      ),
    );
    const refused = await waitFor(async () => im.sent.slice(n)[0], 10_000, "refusal");
    expect(refused.message.text).toBe("You can't handle this request.");
    await sleep(300);
    expect(await approvalStatus(approvalId)).toBe("pending");
    // 发起的匿名访客在自己的话题里批准「以后都允许」→ 只按仅此一次生效
    im.push(
      anonId,
      cardAction(
        "an-a",
        "u-anon-a",
        { cardKind: "approval", cardId: approvalId, action: "approve", scope: "always" },
        cardMsg.target,
      ),
    );
    await waitFor(async () => (await approvalStatus(approvalId)) === "approved", 10_000, "ok");
    const a = await db
      .selectFrom("approvals")
      .select("scope")
      .where("id", "=", approvalId)
      .executeTakeFirstOrThrow();
    expect(a.scope).toBe("once");
    await settled(await convOf(anonId, chat));
  });
});

describe("卡片操作：eventId 去重与缺 threadId（Ruling A26）", { timeout: 40_000 }, () => {
  it("平台用同一 eventId 重投卡片点击 → 只处理一次（不回「已处理」）", async () => {
    const chat = "grp-evt";
    im.push(connId, group("ev1", "u-owner", ECHO, { chatId: chat }));
    const cardMsg = await waitFor(
      async () => sentTo("cli_out", chat).find((s) => cardOf(s)?.kind === "approval"),
      15_000,
      "approval card",
    );
    const approvalId = (cardOf(cardMsg) as { id: string }).id;
    await cardRecorded(db, cardMsg);
    // 未绑定的人在卡片所在的群里点卡片，插件声称是私聊 → 仍按记下的群处理：只提示去私聊，不含链接
    const n0 = im.sent.length;
    im.push(
      connId,
      cardAction(
        "ev1-ghost",
        "u-ghost",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        { chatId: chat, chatType: "dm" },
      ),
    );
    const hint = await waitFor(async () => im.sent.slice(n0)[0], 10_000, "dm hint");
    expect(hint.target).toEqual(cardMsg.target);
    expect(hint.message.cards).toBeUndefined();
    expect(hint.message.text).not.toMatch(/https?:/);
    expect(hint.message.text).toMatch(/direct message/);
    const n = im.sent.length;
    const tap = {
      ...cardAction(
        "ev1-card",
        "u-owner",
        { cardKind: "approval", cardId: approvalId, action: "approve", scope: "once" },
        cardMsg.target,
      ),
      eventId: "evt-dup-1",
    } as const;
    im.push(connId, tap);
    im.push(connId, tap);
    await waitFor(async () => (await approvalStatus(approvalId)) === "approved", 10_000, "ok");
    await settled(await convOf(connId, chat));
    await sleep(500);
    expect(
      im.sent.slice(n).filter((s) => s.message.text === "This request has already been handled."),
    ).toEqual([]);
  });

  it("群里的卡片点击不带 threadId → 按发卡片时记下的话题判断（匿名访客照常处理自己话题里的卡片）", async () => {
    const chat = "grp-anon-nothread";
    im.push(anonId, group("nt1", "u-anon-c", ECHO, { chatId: chat }));
    const cardMsg = await waitFor(
      async () =>
        im.sent.find(
          (s) => s.appId === "cli_anon" && chatOf(s) === chat && cardOf(s)?.kind === "approval",
        ),
      15_000,
      "anonymous approval card",
    );
    const approvalId = (cardOf(cardMsg) as { id: string }).id;
    await cardRecorded(db, cardMsg);
    const n = im.sent.length;
    im.push(
      anonId,
      cardAction(
        cardMsg.messageId,
        "u-anon-c",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        { chatId: chat, chatType: "group" },
      ),
    );
    await waitFor(async () => (await approvalStatus(approvalId)) === "approved", 20_000, "ok");
    expect(
      im.sent.slice(n).filter((s) => s.message.text === "You can't handle this request."),
    ).toEqual([]);
    await settled(await convOf(anonId, chat));
  });
});

describe("features.cards / threads = false 的渠道（Ruling A33）", { timeout: 40_000 }, () => {
  it("卡片按 renderCardAsText 拼进正文、不传 cards；群聊回复与卡片的目标都不带 threadId", async () => {
    const chat = "grp-plain";
    im.push(plainId, group("pl1", "u-owner", ECHO, { chatId: chat }));
    const cardMsg = await waitFor(
      async () => sentTo("cli_plain", chat).find((s) => s.message.text.includes("[Approval]")),
      15_000,
      "approval as text",
    );
    expect(cardMsg.message.cards).toBeUndefined();
    expect(cardMsg.message.text).toContain("https://cap.example/chat/");
    expect(sentTo("cli_plain", chat).every((s) => s.message.cards === undefined)).toBe(true);
    expect(sentTo("cli_plain", chat).every((s) => s.target.threadId === undefined)).toBe(true);
    expect(cardMsg.target).toEqual({ chatId: chat, chatType: "group" });
  });

  it("未绑定的人私聊：绑定卡片退回为文本（含绑定链接）", async () => {
    im.push(plainId, dm("pl2", "u-stranger-plain", "hello"));
    const msg = await waitFor(
      async () => sentTo("cli_plain", "dm-u-stranger-plain")[0],
      10_000,
      "bind text",
    );
    expect(msg.message.cards).toBeUndefined();
    expect(msg.message.text).toMatch(/https:\/\/cap\.example\/bind\//);
  });
});

describe("出站投递：发送失败", { timeout: 40_000 }, () => {
  it("Ruling A14：同一事件不可重试地失败 3 次 → 跳过它并提示去网页查看，之后的回复照常投递", async () => {
    const chat = "grp-poison";
    im.failNext("/send", 400, 3);
    const failCount = async (c: string) =>
      Number(
        (
          await db
            .selectFrom("channel_deliveries")
            .select("fail_count")
            .where("conversation_id", "=", c)
            .executeTakeFirst()
        )?.fail_count ?? 0,
      );
    im.push(noEditId, group("p1", "u-owner", "echo:poison one", { chatId: chat }));
    const conv = await convOf(noEditId, chat);
    const phraseSent = () =>
      sentTo("cli_noedit", chat).some((s) => s.message.text.startsWith("A request is waiting"));
    // 每条新消息都会触发一次续投（重试卡住的事件），直到第 3 次失败后跳过
    let i = 2;
    while (!phraseSent() && i <= 5) {
      await waitFor(async () => (await failCount(conv)) >= i - 1 || phraseSent(), 15_000, "fail");
      if (phraseSent()) break;
      im.push(
        noEditId,
        group(`p${i}`, "u-owner", `echo:reply ${i}`, { chatId: chat, threadId: "p1" }),
      );
      i++;
      await sleep(300);
    }
    await waitFor(async () => phraseSent(), 15_000, "skip notice");
    im.push(
      noEditId,
      group("p-after", "u-owner", "echo:after skip", { chatId: chat, threadId: "p1" }),
    );
    await waitFor(
      async () => sentTo("cli_noedit", chat).some((s) => s.message.text === "after skip"),
      15_000,
      "later reply delivered",
    );
    await settled(conv);
    expect(sentTo("cli_noedit", chat).some((s) => s.message.text === "poison one")).toBe(false);
    expect(await failCount(conv)).toBe(0);
    await db
      .updateTable("channel_connections")
      .set({ last_error: null })
      .where("id", "=", noEditId)
      .execute();
  });

  it("限流（可重试）→ BullMQ 退避后重试，恰好投递一次", async () => {
    const chat = "grp-rl";
    im.failNext("/send", 429, 2, 100);
    im.push(connId, group("r1", "u-owner", "echo:rate limited reply", { chatId: chat }));
    const conv = await convOf(connId, chat);
    await settled(conv);
    const msgs = sentTo("cli_out", chat).filter((s) => finalText(s) === "rate limited reply");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]?.target.threadId).toBe("r1");
    const c = await db
      .selectFrom("channel_connections")
      .select("last_error")
      .where("id", "=", connId)
      .executeTakeFirstOrThrow();
    expect(c.last_error).toBeNull();
  });

  it("Ruling A22：定稿时编辑草稿被平台拒绝 → 改发一条完整的新消息，不计毒事件、不记 last_error", async () => {
    const chat = "grp-edit-rejected";
    // 草稿只发一次、流式 < 1s 不会有中间更新：第一次更新就是定稿
    im.failNext("/update", 400, 1);
    im.push(connId, group("er1", "u-owner", "slow:50:Draft then rejected", { chatId: chat }));
    const conv = await convOf(connId, chat);
    await settled(conv);
    const msgs = sentTo("cli_out", chat);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.message.text).toBe("Draft then rejected");
    expect(updatesOf(msgs[0]?.messageId as string)).toEqual([]);
    expect(await failCountOf(conv)).toBe(0);
    expect(await lastError(connId)).toBeNull();
  });

  it("流式中途编辑草稿被拒 → 不再编辑它，定稿时改发一条完整的新消息（不计毒事件）", async () => {
    const chat = "grp-mid-rejected";
    // 草稿之后的第一次编辑（流式中途，约 1s 后）被拒
    im.failNext("/update", 400, 1);
    im.push(connId, group("mr1", "u-owner", `slow:150:${LONG}`, { chatId: chat }));
    const conv = await convOf(connId, chat);
    await settled(conv);
    const msgs = sentTo("cli_out", chat);
    expect(msgs).toHaveLength(2);
    expect(LONG.startsWith(msgs[0]?.message.text as string)).toBe(true);
    expect(updatesOf(msgs[0]?.messageId as string)).toEqual([]);
    expect(msgs[1]?.message.text).toBe(LONG);
    expect(await failCountOf(conv)).toBe(0);
    expect(await lastError(connId)).toBeNull();
  });

  it("草稿已不能编辑时运行失败 → 失败说明作为新消息发出（不静默跳过）", async () => {
    const chat = "grp-broken-fail";
    // 草稿之后的第一次编辑（流式中途）被拒；随后模型报错、运行失败（没有 assistant_message）
    im.failNext("/update", 400, 1);
    im.push(
      connId,
      group("bf1", "u-owner", "slowfail:400:abcdefghijklmnopqrstuvwx", { chatId: chat }),
    );
    const conv = await convOf(connId, chat);
    await waitForEvent(db, conv, (e) => e.type === "run_failed", 15_000, "run_failed");
    await waitFor(
      async () =>
        sentTo("cli_out", chat).some((s) =>
          s.message.text.startsWith("Sorry, something went wrong"),
        ),
      15_000,
      "failure marker as a new message",
    );
    await settled(conv);
    const msgs = sentTo("cli_out", chat);
    expect(msgs).toHaveLength(2);
    expect(updatesOf(msgs[0]?.messageId as string)).toEqual([]);
  });

  it("N4：草稿编辑与改发的新消息都被拒绝 → 同一事件第 3 次失败时跳过，跳过前尽力收尾草稿（失败说明）", async () => {
    const chat = "grp-poison-draft";
    im.push(connId, group("pd1", "u-owner", "slow:50:Poisoned draft text", { chatId: chat }));
    const draft = await waitFor(async () => sentTo("cli_out", chat)[0], 10_000, "draft");
    // 之后 3 次定稿（编辑草稿 + 改发新消息）都被平台拒绝；第 4 次编辑（收尾草稿）与提示放行
    im.failNext("/update", 400, 3);
    im.failNext("/send", 400, 3);
    const conv = await convOf(connId, chat);
    const notice = () =>
      sentTo("cli_out", chat).some((s) => s.message.text.startsWith("A request is waiting"));
    let n = 2;
    while (!notice() && n <= 5) {
      await sleep(1500);
      if (notice()) break;
      im.push(
        connId,
        group(`pd${n}`, "u-owner", `echo:more ${n}`, { chatId: chat, threadId: "pd1" }),
      );
      n++;
    }
    await waitFor(async () => notice(), 15_000, "skip notice");
    await waitFor(
      async () => finalText(draft).includes("Sorry, something went wrong"),
      10_000,
      "draft closed before the skip",
    );
    await settled(conv);
    expect(sentTo("cli_out", chat).some((s) => s.message.text === "Poisoned draft text")).toBe(
      false,
    );
    await db
      .updateTable("channel_connections")
      .set({ last_error: null })
      .where("id", "=", connId)
      .execute();
  });

  it("Ruling A22：reason = auth → 记连接 last_error、停止本轮，不计毒事件（连续失败也不跳过）；凭据恢复后照常投递", async () => {
    const chat = "grp-auth";
    im.failNext("/send", 403, 3, undefined, "auth");
    im.push(noEditId, group("au1", "u-owner", "echo:after auth", { chatId: chat }));
    const conv = await convOf(noEditId, chat);
    const err = await waitFor(() => lastError(noEditId), 15_000, "last_error");
    expect(err).toMatch(/403/);
    const delivered = () => sentTo("cli_noedit", chat).some((s) => s.message.text === "after auth");
    // 每条新消息触发一次续投；按毒事件计数的话第 3 次失败就会跳过它
    let n = 2;
    while (!delivered() && n <= 6) {
      await sleep(800);
      if (delivered()) break;
      im.push(
        noEditId,
        group(`au${n}`, "u-owner", `echo:auth more ${n}`, { chatId: chat, threadId: "au1" }),
      );
      n++;
    }
    await waitFor(async () => delivered(), 15_000, "delivered after the credentials recovered");
    await settled(conv);
    expect(
      sentTo("cli_noedit", chat).some((s) => s.message.text.startsWith("A request is waiting")),
    ).toBe(false);
    expect(await failCountOf(conv)).toBe(0);
    await db
      .updateTable("channel_connections")
      .set({ last_error: null })
      .where("id", "=", noEditId)
      .execute();
  });

  it("Ruling A22：reason = target_gone（机器人被移出群）→ 停止本轮，不计毒事件、不记 last_error", async () => {
    const chat = "grp-gone";
    im.failNext("/send", 403, 1, undefined, "target_gone");
    im.push(noEditId, group("tg1", "u-owner", "echo:bot was removed", { chatId: chat }));
    const conv = await convOf(noEditId, chat);
    // 同一运行之后的事件触发新任务重投（平台这次放行）：恰好投递一次
    await waitFor(
      async () => sentTo("cli_noedit", chat).some((s) => s.message.text === "bot was removed"),
      15_000,
      "delivered on a later job",
    );
    await settled(conv);
    expect(
      sentTo("cli_noedit", chat).filter((s) => s.message.text === "bot was removed"),
    ).toHaveLength(1);
    expect(await failCountOf(conv)).toBe(0);
    expect(await lastError(noEditId)).toBeNull();
  });

  it("target_gone 的失败请求很慢：同一运行的后续事件在它持锁期间到达（其任务直接结束），结束时复核补投", async () => {
    const chat = "grp-gone-slow";
    // 失败响应推迟 2 秒：运行在此期间跑完，后续事件的投递任务都见锁被占直接结束（CI 负载下的时序）
    im.failNext("/send", 403, 1, undefined, "target_gone", 2000);
    im.push(noEditId, group("tgs1", "u-owner", "echo:removed while slow", { chatId: chat }));
    const conv = await convOf(noEditId, chat);
    await waitFor(
      async () => sentTo("cli_noedit", chat).some((s) => s.message.text === "removed while slow"),
      15_000,
      "delivered by the follow-up after the stopped job",
    );
    await settled(conv);
    expect(
      sentTo("cli_noedit", chat).filter((s) => s.message.text === "removed while slow"),
    ).toHaveLength(1);
    expect(await failCountOf(conv)).toBe(0);
    expect(await lastError(noEditId)).toBeNull();
  });

  it("不可重试 → 记连接 last_error，停止本轮；会话后续事件触发续投，消息恰好投递一次", async () => {
    const chat = "grp-fatal";
    im.failNext("/send", 400, 1);
    im.push(connId, group("f1", "u-owner", "echo:delivered later", { chatId: chat }));
    const conv = await convOf(connId, chat);
    const err = await waitFor(
      async () =>
        (
          await db
            .selectFrom("channel_connections")
            .select("last_error")
            .where("id", "=", connId)
            .executeTakeFirstOrThrow()
        ).last_error,
      15_000,
      "last_error",
    );
    expect(err).toMatch(/400/);
    // 不需要等下一条消息：同一运行之后写入的事件就会触发新任务从 last_seq 续投
    await waitFor(
      async () => sentTo("cli_out", chat).some((s) => finalText(s) === "delivered later"),
      15_000,
      "delivered on a later job",
    );
    await settled(conv);
    expect(sentTo("cli_out", chat).filter((s) => finalText(s) === "delivered later")).toHaveLength(
      1,
    );
    await db
      .updateTable("channel_connections")
      .set({ last_error: null })
      .where("id", "=", connId)
      .execute();
  });
});
