import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  type FakeChannelServer,
  fakeDm,
  fakeGroupMessage,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { conversationSourceOf } from "../../src/conversations/source.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask, TaskRun } from "../../src/schedules/types.js";
import { openBarrier, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Memory plugin spec §6.2: every conversation records its source when it is created. Channel
 * inbound takes the message's chat type, a scheduled chat task its chat's type (a group run's
 * conversation is `channel_group` before its first post binds the thread), sub-agent dispatch
 * `subagent`, and the rest (web, a new-conversation task) `web`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const CHAN_MINI = fixture("chan-mini");

/** Holds the group run's model request, so nothing is posted to the group while the test looks. */
const HOLD = "source-group-hold";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let miniId: string;
const store = new ScheduledTaskStore();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  im = await startFakeChannelServer({ dedupeSends: false });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, CHAN_MINI],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
      },
    ),
  );
  // the tests fire task runs themselves
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  const agent = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: builtinsOff("Agent"),
      },
      visibility: "org",
    },
  });
  expect(agent.statusCode, agent.body).toBe(201);
  agentId = (agent.json() as { agent: { id: string } }).agent.id;
  const enabled = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(enabled.statusCode, enabled.body).toBe(200);
  const conn = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "chan-mini",
      agentId,
      config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
    },
  });
  expect(conn.statusCode, conn.body).toBe(201);
  miniId = (conn.json() as { channel: { id: string } }).channel.id;
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES ('chan-mini:t1', 'u-owner', ${ownerId})`.execute(raw);
  await waitFor(async () => im.active(miniId).length === 1, 10_000, "long connection");
  scriptRules([
    {
      when: { lastUserIncludes: "group digest" },
      reply: { text: "ok", barrier: { name: HOLD, count: 99, timeoutMs: 60_000 } },
    },
    {
      when: { lastUserIncludes: "SCENARIO sub", assistantTurns: 0 },
      reply: {
        toolCalls: [{ name: "Agent", input: { description: "Look", prompt: "look around" } }],
      },
    },
  ]);
});

afterAll(async () => {
  openBarrier(HOLD);
  scriptRules([]);
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const sourceOf = (id: string) => conversationSourceOf(db, id);

/** The conversation a channel thread row points at. */
const threadConversation = (chatId: string, threadKey: string) =>
  waitFor(
    async () =>
      (
        await db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", miniId)
          .where("chat_id", "=", chatId)
          .where("thread_key", "=", threadKey)
          .where("archived_at", "is", null)
          .executeTakeFirst()
      )?.conversation_id,
    20_000,
    `thread ${threadKey}`,
  );

async function task(over: Partial<ScheduledTaskInsert>): Promise<ScheduledTask> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "digest please",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "UTC" },
    mode: "new",
    conversationId: null,
    chat: null,
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

/** Fires one run of `t` now and returns it as stored after the fire. */
async function fireNow(t: ScheduledTask): Promise<TaskRun> {
  const r = await store.insertRun(db, {
    id: randomUUID(),
    taskId: t.id,
    orgId,
    scheduledFor: new Date(),
    trial: false,
  });
  if (!r) throw new Error("tick taken");
  await k.app.get(ScheduledTaskFirer).fire(r.id);
  return (await store.updateRun(db, r.id, {})) ?? Promise.reject(new Error("no task run"));
}

describe("conversations.source (memory plugin spec §6.2)", () => {
  it("a conversation created on the web is web", async () => {
    expect(await sourceOf(await createConv(owner, orgId, agentId))).toBe("web");
  });

  it("an inbound DM's conversation is channel_dm", async () => {
    im.push(miniId, fakeDm("m-dm-1", "u-owner", "hello"));
    const conv = await threadConversation("dm-u-owner", "dm:u-owner");
    expect(await sourceOf(conv)).toBe("channel_dm");
  });

  it("an inbound group message's conversation is channel_group", async () => {
    im.push(miniId, fakeGroupMessage("m-grp-1", "u-owner", "hello all", { chatId: "grp-1" }));
    const conv = await threadConversation("grp-1", "m-grp-1");
    expect(await sourceOf(conv)).toBe("channel_group");
  });

  it("a group task's conversation is channel_group before its first post binds the thread", async () => {
    const t = await task({
      mode: "chat",
      prompt: "group digest",
      chat: { connectionId: miniId, chatId: "grp-1", chatType: "group" },
    });
    const sent = im.sent.length;
    const run = await fireNow(t);
    const conv = run.conversationId;
    expect(conv).toBeTruthy();
    // the run's model request is held: no post yet, so no thread to derive the source from
    const bound = await db
      .selectFrom("channel_threads")
      .select("id")
      .where("conversation_id", "=", conv as string)
      .execute();
    expect(bound).toEqual([]);
    // the run's first post would be a top-level message (the thread root); replies to the earlier
    // inbound group message go into that message's thread and may still arrive meanwhile
    const roots = im.sent
      .slice(sent)
      .filter((s) => s.target.chatId === "grp-1" && s.target.threadId === undefined);
    expect(roots).toEqual([]);
    expect(await sourceOf(conv as string)).toBe("channel_group");
    openBarrier(HOLD);
  });

  it("a DM task's new conversation is channel_dm", async () => {
    // the DM's live conversation is archived (as `/new` does), so the task binds a new one
    await db
      .updateTable("channel_threads")
      .set({ archived_at: new Date() })
      .where("connection_id", "=", miniId)
      .where("thread_key", "=", "dm:u-owner")
      .execute();
    const t = await task({
      mode: "chat",
      chat: { connectionId: miniId, chatId: "dm-u-owner", chatType: "dm" },
    });
    const run = await fireNow(t);
    const conv = await threadConversation("dm-u-owner", "dm:u-owner");
    expect(run.conversationId).toBe(conv);
    const row = await db
      .selectFrom("conversations")
      .select("scheduled_task_id")
      .where("id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(row.scheduled_task_id).toBe(t.id);
    expect(await sourceOf(conv)).toBe("channel_dm");
  });

  it("a new-conversation task's conversation is web", async () => {
    const run = await fireNow(await task({ mode: "new" }));
    expect(run.conversationId).toBeTruthy();
    expect(await sourceOf(run.conversationId as string)).toBe("web");
  });

  it("a dispatched sub-agent's conversation is subagent", async () => {
    const parent = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, parent, "SCENARIO sub");
    const child = await waitFor(
      async () =>
        (
          await db
            .selectFrom("conversations")
            .select("id")
            .where("parent_conversation_id", "=", parent)
            .executeTakeFirst()
        )?.id,
      20_000,
      "the sub-agent's conversation",
    );
    expect(await sourceOf(child)).toBe("subagent");
  });
});
