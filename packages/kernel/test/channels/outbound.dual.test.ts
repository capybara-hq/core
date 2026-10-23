import { fileURLToPath } from "node:url";
import {
  fakeCardAction as cardAction,
  createDualReplicaHarness,
  fakeDm as dm,
  type FakeChannelSent,
  type FakeChannelServer,
  type Harness,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type KernelDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { AccountsService } from "../../src/identity/accounts.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { eventsOf, PW, sleep, waitFor } from "../helpers/runs.js";

/**
 * Review Focus 3（双副本 + 杀副本）：出站投递进行中，负责投递的 worker 被 SIGKILL——
 * 另一副本从 `channel_deliveries.last_seq` 续投：已投递的审批卡片不重发，流式回复继续更新同一条草稿并以完整文本定稿，
 * 没有重复消息。任务锁 / stalled 检测与投递锁经 `runtime.jobLockMs` / `stalledIntervalMs` 缩短到 2s / 1s。
 */

const CHAN_MINI = fileURLToPath(new URL("../fixtures/plugins/chan-mini/index.ts", import.meta.url));
const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ECHO = 'tool:mem-connector__echo:{"text":"hi"}';
const LONG =
  "Crash-safe delivery keeps streaming into the same IM draft after a replica dies. ".repeat(2);

let pgc: TestContainer;
let rdc: TestContainer;
let im: FakeChannelServer;
let h: Harness | undefined;
const cleanups: (() => Promise<unknown> | unknown)[] = [];

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
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
const cardOf = (s: FakeChannelSent | undefined) => s?.message.cards?.[0] as Json | undefined;
/** 消息最终显示的文本：有更新取最后一次更新，否则为发出时的文本。 */
const finalText = (s: FakeChannelSent) =>
  im.updated.filter((u) => u.messageId === s.messageId).at(-1)?.message.text ?? s.message.text;

/** Two replicas, an org with chan-mini + mem-connector, an agent whose echo tool asks first, a channel. */
async function bootstrap(platform: FakeChannelServer, appId: string) {
  const redis = new Redis(rdc.url);
  cleanups.push(() => redis.disconnect());
  await redis.flushdb();
  h = await createDualReplicaHarness({
    plugins: [MODEL_FAKE, CHAN_MINI, MEM_CONNECTOR],
    pgUrl: pgc.url,
    redisUrl: rdc.url,
    config: {
      auth: { cookieSecure: false },
      http: { publicUrl: "https://cap.example" },
      channels: { leaseTtlMs: 3000, scanIntervalMs: 300 },
      runtime: { jobLockMs: 2000, stalledIntervalMs: 1000 },
    },
  });
  const harness = h;
  const raw = createDb(harness.dbUrl, 3);
  cleanups.push(() => raw.destroy());
  const db: KernelDb = kernelDb(raw);

  let cookie = "";
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await harness.request(path, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        ...(cookie !== "" && { cookie }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (path === "/api/v1/auth/login") {
      cookie = res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");
    }
    return { status: res.status, json: (text === "" ? {} : JSON.parse(text)) as Json };
  };

  const ownerId = (
    await new AccountsService(db).createLocal({ login: "owner", password: PW, displayName: "O" })
  ).id;
  expect((await call("POST", "/api/v1/auth/login", { login: "owner", password: PW })).status).toBe(
    200,
  );
  const org = await call("POST", "/api/v1/orgs", { name: "Acme" });
  const orgId = (org.json.org as { id: string }).id;
  const base = `/api/v1/orgs/${orgId}`;
  for (const p of ["chan-mini", "mem-connector"]) {
    expect((await call("PUT", `${base}/plugins/${p}`, { enabled: true })).status).toBe(200);
  }
  const ag = await call("POST", `${base}/agents`, {
    definition: {
      name: "Helper",
      instructions: "Be helpful.",
      model: { provider: "model-fake", model: "fake-1" },
      tools: [{ kind: "plugin", plugin: "mem-connector", name: "echo" }],
      toolPolicies: { "mem-connector__echo": "ask" },
    },
    visibility: "org",
  });
  expect(ag.status, JSON.stringify(ag.json)).toBe(201);
  const agentId = (ag.json.agent as { id: string }).id;
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  const ch = await call("POST", `${base}/channels`, {
    plugin: "chan-mini",
    name: "Bot",
    agentId,
    config: { platformUrl: platform.url, appId, appSecret: "rf3-secret-0a1b2c3d" },
  });
  expect(ch.status, JSON.stringify(ch.json)).toBe(201);
  const connId = (ch.json.channel as { id: string }).id;
  await waitFor(async () => platform.active(connId)[0], 15_000, "long connection");
  return { harness, raw, db, connId };
}

describe("渠道出站投递（双副本）", () => {
  it("投递中杀掉负责投递的 worker：另一副本从 last_seq 续投，卡片不重发、草稿续写并定稿，无重复", async () => {
    const { harness, raw, db, connId } = await bootstrap(im, "cli_rf3");

    const chat = "dm-u-owner";
    const mine = () => im.sent.filter((s) => s.appId === "cli_rf3" && s.target.chatId === chat);

    // ---- 审批卡片（崩溃前已投递）→ 在卡片上批准 → 续跑回复 ----
    expect(im.push(connId, dm("m1", "u-owner", ECHO))).toBe(1);
    const cardMsg = await waitFor(
      async () => mine().find((s) => cardOf(s)?.kind === "approval"),
      20_000,
      "approval card",
    );
    const approvalId = cardOf(cardMsg)?.id as string;
    im.push(
      connId,
      cardAction(
        "m1-ok",
        "u-owner",
        { cardKind: "approval", cardId: approvalId, action: "approve" },
        cardMsg.target,
      ),
    );
    await waitFor(
      async () => mine().some((s) => finalText(s).startsWith("Tool result:")),
      20_000,
      "reply after approval",
    );
    await waitFor(
      async () =>
        im.updated.some(
          (u) => u.messageId === cardMsg.messageId && cardOf(u)?.state === "approved",
        ),
      20_000,
      "card approved",
    );
    const convId = (
      await sql<{ conversation_id: string }>`SELECT conversation_id FROM capybara.channel_threads
        WHERE connection_id = ${connId}`.execute(raw)
    ).rows[0]?.conversation_id as string;

    // ---- 慢速流式回复：草稿发出、更新过一次后，杀掉负责投递的副本 ----
    const sentBefore = mine().length;
    expect(im.push(connId, dm("m2", "u-owner", `slow:150:${LONG}`))).toBe(1);
    const draft = await waitFor(async () => mine().slice(sentBefore)[0], 20_000, "draft message");
    await waitFor(
      async () => im.updated.some((u) => u.messageId === draft.messageId),
      20_000,
      "first draft update",
    );
    // 草稿 id 已先写进 PG
    const persisted = await db
      .selectFrom("channel_deliveries")
      .select("draft_message_id")
      .where("conversation_id", "=", convId)
      .executeTakeFirstOrThrow();
    expect(persisted.draft_message_id).toBe(draft.messageId);
    const victim = harness.replicas.find((r) => r.pid === draft.pid);
    const survivor = harness.replicas.find((r) => r.pid !== draft.pid);
    if (!victim || !survivor) throw new Error("cannot identify the delivering replica");
    await harness.kill(victim.index);

    // ---- 另一副本续投：同一条草稿被更新为完整文本，之后不再有新消息 ----
    const final = await waitFor(
      async () =>
        im.updated.find(
          (u) =>
            u.messageId === draft.messageId && u.message.text === LONG && u.pid === survivor.pid,
        ),
      40_000,
      "final text on the surviving replica",
    );
    expect(final).toBeDefined();
    await waitFor(
      async () => {
        const d = await db
          .selectFrom("channel_deliveries")
          .select(["last_seq", "draft_message_id"])
          .where("conversation_id", "=", convId)
          .executeTakeFirstOrThrow();
        const c = await db
          .selectFrom("conversations")
          .select("last_seq")
          .where("id", "=", convId)
          .executeTakeFirstOrThrow();
        return d.draft_message_id === null && d.last_seq === c.last_seq;
      },
      20_000,
      "delivery caught up",
    );
    await sleep(1500);
    // 整个会话：一张审批卡片、一条工具结果回复、一条流式回复（草稿）——没有任何重复
    const all = mine();
    expect(all.filter((s) => cardOf(s)?.kind === "approval")).toHaveLength(1);
    expect(all.filter((s) => finalText(s).startsWith("Tool result:"))).toHaveLength(1);
    expect(all.slice(sentBefore)).toHaveLength(1);
    expect(all).toHaveLength(sentBefore + 1);
    // 回复内容与日志里的定稿一致
    const finals = (await eventsOf(db, convId)).filter((e) => e.type === "assistant_message");
    const lastPayload = finals[finals.length - 1]?.payload as
      | { content: { type: string; text?: string }[] }
      | undefined;
    const lastText = (lastPayload?.content ?? []).map((b) => b.text ?? "").join("");
    expect(lastText).toBe(LONG);
  }, 180_000);

  it("T5a: the delivering worker dies after recording the card as pending; the other replica sends it exactly once and the row ends sent", async () => {
    // A platform that dedupes by idempotency key, like Lark's uuid: the survivor's resend reuses it
    const platform = await startFakeChannelServer();
    cleanups.push(() => platform.stop());
    const { harness, raw, connId } = await bootstrap(platform, "cli_t5a");
    const chat = "dm-u-owner";
    const cards = () =>
      platform.sent.filter(
        (s) => s.appId === "cli_t5a" && s.target.chatId === chat && cardOf(s)?.kind === "approval",
      );
    // The card reaches the platform, but the delivering replica never sees the response
    platform.delayNext("/send", 30_000, { onlyCards: true });
    expect(platform.push(connId, dm("t5a-1", "u-owner", ECHO))).toBe(1);
    const cardMsg = await waitFor(async () => cards()[0], 20_000, "approval card");
    const approvalId = cardOf(cardMsg)?.id as string;
    const row = async () =>
      (
        await sql<{ message_id: string | null; status: string }>`SELECT message_id, status
          FROM capybara.channel_card_messages
          WHERE connection_id = ${connId} AND card_kind = 'approval' AND card_id = ${approvalId}`.execute(
          raw,
        )
      ).rows[0];
    expect(await row()).toEqual({ message_id: null, status: "pending" });
    const victim = harness.replicas.find((r) => r.pid === cardMsg.pid);
    const survivor = harness.replicas.find((r) => r.pid !== cardMsg.pid);
    if (!victim || !survivor) throw new Error("cannot identify the delivering replica");
    await harness.kill(victim.index);

    // The survivor resends with the same idempotency key; the platform shows the card once
    const resend = await waitFor(
      async () => platform.duplicateSends.find((s) => s.pid === survivor.pid),
      40_000,
      "resend from the surviving replica",
    );
    expect(resend.idempotencyKey).toBe(cardMsg.idempotencyKey);
    await waitFor(async () => (await row())?.status === "sent", 20_000, "card row sent");
    expect(await row()).toEqual({ message_id: cardMsg.messageId, status: "sent" });
    await sleep(1000);
    expect(cards()).toHaveLength(1);
  }, 180_000);
});
