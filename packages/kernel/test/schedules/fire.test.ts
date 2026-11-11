import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  fakeDm as dm,
  type FakeChannelServer,
  startFakeChannelServer,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { SchedulerRegistry } from "@nestjs/schedule";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { ConversationQueue } from "../../src/conversations/queue.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OrgSettingsService } from "../../src/orgs/settings.service.js";
import { ScheduledTaskFirer } from "../../src/schedules/fire.js";
import { SCHED_SCAN_JOB } from "../../src/schedules/job-ids.js";
import { ScheduledTaskScanJob } from "../../src/schedules/scan.job.js";
import { ScheduledTasksService } from "../../src/schedules/scheduled-tasks.service.js";
import { type ScheduledTaskInsert, ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduledTask, TaskRun } from "../../src/schedules/types.js";
import { openBarrier, scriptRules } from "../fixtures/plugins/model-script/index.js";
import { builtinsOff } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import {
  createConv,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Scheduled tasks spec §6, §8 (Task 6): the scanner inserts one task run per tick, the fire job
 * checks and starts it (a new conversation, the target conversation's queue, or the DM's current
 * conversation), and the run tracker follows the kernel run to its end.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const CHAN_MINI = fixture("chan-mini");
const SOURCE = "chan-mini:t1";

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let im: FakeChannelServer;
let owner: Req;
let ownerId: string;
let bobId: string;
let orgId: string;
let agentId: string;
let connId: string;
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
        channels: { scanIntervalMs: 100, leaseTtlMs: 2000 },
      },
    ),
  );
  // the tests own the scanner: the worker's once-a-minute scan would race their scanAt calls
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
  await sql`INSERT INTO capybara.identities (source, external_id, account_id)
    VALUES (${SOURCE}, 'u-owner', ${ownerId})`.execute(raw);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/chan-mini`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const ch = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/channels`,
    payload: {
      plugin: "chan-mini",
      name: "Bot",
      agentId,
      config: { platformUrl: im.url, appId: "cli_1", appSecret: "app-secret-1234567" },
    },
  });
  expect(ch.statusCode, ch.body).toBe(201);
  connId = (ch.json() as { channel: { id: string } }).channel.id;
  await waitFor(async () => im.active(connId).length === 1, 10_000, "long connection");
}, 180_000);

afterAll(async () => {
  await k?.close();
  await im?.stop();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

const FIVE_MIN = 5 * 60_000;
const firer = () => k.app.get(ScheduledTaskFirer);
const scanner = () => k.app.get(ScheduledTaskScanJob);
const svc = () => k.app.get(ScheduledTasksService);

/** A task stored directly (no interval check), every 5 minutes in UTC, not due until set so. */
async function task(over: Partial<ScheduledTaskInsert> = {}): Promise<ScheduledTask> {
  return store.insertTask(db, {
    id: randomUUID(),
    orgId,
    accountId: ownerId,
    agentId,
    name: "Digest",
    prompt: "hello",
    trigger: { kind: "cron", expr: "*/5 * * * *", timeZone: "UTC" },
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

/** A pending task run of `t` for `at` (default now), as the scanner or "run now" writes it. */
async function pendingRun(
  t: ScheduledTask,
  over: { scheduledFor?: Date; firedAt?: Date | null; conversationId?: string } = {},
): Promise<TaskRun> {
  const r = await store.insertRun(db, {
    id: randomUUID(),
    taskId: t.id,
    orgId,
    scheduledFor: over.scheduledFor ?? new Date(),
    trial: false,
    ...(over.firedAt !== undefined && { firedAt: over.firedAt }),
    ...(over.conversationId !== undefined && { conversationId: over.conversationId }),
  });
  if (!r) throw new Error("tick taken");
  return r;
}

async function runOf(id: string): Promise<TaskRun> {
  const r = await store.updateRun(db, id, {});
  if (!r) throw new Error("no task run");
  return r;
}

const settled = (id: string, timeoutMs = 15_000) =>
  waitFor(
    async () => {
      const r = await runOf(id);
      return r.status !== "pending" && r.status !== "running" && r;
    },
    timeoutMs,
    `task run ${id} settled`,
  );

const taskOf = async (id: string) =>
  (await store.getTask(db, orgId, id)) ?? Promise.reject(new Error("task gone"));

const conversationsOf = async (taskId: string) =>
  db
    .selectFrom("conversations")
    .select(["id", "create_request_id"])
    .where("scheduled_task_id", "=", taskId)
    .execute();

type UserMessage = Extract<ConversationEvent, { type: "user_message" }>;
const userMessages = async (conv: string): Promise<UserMessage[]> =>
  (await eventsOf(db, conv)).filter((e): e is UserMessage => e.type === "user_message");

const setSchedules = (patch: Record<string, unknown>) =>
  k.app.get(OrgSettingsService).update(orgId, { scheduledTasks: patch }, ownerId);

/** The latest 5-minute tick at or before `at`. */
const tickAt = (at: number) => new Date(Math.floor(at / FIVE_MIN) * FIVE_MIN);

/** The owner's live DM thread with the bot (an inbound message makes one when there is none). */
async function liveDmThread(messageId: string): Promise<string> {
  im.push(connId, dm(messageId, "u-owner", `hi ${messageId}`));
  const thread = await waitFor(
    async () =>
      db
        .selectFrom("channel_threads")
        .select("conversation_id")
        .where("connection_id", "=", connId)
        .where("thread_key", "=", "dm:u-owner")
        .where("archived_at", "is", null)
        .executeTakeFirst(),
    10_000,
    "dm thread",
  );
  const live = thread.conversation_id;
  const msg = await waitFor(
    async () =>
      (await userMessages(live)).find((m) => {
        const c = m.payload.content[0];
        return c?.type === "text" && c.text === `hi ${messageId}`;
      }),
    10_000,
    "inbound message",
  );
  // the run that answers it has ended (not just "no run yet"): a terminal event after it, and
  // nothing left running, so the task's message is the next run's trigger
  await waitFor(
    async () =>
      (await eventsOf(db, live)).some(
        (e) => e.seq > msg.seq && ["run_finished", "run_failed", "run_aborted"].includes(e.type),
      ) &&
      (await runsOf(db, live)).every((r) => ["completed", "failed", "aborted"].includes(r.status)),
    20_000,
    "the inbound message's run ended",
  );
  return live;
}

const dmTask = (name: string) =>
  svc().create(orgId, ownerId, {
    agentId,
    name,
    prompt: "dm tick",
    trigger: { kind: "cron", expr: "0 9 * * *" },
    mode: "chat",
    chat: { connectionId: connId, chatId: "dm-u-owner", chatType: "dm" },
  });

describe("scanning and firing", { timeout: 60_000 }, () => {
  it("new mode creates one conversation per tick", async () => {
    const t = await task();
    const tick1 = tickAt(Date.now());
    await store.updateTask(db, t.id, { nextRunAt: tick1 });
    await scanner().scanAt(new Date());
    const [r1] = await store.listRuns(db, t.id, 10);
    expect(r1?.scheduledFor.getTime()).toBe(tick1.getTime());
    const done1 = await settled(r1?.id as string);
    expect(done1).toMatchObject({ status: "completed" });
    expect((await taskOf(t.id)).nextRunAt?.getTime()).toBe(tick1.getTime() + FIVE_MIN);

    // the next tick, scanned as if five minutes later
    await scanner().scanAt(new Date(Date.now() + FIVE_MIN));
    const runs = await store.listRuns(db, t.id, 10);
    expect(runs).toHaveLength(2);
    const r2 = runs[0] as TaskRun;
    expect(r2.scheduledFor.getTime()).toBe(tick1.getTime() + FIVE_MIN);
    const done2 = await settled(r2.id);
    expect(done2).toMatchObject({ status: "completed" });

    const convs = await conversationsOf(t.id);
    expect(convs).toHaveLength(2);
    for (const done of [done1, done2]) {
      expect(done.firedAt).not.toBeNull();
      expect(done.conversationId).not.toBeNull();
      expect(convs.map((c) => c.id)).toContain(done.conversationId);
      const [msg] = await userMessages(done.conversationId as string);
      expect(msg?.payload.schedule).toMatchObject({ taskId: t.id, taskRunId: done.id });
      const runs = await db
        .selectFrom("runs")
        .select(["id", "scheduled_task_run_id"])
        .where("conversation_id", "=", done.conversationId as string)
        .execute();
      expect(runs).toEqual([{ id: done.runId, scheduled_task_run_id: done.id }]);
    }
  });

  it("a retried fire job does not create a second conversation", async () => {
    const t = await task();
    // the claim committed (fired_at set) but the job died before the conversation existed
    const r = await pendingRun(t, { firedAt: new Date() });
    await Promise.all([firer().fire(r.id), firer().fire(r.id)]);
    await firer().fire(r.id);
    const done = await settled(r.id);
    expect(done.status).toBe("completed");
    await firer().fire(r.id);
    const convs = await conversationsOf(t.id);
    expect(convs).toEqual([{ id: done.conversationId, create_request_id: r.id }]);
  });

  it("skips and pauses when the creator left the org", async () => {
    const t = await task({ accountId: bobId });
    await sql`DELETE FROM capybara.memberships WHERE org_id = ${orgId} AND account_id = ${bobId}`.execute(
      raw,
    );
    const r = await pendingRun(t);
    await firer().fire(r.id);
    expect(await runOf(r.id)).toMatchObject({
      status: "skipped",
      skipReason: "creator_inactive",
      firedAt: null,
    });
    expect(await taskOf(t.id)).toMatchObject({
      status: "paused",
      pauseReason: "creator_inactive",
      nextRunAt: null,
    });
    expect(await conversationsOf(t.id)).toEqual([]);
  });

  it("overlap skips while the previous run waits", async () => {
    scriptRules([
      {
        when: { lastUserIncludes: "HOLD-overlap" },
        reply: { text: "ok", barrier: { name: "ov", count: 99, timeoutMs: 30_000 } },
      },
    ]);
    const t = await task({ prompt: "HOLD-overlap" });
    const r1 = await pendingRun(t, { scheduledFor: new Date(Date.now() - FIVE_MIN) });
    await firer().fire(r1.id);
    await waitFor(async () => (await runOf(r1.id)).status === "running", 10_000, "run 1 running");
    const r2 = await pendingRun(t);
    await firer().fire(r2.id);
    expect(await runOf(r2.id)).toMatchObject({ status: "skipped", skipReason: "overlap" });
    expect((await taskOf(t.id)).status).toBe("active");
    openBarrier("ov");
    expect((await settled(r1.id)).status).toBe("completed");
    scriptRules([]);
  });

  it("rate limit skips without pausing", async () => {
    const t = await task();
    const other = await task();
    const hourAgo = () => new Date(Date.now() - 3600_000);
    const fired = await pendingRun(other, { scheduledFor: new Date(Date.now() - 2 * FIVE_MIN) });
    await store.updateRun(db, fired.id, { status: "completed", firedAt: new Date() });
    const n = await store.countFiredSince(db, orgId, hourAgo());
    expect(n).toBeGreaterThanOrEqual(1);
    // a skipped row does not count
    const skipped = await pendingRun(other, { scheduledFor: new Date(Date.now() - 3 * FIVE_MIN) });
    await store.updateRun(db, skipped.id, { status: "skipped", skipReason: "overlap" });
    expect(await store.countFiredSince(db, orgId, hourAgo())).toBe(n);
    await setSchedules({ maxRunsPerHour: n });
    try {
      const r = await pendingRun(t);
      await firer().fire(r.id);
      expect(await runOf(r.id)).toMatchObject({
        status: "skipped",
        skipReason: "rate_limited",
        firedAt: null,
      });
      expect((await taskOf(t.id)).status).toBe("active");
    } finally {
      await setSchedules({ maxRunsPerHour: 60 });
    }
  });

  it("tick waits behind a person's run (conversation mode)", async () => {
    scriptRules([
      {
        when: { lastUserIncludes: "HOLD-person" },
        reply: { text: "ok", barrier: { name: "person", count: 99, timeoutMs: 30_000 } },
      },
    ]);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "HOLD-person");
    await waitFor(async () => (await runsOf(db, conv)).some((r) => r.status === "running"));
    const t = await task({ mode: "conversation", conversationId: conv, prompt: "tick prompt" });
    const r = await pendingRun(t);
    await firer().fire(r.id);
    const queued = await db
      .selectFrom("conversation_queue")
      .select(["client_message_id", "schedule"])
      .where("conversation_id", "=", conv)
      .execute();
    expect(queued).toHaveLength(1);
    expect(queued[0]?.schedule).toMatchObject({ taskRunId: r.id });
    expect(await runOf(r.id)).toMatchObject({ status: "pending", conversationId: conv });
    expect((await runOf(r.id)).firedAt).not.toBeNull();
    // the person's run did not absorb it
    expect((await userMessages(conv)).filter((m) => m.payload.schedule)).toEqual([]);

    openBarrier("person");
    const done = await settled(r.id);
    expect(done.status).toBe("completed");
    const mine = (await userMessages(conv)).filter((m) => m.payload.schedule);
    expect(mine).toHaveLength(1);
    const run = await db
      .selectFrom("runs")
      .select(["trigger_seq", "scheduled_task_run_id"])
      .where("id", "=", done.runId as string)
      .executeTakeFirstOrThrow();
    expect(Number(run.trigger_seq)).toBe(mine[0]?.seq);
    expect(run.scheduled_task_run_id).toBe(r.id);
    // never this task's conversation
    expect(await conversationsOf(t.id)).toEqual([]);
    scriptRules([]);
  });

  it.each(["remove", "edit", "sendNow"] as const)(
    "a person's %s of the queued item marks the task run removed, and the next tick fires",
    async (action) => {
      const barrierName = `q-${action}`;
      scriptRules([
        {
          when: { lastUserIncludes: "HOLD-q" },
          reply: { text: "ok", barrier: { name: barrierName, count: 99, timeoutMs: 30_000 } },
        },
      ]);
      const conv = await createConv(owner, orgId, agentId);
      await postMessage(owner, orgId, conv, "HOLD-q");
      await waitFor(async () => (await runsOf(db, conv)).some((r) => r.status === "running"));
      const t = await task({ mode: "conversation", conversationId: conv, prompt: "tick" });
      const r1 = await pendingRun(t, { scheduledFor: new Date(Date.now() - FIVE_MIN) });
      await firer().fire(r1.id);
      const item = await db
        .selectFrom("conversation_queue")
        .select("id")
        .where("conversation_id", "=", conv)
        .executeTakeFirstOrThrow();
      const queue = k.app.get(ConversationQueue);
      if (action === "remove") await queue.remove(orgId, conv, ownerId, item.id);
      if (action === "edit") await queue.edit(orgId, conv, ownerId, item.id, "my own words");
      if (action === "sendNow") await queue.sendNow(orgId, conv, ownerId, item.id);
      expect(await runOf(r1.id)).toMatchObject({
        status: "skipped",
        skipReason: "removed",
        firedAt: null,
      });

      const r2 = await pendingRun(t);
      await firer().fire(r2.id);
      expect((await runOf(r2.id)).status).not.toBe("skipped");
      openBarrier(barrierName);
      expect((await settled(r2.id, 20_000)).status).toBe("completed");
      // the edited / sent message carried no marker: the task's run is r2's alone
      expect(
        (await userMessages(conv)).flatMap((m) =>
          m.payload.schedule ? [m.payload.schedule.taskRunId] : [],
        ),
      ).toEqual([r2.id]);
      scriptRules([]);
    },
  );

  it("a started run that left no trace is released after a grace period", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const t = await task({ mode: "conversation", conversationId: conv, prompt: "after ghost" });
    // queued an hour ago, its item since gone without the hook (e.g. the queue was cleared)
    const ghost = await pendingRun(t, {
      scheduledFor: new Date(Date.now() - 12 * FIVE_MIN),
      firedAt: new Date(Date.now() - 12 * FIVE_MIN),
      conversationId: conv,
    });
    const r = await pendingRun(t);
    await firer().fire(r.id);
    expect(await runOf(ghost.id)).toMatchObject({
      status: "skipped",
      skipReason: "removed",
      firedAt: null,
    });
    expect((await settled(r.id)).status).toBe("completed");
  });

  it("a task message a person's run absorbed settles it, and the next tick fires", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const t = await task({ mode: "conversation", conversationId: conv, prompt: "absorbed tick" });
    const r1 = await pendingRun(t, {
      scheduledFor: new Date(Date.now() - FIVE_MIN),
      firedAt: new Date(),
      conversationId: conv,
    });
    // its queued item was dispatched, then a person's run took the message in with theirs: the
    // message is consumed, and no run carries the task run
    const [msg] = await k.app.get(EventLog).append(conv, [
      {
        type: "user_message",
        payload: {
          content: [{ type: "text", text: "absorbed tick" }],
          authorAccountId: ownerId,
          schedule: {
            taskId: t.id,
            taskRunId: r1.id,
            scheduledFor: r1.scheduledFor.toISOString(),
            trial: false,
            taskName: t.name,
            localTime: "2026-11-11 09:00 (UTC)",
          },
        },
      },
    ]);
    await db
      .updateTable("conversations")
      .set({ consumed_seq: msg?.seq ?? 0 })
      .where("id", "=", conv)
      .execute();
    const r2 = await pendingRun(t);
    await firer().fire(r2.id);
    // its content was handled: completed, not in flight forever
    expect(await runOf(r1.id)).toMatchObject({ status: "completed", runId: null });
    expect((await runOf(r2.id)).status).not.toBe("skipped");
    expect((await settled(r2.id)).status).toBe("completed");
  });

  it("dm chat reuses the live thread", async () => {
    const live = await liveDmThread("m-live-1");
    const t = await dmTask("DM digest");
    const r = await pendingRun(t);
    await firer().fire(r.id);
    const done = await settled(r.id);
    expect(done).toMatchObject({ status: "completed", conversationId: live });
    expect((await userMessages(live)).filter((m) => m.payload.schedule)).toHaveLength(1);
    const conv = await db
      .selectFrom("conversations")
      .select("scheduled_task_id")
      .where("id", "=", live)
      .executeTakeFirstOrThrow();
    expect(conv.scheduled_task_id).toBeNull();
    expect(await conversationsOf(t.id)).toEqual([]);
  });

  it("dm chat after /new creates and binds a new conversation, and a later inbound reply lands in it", async () => {
    const beforeConv = await liveDmThread("m-new-0");
    const t = await dmTask("DM after new");
    im.push(connId, dm("m-new-1", "u-owner", "/new"));
    await waitFor(
      async () =>
        (await db
          .selectFrom("channel_threads")
          .select("id")
          .where("connection_id", "=", connId)
          .where("thread_key", "=", "dm:u-owner")
          .where("archived_at", "is", null)
          .executeTakeFirst()) === undefined,
      10_000,
      "thread archived",
    );
    const r = await pendingRun(t);
    await firer().fire(r.id);
    const done = await settled(r.id);
    expect(done.status).toBe("completed");
    const created = done.conversationId as string;
    expect(created).not.toBe(beforeConv);
    expect(await conversationsOf(t.id)).toEqual([{ id: created, create_request_id: null }]);
    const bound = await db
      .selectFrom("channel_threads")
      .select("conversation_id")
      .where("connection_id", "=", connId)
      .where("thread_key", "=", "dm:u-owner")
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();
    expect(bound.conversation_id).toBe(created);
    const delivery = await db
      .selectFrom("channel_deliveries")
      .select(["connection_id", "target"])
      .where("conversation_id", "=", created)
      .executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({
      connection_id: connId,
      target: { chatId: "dm-u-owner", chatType: "dm" },
    });

    im.push(connId, dm("m-reply-1", "u-owner", "thanks, more please"));
    await waitFor(
      async () =>
        (await userMessages(created)).some((m) => {
          const c = m.payload.content[0];
          return c?.type === "text" && c.text === "thanks, more please";
        }),
      10_000,
      "reply in the task's conversation",
    );
  });

  it("once task ends after its run", async () => {
    const at = new Date(Date.now() - 60_000);
    const t = await task({
      trigger: { kind: "once", at: at.toISOString().slice(0, 19), timeZone: "UTC" },
      nextRunAt: new Date(Math.floor(at.getTime() / 1000) * 1000),
    });
    await scanner().scanAt(new Date());
    expect(await taskOf(t.id)).toMatchObject({ status: "ended", nextRunAt: null });
    const [r] = await store.listRuns(db, t.id, 10);
    expect((await settled(r?.id as string)).status).toBe("completed");
    expect((await taskOf(t.id)).status).toBe("ended");
  });

  it("five failures pause the task", async () => {
    scriptRules([{ when: { lastUserIncludes: "FAILME" }, reply: { fail: "invalid_request" } }]);
    const t = await task({ prompt: "FAILME" });
    for (let i = 1; i <= 5; i++) {
      const r = await pendingRun(t, { scheduledFor: new Date(Date.now() - (10 - i) * FIVE_MIN) });
      await firer().fire(r.id);
      const done = await settled(r.id);
      expect(done.status).toBe("failed");
      expect(done.error).toBeTruthy();
      const now = await taskOf(t.id);
      expect(now.consecutiveFailures).toBe(i);
      expect(now.status).toBe(i < 5 ? "active" : "paused");
    }
    expect((await taskOf(t.id)).pauseReason).toBe("failures");
    scriptRules([]);
  });

  it("run now does not move next_run_at", async () => {
    const created = await svc().create(orgId, ownerId, {
      agentId,
      name: "Run now",
      prompt: "run now please",
      trigger: { kind: "cron", expr: "0 9 * * *" },
      mode: "new",
    });
    const run = await svc().runNow(orgId, ownerId, created.id, { trial: false });
    expect(run).toMatchObject({ status: "pending", trial: false });
    expect((await settled(run.id)).status).toBe("completed");
    expect((await taskOf(created.id)).nextRunAt?.getTime()).toBe(created.nextRunAt?.getTime());

    const trial = await svc().runNow(orgId, ownerId, created.id, { trial: true });
    expect(trial.trial).toBe(true);
    expect((await settled(trial.id)).status).toBe("completed");
    expect((await taskOf(created.id)).nextRunAt?.getTime()).toBe(created.nextRunAt?.getTime());
  });

  it("a run ending while the next tick's claim checks overlap settles without a deadlock", async () => {
    for (let i = 0; i < 4; i++) {
      const name = `race-${i}`;
      scriptRules([
        {
          when: { lastUserIncludes: `HOLD-${name}` },
          reply: { fail: "invalid_request", barrier: { name, count: 99, timeoutMs: 30_000 } },
        },
      ]);
      const t = await task({ prompt: `HOLD-${name}` });
      const r1 = await pendingRun(t, { scheduledFor: new Date(Date.now() - FIVE_MIN) });
      await firer().fire(r1.id);
      await waitFor(async () => (await runOf(r1.id)).status === "running", 10_000, "run 1");
      const r2 = await pendingRun(t);
      // the failing run's terminal write (task row → task run) races the claim's overlap check
      await Promise.all([
        (async () => {
          await new Promise((r) => setTimeout(r, i * 3));
          openBarrier(name);
        })(),
        firer().fire(r2.id),
        firer().fire(r2.id),
      ]);
      const done1 = await settled(r1.id);
      expect(done1.status).toBe("failed");
      const r2now = await runOf(r2.id);
      if (r2now.status === "skipped") expect(r2now.skipReason).toBe("overlap");
      else expect((await settled(r2.id)).status).toBe("failed");
    }
    scriptRules([]);
  });

  it("a task the scan cannot advance is paused and does not hold the others back", async () => {
    const bad = await task({ nextRunAt: new Date(Date.now() - 60_000) });
    // a stored trigger the schedule math cannot read
    await sql`UPDATE capybara.scheduled_tasks SET trigger = '{"what": 1}'::jsonb
      WHERE id = ${bad.id}`.execute(raw);
    const good = await task({ nextRunAt: tickAt(Date.now()) });
    await scanner().scanAt(new Date());
    expect(await taskOf(bad.id)).toMatchObject({
      status: "paused",
      pauseReason: "invalid_schedule",
      nextRunAt: null,
    });
    const [run] = await store.listRuns(db, good.id, 10);
    expect(run).toBeDefined();
    expect((await settled(run?.id as string)).status).toBe("completed");
  });

  it("a database error fails the scan pass and pauses nothing", async () => {
    const t = await task({ nextRunAt: tickAt(Date.now()) });
    // a simulated database failure while the scan writes the task's run
    await sql
      .raw(`CREATE OR REPLACE FUNCTION capybara.fail_sched_insert() RETURNS trigger AS $$
        BEGIN
          IF NEW.task_id = '${t.id}' THEN RAISE EXCEPTION 'simulated database error'; END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql;
        CREATE TRIGGER fail_sched_insert BEFORE INSERT ON capybara.scheduled_task_runs
          FOR EACH ROW EXECUTE FUNCTION capybara.fail_sched_insert();`)
      .execute(raw);
    try {
      await expect(scanner().scanAt(new Date())).rejects.toThrow(/simulated database error/);
      expect(await taskOf(t.id)).toMatchObject({ status: "active", pauseReason: null });
      expect(await store.listRuns(db, t.id, 10)).toEqual([]);
    } finally {
      await sql
        .raw(`DROP TRIGGER IF EXISTS fail_sched_insert ON capybara.scheduled_task_runs;
          DROP FUNCTION IF EXISTS capybara.fail_sched_insert();`)
        .execute(raw);
    }
    // the next pass fires it
    await scanner().scanAt(new Date());
    const [run] = await store.listRuns(db, t.id, 10);
    expect((await settled(run?.id as string)).status).toBe("completed");
  });

  it("a run of a deleted task is skipped with task_deleted", async () => {
    const t = await task();
    const r = await pendingRun(t);
    await store.softDelete(db, t.id);
    await firer().fire(r.id);
    expect(await runOf(r.id)).toMatchObject({
      status: "skipped",
      skipReason: "task_deleted",
      firedAt: null,
    });
  });

  it("the scan releases a run whose start failed for good (an ended once task)", async () => {
    const t = await task({ status: "ended", nextRunAt: null });
    const stuck = await pendingRun(t, {
      scheduledFor: new Date(Date.now() - 2 * 3600_000),
      firedAt: new Date(Date.now() - 2 * 3600_000),
    });
    await scanner().scanAt(new Date());
    expect(await runOf(stuck.id)).toMatchObject({
      status: "skipped",
      skipReason: "removed",
      firedAt: null,
    });
  });

  it("the repair rechecks the least recently checked stuck runs first, so a new one is reached", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const t = await task({ status: "ended", nextRunAt: null });
    const hours = (h: number) => new Date(Date.now() - h * 3600_000);
    // three started runs still in flight (their items wait in the queue), older than the new one
    const inFlight: TaskRun[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await pendingRun(t, {
        scheduledFor: hours(5 - i),
        firedAt: hours(5 - i),
        conversationId: conv,
      });
      inFlight.push(r);
      await db
        .insertInto("conversation_queue")
        .values({
          id: randomUUID(),
          conversation_id: conv,
          account_id: ownerId,
          position: i + 1,
          text: "queued",
          content: "[]",
          client_message_id: `rot-${r.id}`,
          schedule: JSON.stringify({ taskRunId: r.id, taskId: t.id }),
        })
        .execute();
    }
    // a run whose start failed for good, newer than the others
    const stuck = await pendingRun(t, { scheduledFor: hours(2), firedAt: hours(2) });
    try {
      // a batch of 2: the first pass takes the two oldest, the second the rest
      for (let pass = 0; pass < 2; pass++) await scanner().scanAt(new Date(), 2);
      expect(await runOf(stuck.id)).toMatchObject({ status: "skipped", skipReason: "removed" });
      for (const r of inFlight) expect((await runOf(r.id)).status).toBe("pending");
      const stamped = await db
        .selectFrom("scheduled_task_runs")
        .select("rechecked_at")
        .where(
          "id",
          "in",
          inFlight.map((r) => r.id),
        )
        .execute();
      expect(stamped.every((r) => r.rechecked_at !== null)).toBe(true);
    } finally {
      await db.deleteFrom("conversation_queue").where("conversation_id", "=", conv).execute();
      for (const r of inFlight) {
        await store.updateRun(db, r.id, {
          status: "skipped",
          skipReason: "removed",
          firedAt: null,
        });
      }
    }
  });
});
