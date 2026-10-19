import { fileURLToPath } from "node:url";
import type { ChannelCard, ChannelTarget } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import type { Kernel } from "../../src/kernel.js";
import { COLOR_FORM } from "../fixtures/plugins/mem-connector/index.js";
import {
  cardAction,
  dm,
  type FakeIm,
  type FakeImSent,
  group,
  startFakeIm,
} from "../helpers/fake-im.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
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
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ECHO = 'tool:mem-connector__echo:{"text":"hi","apiKey":"sk-live-0123456789abcdef"}';
const ASK = "tool:mem-connector__ask:{}";

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
let noEditId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeIm();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        plugins: [MODEL_FAKE, CHAN_MINI, CHAN_NOEDIT, MEM_CONNECTOR],
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
  const member = await accounts.createLocal({ login: "mem", password: PW, displayName: "Mem" });
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, member.id, "member", ownerId);
  for (const plugin of ["chan-mini", "chan-noedit", "mem-connector"]) {
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
  ] as const) {
    await sql`INSERT INTO capybara.identities (source, external_id, account_id)
      VALUES (${source}, ${ext}, ${acct})`.execute(raw);
  }
  const mk = async (plugin: string, appId: string) => {
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/channels`,
      payload: {
        plugin,
        name: plugin,
        agentId,
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
}, 120_000);

afterAll(async () => {
  await k?.stop();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const chatOf = (s: FakeImSent) => s.target.chatId;
const sentTo = (app: string, chatId: string) =>
  im.sent.filter((s) => s.appId === app && chatOf(s) === chatId);
const updatesOf = (messageId: string) => im.updated.filter((u) => u.messageId === messageId);
const cardOf = (s: FakeImSent | undefined) => s?.message.cards?.[0];
/** 消息最终显示的文本：有更新取最后一次更新，否则为发出时的文本。 */
const finalText = (s: FakeImSent) => updatesOf(s.messageId).at(-1)?.message.text ?? s.message.text;

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
    const draft = msgs[0] as FakeImSent;
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

  it("features.edit = false 的渠道不发草稿、不更新，只在定稿时发一条完整消息", async () => {
    const chat = "dm-u-owner";
    im.push(noEditId, dm("n1", "u-owner", `slow:30:${LONG}`));
    const conv = await convOf(noEditId, chat);
    await settled(conv);
    const msgs = sentTo("cli_noedit", chat);
    expect(msgs.map((m) => m.message.text)).toEqual([LONG]);
    expect(im.updated.filter((u) => u.appId === "cli_noedit")).toEqual([]);
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

  it("Review Focus 2：非审批人点击无效且收到一句说明；未绑定的人私聊得到绑定卡片、群里只提示去私聊", async () => {
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

    // 未绑定的人在私聊里点卡片 → 绑定卡片
    const dmTarget: ChannelTarget = { chatId: "dm-u-ghost", chatType: "dm" };
    const n2 = im.sent.length;
    im.push(
      connId,
      cardAction(
        "a2-g",
        "u-ghost",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        dmTarget,
      ),
    );
    const bind = await waitFor(async () => im.sent.slice(n2)[0], 10_000, "bind prompt");
    expect(bind.target).toEqual(dmTarget);
    expect(cardOf(bind)?.kind).toBe("bind");

    // 未绑定的人在群里点卡片 → 只提示去私聊，不含链接
    const grpTarget: ChannelTarget = { chatId: "grp-9", chatType: "group", threadId: "t9" };
    const n3 = im.sent.length;
    im.push(
      connId,
      cardAction(
        "a2-h",
        "u-ghost",
        { cardKind: "approval", cardId: approvalId, action: "deny" },
        grpTarget,
      ),
    );
    const hint = await waitFor(async () => im.sent.slice(n3)[0], 10_000, "dm hint");
    expect(hint.target).toEqual(grpTarget);
    expect(hint.message.cards).toBeUndefined();
    expect(hint.message.text).not.toMatch(/https?:/);
    expect(hint.message.text).toMatch(/direct message/);

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
      10_000,
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
});

describe("出站投递：发送失败", { timeout: 40_000 }, () => {
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

  it("不可重试 → 记连接 last_error，停止该会话本轮投递", async () => {
    const chat = "grp-fatal";
    im.failNext("/send", 400, 1);
    im.push(connId, group("f1", "u-owner", "echo:never delivered", { chatId: chat }));
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
    await sleep(500);
    expect(sentTo("cli_out", chat).filter((s) => finalText(s) === "never delivered")).toEqual([]);
    expect(Number((await delivery(conv))?.last_seq)).toBeLessThan(await lastSeq(conv));
    await db
      .updateTable("channel_connections")
      .set({ last_error: null })
      .where("id", "=", connId)
      .execute();
  });
});
