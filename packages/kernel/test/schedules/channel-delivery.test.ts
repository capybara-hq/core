import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  type FakeTelegramServer,
  fakeGroupMessage,
  startFakeChannelServer,
  startFakeTelegram,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask, TaskRun } from "../../src/schedules/types.js";
import { scriptRules } from "../fixtures/plugins/model-script/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  eventsOf,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Scheduled tasks spec §8 (Task 8): a run's answer reaches the chat (a DM on a fake Telegram), a
 * group run starts its own thread at its first post and a reply in that thread continues it, and
 * a delivery failing with `target_gone` / `auth` pauses the task of the run being delivered.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const CHAN_MINI = fixture("chan-mini");
const CHAN_PLAIN = fixture("chan-plain");
const CHAN_TG = fixture("chan-tg");

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let im: FakeChannelServer;
let tg: FakeTelegramServer;
let owner: Req;
let ownerId: string;
let bobId: string;
let orgId: string;
let agentId: string;
/** chan-mini (threads), chan-plain (no threads), chan-tg (Telegram) connections. */
let miniId: string;
let plainId: string;
let tgId: string;
const store = new ScheduledTaskStore();

const ANSWER = "Your digest: all good";

async function enable(plugin: string): Promise<void> {
  const res = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true },
  });
  expect(res.statusCode, res.body).toBe(200);
}

async function connection(plugin: string, config: Record<string, unknown>): Promise<string> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: { plugin, name: plugin, agentId, config },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { channel: { id: string } }).channel.id;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  [im, tg] = await Promise.all([
    startFakeChannelServer({ dedupeSends: false }),
    startFakeTelegram(),
  ]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, CHAN_MINI, CHAN_PLAIN, CHAN_TG],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000 },
      },
    ),
  );
  // the tests fire task runs themselves
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" })).id;
  bobId = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
  owner = await session(k, "owner");
  const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: builtinsOff(),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  for (const p of ["chan-mini", "chan-plain", "chan-tg"]) await enable(p);
  miniId = await connection("chan-mini", {
    platformUrl: im.url,
    appId: "cli_1",
    appSecret: "app-secret-1234567",
  });
  plainId = await connection("chan-plain", {
    platformUrl: im.url,
    appId: "cli_plain",
    appSecret: "app-secret-1234567",
  });
  tgId = await connection("chan-tg", { apiUrl: tg.apiUrl, botToken: tg.bot.token });
  // identities on the connections' sources (`<plugin>:<tenant>`)
  await sql`INSERT INTO capybara.identities (source, external_id, account_id) VALUES
    ('chan-mini:t1', 'u-owner', ${ownerId}),
    ('chan-mini:t1', 'u-bob', ${bobId}),
    (${`chan-tg:${tg.bot.id}`}, '777', ${ownerId}),
    (${`chan-tg:${tg.bot.id}`}, '888', ${bobId})`.execute(raw);
  await waitFor(async () => im.active(miniId).length === 1, 10_000, "long connection");
  scriptRules([{ when: { lastUserIncludes: "digest please" }, reply: { text: ANSWER } }]);
}, 180_000);

afterAll(async () => {
  scriptRules([]);
  await k?.close();
  await im?.stop();
  await tg?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const firer = () => k.app.get(ScheduledTaskFirer);

/** A chat task stored directly, never due by itself. */
async function chatTask(
  chat: NonNullable<ScheduledTaskInsert["chat"]>,
  over: Partial<ScheduledTaskInsert> = {},
): Promise<ScheduledTask> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "digest please",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
    mode: "chat",
    conversationId: null,
    chat,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: new Date(Date.now() + 86_400_000),
    jitterSeconds: 0,
    expiresAt: null,
    ...over,
  });
}

async function fireNow(t: ScheduledTask): Promise<TaskRun> {
  const r = await store.insertRun(db, {
    id: randomUUID(),
    taskId: t.id,
    orgId,
    scheduledFor: new Date(),
    trial: false,
  });
  if (!r) throw new Error("tick taken");
  await firer().fire(r.id);
  return r;
}

const runOf = async (id: string): Promise<TaskRun> =>
  (await store.updateRun(db, id, {})) ?? Promise.reject(new Error("no task run"));

const settled = (id: string) =>
  waitFor(
    async () => {
      const r = await runOf(id);
      return r.status !== "pending" && r.status !== "running" && r;
    },
    20_000,
    `task run ${id} settled`,
  );

const taskOf = async (id: string) =>
  (await store.getTask(db, orgId, id)) ?? Promise.reject(new Error("task gone"));

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userTexts = async (conv: string): Promise<string[]> =>
  (await eventsOf(db, conv))
    .filter((e): e is UserMessage => e.type === "user_message")
    .map((m) => {
      const c = m.payload.content[0];
      return c?.type === "text" ? c.text : "";
    });

/** The owner's thread rows in a group (one per top-level message they sent there). */
async function ownerGroupThread(chatId: string, messageId: string): Promise<void> {
  im.push(miniId, fakeGroupMessage(messageId, "u-owner", `hello ${messageId}`, { chatId }));
  await waitFor(
    async () =>
      db
        .selectFrom("channel_threads")
        .select("id")
        .where("connection_id", "=", miniId)
        .where("chat_id", "=", chatId)
        .where("thread_key", "=", messageId)
        .executeTakeFirst(),
    10_000,
    "group thread row",
  );
}

/** The thread a conversation is bound to (its key = the root message's id). */
const threadOf = (conversationId: string) =>
  waitFor(
    async () =>
      db
        .selectFrom("channel_threads")
        .select(["thread_key", "chat_id", "account_id", "connection_id"])
        .where("conversation_id", "=", conversationId)
        .where("archived_at", "is", null)
        .executeTakeFirst(),
    20_000,
    "the run's thread is bound",
  );

describe("scheduled task channel delivery (spec §8)", { timeout: 90_000 }, () => {
  it("dm delivery posts the run's answer to the fake Telegram chat", async () => {
    const t = await chatTask({ connectionId: tgId, chatId: "777", chatType: "dm" });
    const r = await fireNow(t);
    expect((await settled(r.id)).status).toBe("completed");
    const posted = await waitFor(
      async () => tg.messages.find((m) => m.chatId === 777 && m.text.includes(ANSWER)),
      20_000,
      "the answer on Telegram",
    );
    expect(posted.messageThreadId).toBeUndefined();
    expect((await taskOf(t.id)).status).toBe("active");
  });

  it("target_gone pauses the task with target_gone", async () => {
    tg.failNext("sendMessage", {
      status: 403,
      description: "Forbidden: bot was blocked by the user",
    });
    const t = await chatTask(
      { connectionId: tgId, chatId: "888", chatType: "dm" },
      { accountId: bobId },
    );
    const r = await fireNow(t);
    expect((await settled(r.id)).status).toBe("completed");
    const paused = await waitFor(
      async () => {
        const task = await taskOf(t.id);
        return task.status === "paused" && task;
      },
      20_000,
      "task paused",
    );
    expect(paused).toMatchObject({ pauseReason: "target_gone", nextRunAt: null });
    expect(tg.calls.some((c) => c.method === "sendMessage" && c.params.chat_id === 888)).toBe(true);
  });

  it("an auth failure while delivering pauses the task with target_gone", async () => {
    im.failNext("/send", 401, 1, undefined, "auth", undefined, "dm-u-bob");
    const t = await chatTask(
      { connectionId: miniId, chatId: "dm-u-bob", chatType: "dm" },
      { accountId: bobId },
    );
    const r = await fireNow(t);
    expect((await settled(r.id)).status).toBe("completed");
    const paused = await waitFor(
      async () => {
        const task = await taskOf(t.id);
        return task.status === "paused" && task;
      },
      20_000,
      "task paused",
    );
    expect(paused.pauseReason).toBe("target_gone");
  });

  it("group run binds the thread at its first post and a reply in that thread continues it", async () => {
    await ownerGroupThread("grp-1", "g-hello");
    const t = await chatTask({ connectionId: miniId, chatId: "grp-1", chatType: "group" });
    const r = await fireNow(t);
    const done = await settled(r.id);
    expect(done.status).toBe("completed");
    const conv = done.conversationId as string;
    expect(conv).toBeTruthy();
    const scheduled = await db
      .selectFrom("conversations")
      .select("scheduled_task_id")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(scheduled.scheduled_task_id).toBe(t.id);

    // the run's first post is the thread root: a top-level message, its id the thread key
    const thread = await threadOf(conv);
    expect(thread).toMatchObject({ connection_id: miniId, chat_id: "grp-1", account_id: ownerId });
    const root = im.sent.find((s) => s.messageId === thread.thread_key);
    expect(root?.target).toEqual({ chatId: "grp-1", chatType: "group" });
    const delivery = await db
      .selectFrom("channel_deliveries")
      .select(["target", "pending_thread_account_id"])
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(delivery).toEqual({
      target: { chatId: "grp-1", chatType: "group", threadId: thread.thread_key },
      pending_thread_account_id: null,
    });
    await waitFor(
      async () => im.sent.some((s) => s.target.chatId === "grp-1" && im.finalText(s) === ANSWER),
      20_000,
      "the answer in the group",
    );

    // a reply in that thread continues the run's conversation, and its answer stays in the thread
    const before = im.sent.length;
    im.push(
      miniId,
      fakeGroupMessage("g-reply", "u-owner", "digest please, more detail", {
        chatId: "grp-1",
        threadId: thread.thread_key,
      }),
    );
    await waitFor(
      async () => (await userTexts(conv)).includes("digest please, more detail"),
      20_000,
      "the reply in the run's conversation",
    );
    await waitFor(
      async () => im.sent.slice(before).some((s) => s.target.threadId === thread.thread_key),
      20_000,
      "the reply's answer in the thread",
    );

    // the next run starts its own conversation and thread
    const r2 = await fireNow(t);
    const done2 = await settled(r2.id);
    expect(done2.status).toBe("completed");
    expect(done2.conversationId).not.toBe(conv);
    const thread2 = await threadOf(done2.conversationId as string);
    expect(thread2.thread_key).not.toBe(thread.thread_key);
  });

  it("a group target on a channel without threads is skipped with unsupported_target", async () => {
    const t = await chatTask({ connectionId: plainId, chatId: "grp-1", chatType: "group" });
    const r = await fireNow(t);
    expect(await runOf(r.id)).toMatchObject({
      status: "skipped",
      skipReason: "unsupported_target",
      firedAt: null,
    });
    expect((await taskOf(t.id)).status).toBe("active");
  });

  it("a group the creator never wrote in is skipped and pauses the task (target_gone)", async () => {
    const t = await chatTask({ connectionId: miniId, chatId: "grp-other", chatType: "group" });
    const r = await fireNow(t);
    expect(await runOf(r.id)).toMatchObject({ status: "skipped", skipReason: "target_gone" });
    expect(await taskOf(t.id)).toMatchObject({ status: "paused", pauseReason: "target_gone" });
  });
});
