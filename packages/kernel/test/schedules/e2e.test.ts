import { fileURLToPath } from "node:url";
import {
  type FakeTelegramServer,
  startFakeTelegram,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
  telegramPrivateMessage,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { ScheduledTaskScanJob } from "../../src/schedules/scan.job.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import type { TaskRun } from "../../src/schedules/types.js";
import { scriptRules } from "../fixtures/plugins/model-script/index.js";
import { toolsCountState } from "../fixtures/plugins/tools-count/index.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  eventsOf,
  PW,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Scheduled tasks end to end (spec §6–§8, Task 13): tasks made over HTTP, fired by the scanner at
 * their tick (the cron scan itself is stopped so ticks are the test's), run on `model-script`. A
 * daily task posting into a Telegram DM (the `chan-tg` fixture on `startFakeTelegram`) and a reply
 * there continuing its conversation; a trial run whose approval becomes a task grant, used by the
 * next scheduled run without asking. Zero drift of a scheduled run: `evals/reconstruct.test.ts`.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const CHAN_TG = fixture("chan-tg");
const TOOLS_COUNT = fixture("tools-count");
const ASK = "plugin__tools-count__ask";

const ANSWER = "Your digest: all good";
const MORE = "More detail: still all good";
const COUNTED = "Counted and done";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let tg: FakeTelegramServer;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let tgId: string;
const store = new ScheduledTaskStore();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  tg = await startFakeTelegram();
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker", "gateway"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, CHAN_TG, TOOLS_COUNT],
        http: { port: 0, publicUrl: "https://cap.example" },
        auth: { cookieSecure: false },
        // one replica, no takeover: a lease long enough that a stalled event loop does not
        // lose it and drop the long connection (2 s did under load)
        channels: { scanIntervalMs: 100, leaseTtlMs: 10_000 },
      },
    ),
  );
  // the tests scan at the ticks they pick: the worker's once-a-minute scan would race them
  k.app.get(SchedulerRegistry).getCronJob(SCHED_SCAN_JOB).stop();
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Owner" })
  ).id;
  owner = await session(k, "owner");
  const org = await owner({ method: "POST", url: "/api/v1/orgs", payload: { name: "Acme" } });
  orgId = (org.json() as { org: { id: string } }).org.id;
  for (const plugin of ["chan-tg", "tools-count"]) {
    const en = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
      payload: { enabled: true },
    });
    expect(en.statusCode, en.body).toBe(200);
  }
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "tools-count", name: "ask" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
  const ch = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-tg",
      name: "Telegram",
      agentId,
      config: { apiUrl: tg.apiUrl, botToken: tg.bot.token },
    },
  });
  expect(ch.statusCode, ch.body).toBe(201);
  tgId = (ch.json() as { channel: { id: string } }).channel.id;
  // the owner's Telegram user on the connection's source (`chan-tg:<bot id>`)
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES (${`chan-tg:${tg.bot.id}`}, '777', ${ownerId})`.execute(raw);
  await waitFor(async () => tg.activePollers() >= 1, 10_000, "the bot polls");
  scriptRules([
    { when: { lastToolResultIncludes: "asked 7" }, reply: { text: COUNTED } },
    {
      when: { lastUserIncludes: "count please" },
      reply: { toolCalls: [{ name: ASK, input: { n: 7 } }] },
    },
    { when: { lastUserIncludes: "tell me more" }, reply: { text: MORE } },
    { when: { lastUserIncludes: "digest please" }, reply: { text: ANSWER } },
  ]);
}, 180_000);

afterAll(async () => {
  scriptRules([]);
  await k?.close();
  await tg?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const scanner = () => k.app.get(ScheduledTaskScanJob);

interface TaskView {
  id: string;
  nextRunAt: string | null;
  status: string;
}

async function createTask(payload: Record<string, unknown>): Promise<TaskView> {
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/schedules`,
    payload: {
      agentId,
      trigger: { kind: "cron", expr: "0 9 * * *" },
      timeZone: "UTC",
      ...payload,
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { task: TaskView }).task;
}

/** Scans at the task's next tick (as the worker would then) and returns the run it fired. */
async function scanTick(task: TaskView): Promise<TaskRun> {
  const at = new Date(task.nextRunAt as string);
  const before = new Set((await store.listRuns(db, task.id, 50)).map((r) => r.id));
  await scanner().scanAt(at);
  const fired = (await store.listRuns(db, task.id, 50)).filter((r) => !before.has(r.id));
  expect(fired).toHaveLength(1);
  // the tick is 09:00 UTC; next_run_at adds the task's jitter
  const tick = fired[0]?.scheduledFor as Date;
  expect([tick.getUTCHours(), tick.getUTCMinutes(), tick.getUTCSeconds()]).toEqual([9, 0, 0]);
  expect(tick.getTime()).toBeLessThanOrEqual(at.getTime());
  return fired[0] as TaskRun;
}

const runOf = async (id: string): Promise<TaskRun> =>
  (await store.updateRun(db, id, {})) ?? Promise.reject(new Error("no task run"));

const settled = (id: string) =>
  waitFor(
    async () => {
      const r = await runOf(id);
      return r.status !== "pending" && r.status !== "running" && r;
    },
    30_000,
    `task run ${id} settled`,
  );

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userTexts = async (conv: string): Promise<string[]> =>
  (await eventsOf(db, conv))
    .filter((e): e is UserMessage => e.type === "user_message")
    .map((m) => {
      const c = m.payload.content[0];
      return c?.type === "text" ? c.text : "";
    });

const approvalsOf = (conversationId: string) =>
  db
    .selectFrom("approvals")
    .select(["id", "status", "tool_key"])
    .where("conversation_id", "=", conversationId)
    .execute();

describe("scheduled tasks end to end", { timeout: 120_000 }, () => {
  it("a daily task to a Telegram DM posts its answer and a reply continues the same conversation", async () => {
    // the owner messages the bot once (a task can only target their own DM with it)
    tg.push(telegramPrivateMessage({ id: 777, first_name: "Owner" }, "hi bot"));
    const live = await waitFor(
      async () =>
        db
          .selectFrom("channel_threads")
          .select("conversation_id")
          .where("connection_id", "=", tgId)
          .where("thread_key", "=", "dm:777")
          .where("archived_at", "is", null)
          .executeTakeFirst(),
      20_000,
      "the DM thread",
    );
    await waitFor(
      async () => (await runsOf(db, live.conversation_id)).some((r) => r.status === "completed"),
      20_000,
      "the first message answered",
    );

    const task = await createTask({
      name: "Daily digest",
      prompt: "digest please",
      mode: "chat",
      chat: { connectionId: tgId, chatId: "777", chatType: "dm" },
    });
    expect(task.status).toBe("active");
    const run = await scanTick(task);
    const done = await settled(run.id);
    expect(done.status).toBe("completed");
    const conv = done.conversationId as string;

    // the answer reaches the DM, and the chat's live thread (the one the first message made) is
    // the run's conversation
    await waitFor(
      async () => tg.messages.some((m) => m.chatId === 777 && m.text.includes(ANSWER)),
      20_000,
      "the answer on Telegram",
    );
    const thread = await db
      .selectFrom("channel_threads")
      .select(["conversation_id", "account_id"])
      .where("connection_id", "=", tgId)
      .where("thread_key", "=", "dm:777")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(thread).toEqual({ conversation_id: conv, account_id: ownerId });

    // the owner replies in the DM: the same conversation goes on and its answer reaches the chat
    tg.push(telegramPrivateMessage({ id: 777, first_name: "Owner" }, "tell me more"));
    await waitFor(
      async () => (await userTexts(conv)).includes("tell me more"),
      20_000,
      "the reply in the run's conversation",
    );
    await waitFor(
      async () => tg.messages.some((m) => m.chatId === 777 && m.text.includes(MORE)),
      20_000,
      "the reply's answer on Telegram",
    );
    expect(conv).toBe(live.conversation_id);
    expect(await userTexts(conv)).toEqual(["hi bot", "digest please", "tell me more"]);
    await waitFor(
      async () => {
        const runs = await runsOf(db, conv);
        return runs.length === 3 && runs.every((r) => r.status === "completed");
      },
      20_000,
      "three runs completed",
    );

    // the next day's tick posts into the same chat conversation
    const next = await store.getTask(db, orgId, task.id);
    const run2 = await scanTick({ ...task, nextRunAt: next?.nextRunAt?.toISOString() ?? null });
    const done2 = await settled(run2.id);
    expect(done2).toMatchObject({ status: "completed", conversationId: conv });
  });

  it("a trial run collects a grant and the next scheduled run uses it without asking", async () => {
    const task = await createTask({ name: "Counter", prompt: "count please", mode: "new" });
    const asked = toolsCountState().ask;

    // the trial run asks the creator, who approves: the approval becomes the task's grant
    const trial = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/schedules/${task.id}/run`,
      payload: { trial: true },
    });
    expect(trial.statusCode, trial.body).toBe(202);
    const trialRun = (trial.json() as { run: TaskRun }).run;
    const trialConv = await waitFor(
      async () => (await runOf(trialRun.id)).conversationId,
      20_000,
      "the trial run's conversation",
    );
    const approval = await waitFor(
      async () => (await approvalsOf(trialConv)).find((a) => a.status === "pending"),
      20_000,
      "the trial run's approval",
    );
    expect(approval.tool_key).toBe(ASK);
    const decided = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(decided.statusCode, decided.body).toBe(200);
    expect(await settled(trialRun.id)).toMatchObject({ status: "completed", trial: true });
    expect(toolsCountState().ask).toBe(asked + 1);
    const grants = await owner({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/schedules/${task.id}/grants`,
    });
    expect(grants.statusCode, grants.body).toBe(200);
    expect((grants.json() as { items: { toolKey: string; stale: boolean }[] }).items).toEqual([
      expect.objectContaining({ toolKey: ASK, stale: false }),
    ]);
    // the trial run did not move the schedule
    const after = (await store.getTask(db, orgId, task.id))?.nextRunAt?.toISOString();
    expect(after).toBe(task.nextRunAt);

    // the scheduled run calls the tool without an approval
    const run = await scanTick(task);
    const done = await settled(run.id);
    expect(done).toMatchObject({ status: "completed", trial: false, missingGrants: [] });
    const conv = done.conversationId as string;
    expect(conv).not.toBe(trialConv);
    expect(await approvalsOf(conv)).toEqual([]);
    expect(toolsCountState().ask).toBe(asked + 2);
    const results = (await eventsOf(db, conv)).filter((e) => e.type === "tool_result");
    expect(JSON.stringify(results)).toContain("asked 7");
    const answers = (await eventsOf(db, conv)).filter((e) => e.type === "assistant_message");
    expect(JSON.stringify(answers.at(-1))).toContain(COUNTED);
  });
});
