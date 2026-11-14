import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { ConversationsService } from "../../src/conversations/conversations.service.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import { ConversationQueue } from "../../src/conversations/queue.service.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { buildModelRequest } from "../../src/runtime/context/build.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { ScheduledTaskStore } from "../../src/schedules/store.js";
import type { ScheduleMarker } from "../../src/schedules/types.js";
import { unattendedTaskRunOf } from "../../src/schedules/unattended.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForTerminal,
} from "../helpers/runs.js";
import { childRunsOf } from "../helpers/subagents.js";
import { AGENT, Log, MODEL } from "../runtime/context/fixtures.js";

/**
 * Scheduled tasks spec §4, §6, §12 (Task 4): the schedule marker a task's message carries, through
 * the queue, the run lineage (`runs.scheduled_task_run_id`), the zone override and the request
 * header rendered from the log.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const RULES: ScriptRule[] = [
  { when: { systemIncludes: CHILD }, reply: { text: "child done" } },
  {
    when: { lastUserIncludes: "SCENARIO dispatch", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "Agent", input: { description: "Quick", prompt: "child: go" } }] },
  },
  {
    when: { lastToolResultIncludes: "running in the background" },
    reply: { text: "parent went on" },
  },
];

const capture = captureProviderRequests();
const store = new ScheduledTaskStore();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;
let root: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-schedule-marker-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        sandbox: { background: { pollSeconds: 3600 } },
      },
    ),
  );
  ownerId = (
    await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "Wang Fang" })
  ).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Lead",
        instructions: "Lead the work.",
        model: { provider: "model-script", model: "script-1" },
        disabledTools: onlyBuiltins([{ kind: "builtin", name: "Agent" }]),
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterAll(async () => {
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

const HEADER = '[Scheduled task "Daily digest", run for 2026-11-11 09:00]';

/** A task and one of its runs in PG, and the marker its message carries. */
async function marker(trial = false): Promise<ScheduleMarker> {
  const taskId = randomUUID();
  await store.insertTask(db, {
    id: taskId,
    orgId,
    accountId: ownerId,
    agentId,
    name: "Daily digest",
    prompt: "Summarize.",
    trigger: { kind: "cron", expr: "0 9 * * *", timeZone: "Asia/Tokyo" },
    mode: "new",
    conversationId: null,
    chat: null,
    model: null,
    effort: null,
    deviceId: null,
    status: "active",
    nextRunAt: null,
    jitterSeconds: 0,
    expiresAt: null,
  });
  const run = await store.insertRun(db, {
    id: randomUUID(),
    taskId,
    orgId,
    scheduledFor: new Date(),
    trial,
  });
  if (!run) throw new Error("task run not inserted");
  return {
    taskId,
    taskRunId: run.id,
    scheduledFor: run.scheduledFor.toISOString(),
    trial,
    taskName: "Daily digest",
    localTime: "2026-11-11 09:00",
  };
}

/** Creates a conversation with a marked first message, as a `new`-mode fire does. */
async function fireNew(m: ScheduleMarker, text: string, timeZoneOverride = "Asia/Tokyo") {
  return k.app
    .get(ConversationsService)
    .createWithMessage(
      orgId,
      ownerId,
      agentId,
      { text, clientMessageId: m.taskRunId },
      {},
      { schedule: m, timeZoneOverride, source: "web" },
    );
}

type RunRow = { id: string; trigger_seq: string; scheduled_task_run_id: string | null };
const runRows = (conversationId: string): Promise<RunRow[]> =>
  db
    .selectFrom("runs")
    .select(["id", "trigger_seq", "scheduled_task_run_id"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at")
    .execute();

const runStarted = async (conversationId: string, runId: string) =>
  (await eventsOf(db, conversationId)).find(
    (e) => e.type === "run_started" && e.runId === runId,
  ) as Extract<ConversationEvent, { type: "run_started" }>;

/** A background task of run `runId` in `conv`, finished: its finish wakes the idle conversation. */
async function finishTaskOf(conv: string, runId: string): Promise<void> {
  const bg = k.app.get(BackgroundTaskStore);
  const id = newTaskId();
  const startedAt = new Date(Date.now() - 5_000);
  await bg.insert({
    id,
    orgId,
    conversationId: conv,
    sandboxConversationId: conv,
    deviceId: null,
    runId,
    callId: "call-x",
    triggerAccountId: ownerId,
    description: `Task ${id}`,
    command: "true",
    sid: "4242",
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + 3_600_000),
    sandboxCreatedAt: new Date(),
  });
  const task = await bg.get(id);
  if (!task) throw new Error("task row missing");
  expect(
    await k.app
      .get(BackgroundTaskFinisher)
      .finish(task, { status: "completed", exitCode: 0 }, "out\n", false),
  ).toBe(true);
}

describe("the schedule marker", () => {
  it("a marked first message sets runs.scheduled_task_run_id", async () => {
    const m = await marker(true);
    const { conversation, event } = await fireNew(m, "digest please");
    expect((event.payload as EventPayload<"user_message">).schedule).toEqual(m);
    await waitForTerminal(db, conversation.id, 1, 30_000);
    const [run] = await runRows(conversation.id);
    expect(run?.scheduled_task_run_id).toBe(m.taskRunId);
    expect(await unattendedTaskRunOf(db, run?.id as string)).toEqual({
      taskRunId: m.taskRunId,
      taskId: m.taskId,
      trial: true,
    });
    expect((await runStarted(conversation.id, run?.id as string)).payload.trigger).toBe("schedule");
    const conv = await db
      .selectFrom("conversations")
      .select("scheduled_task_id")
      .where("id", "=", conversation.id)
      .executeTakeFirstOrThrow();
    expect(conv.scheduled_task_id).toBe(m.taskId);
  });

  it("a person's message in the same conversation starts a run without it", async () => {
    const m = await marker();
    const { conversation } = await fireNew(m, "digest please");
    await waitForTerminal(db, conversation.id, 1, 30_000);
    await postMessage(owner, orgId, conversation.id, "and now me");
    await waitForTerminal(db, conversation.id, 2, 30_000);
    const [, second] = await runRows(conversation.id);
    expect(second?.scheduled_task_run_id).toBeNull();
    expect(await unattendedTaskRunOf(db, second?.id as string)).toBeNull();
    expect((await runStarted(conversation.id, second?.id as string)).payload.trigger).toBe(
      undefined,
    );
  });

  it("a sub-agent run inherits it", async () => {
    const m = await marker();
    const { conversation } = await fireNew(m, "SCENARIO dispatch");
    const child = await waitFor(
      async () => (await childRunsOf(db, conversation.id))[0],
      20_000,
      "child dispatched",
    );
    const row = await db
      .selectFrom("runs")
      .select("scheduled_task_run_id")
      .where("id", "=", child.runId)
      .executeTakeFirstOrThrow();
    expect(row.scheduled_task_run_id).toBe(m.taskRunId);
    // the child's delivery wakes the parent: that wake run descends from the unattended run too
    const runs = await waitFor(
      async () => {
        const r = await runRows(conversation.id);
        return r.length >= 2 ? r : null;
      },
      30_000,
      "parent woken by the delivery",
    );
    expect(runs[1]?.scheduled_task_run_id).toBe(m.taskRunId);
    await waitForTerminal(db, conversation.id, 2, 30_000);
  });

  it("a background-task wake of an unattended run inherits it", async () => {
    const m = await marker();
    const { conversation } = await fireNew(m, "digest please");
    await waitForTerminal(db, conversation.id, 1, 30_000);
    const [first] = await runRows(conversation.id);
    await finishTaskOf(conversation.id, first?.id as string);
    await waitForTerminal(db, conversation.id, 2, 30_000);
    const [, wake] = await runRows(conversation.id);
    expect(wake?.scheduled_task_run_id).toBe(m.taskRunId);
    expect((await runStarted(conversation.id, wake?.id as string)).payload.trigger).toBe(
      "background_task",
    );
  });

  it("a wake whose event came from an attended run does not", async () => {
    const m = await marker();
    const { conversation } = await fireNew(m, "digest please");
    await waitForTerminal(db, conversation.id, 1, 30_000);
    await postMessage(owner, orgId, conversation.id, "a person's turn");
    await waitForTerminal(db, conversation.id, 2, 30_000);
    const [, attended] = await runRows(conversation.id);
    await finishTaskOf(conversation.id, attended?.id as string);
    await waitForTerminal(db, conversation.id, 3, 30_000);
    const [, , wake] = await runRows(conversation.id);
    expect(wake?.scheduled_task_run_id).toBeNull();
  });

  it("timeZoneOverride beats the account setting and lands in run_context", async () => {
    await db
      .updateTable("accounts")
      .set({ time_zone: "Europe/Berlin" })
      .where("id", "=", ownerId)
      .execute();
    try {
      const m = await marker();
      const { conversation, event } = await fireNew(m, "digest please", "Asia/Tokyo");
      expect((event.payload as EventPayload<"user_message">).timeZone).toBe("Asia/Tokyo");
      await waitForTerminal(db, conversation.id, 1, 30_000);
      const ctx = (await eventsOf(db, conversation.id)).find((e) => e.type === "run_context");
      expect((ctx?.payload as EventPayload<"run_context"> | undefined)?.timeZone).toBe(
        "Asia/Tokyo",
      );
      // a person's message keeps following the account setting
      await postMessage(owner, orgId, conversation.id, "me again");
      const mine = (await eventsOf(db, conversation.id)).findLast((e) => e.type === "user_message");
      expect((mine?.payload as EventPayload<"user_message"> | undefined)?.timeZone).toBe(
        "Europe/Berlin",
      );
      await waitForTerminal(db, conversation.id, 2, 30_000);
    } finally {
      await db.updateTable("accounts").set({ time_zone: null }).where("id", "=", ownerId).execute();
    }
  });

  it("a queued marked item dispatches with its marker", async () => {
    const conv = await createConv(owner, orgId, agentId);
    const m = await marker();
    const out = await k.app
      .get(ConversationQueue)
      .add(
        orgId,
        conv,
        ownerId,
        { text: "queued digest", clientMessageId: `sched-${m.taskRunId}` },
        { schedule: m, timeZoneOverride: "Asia/Tokyo" },
      );
    expect(out.created).toBe(true);
    await waitForTerminal(db, conv, 1, 30_000);
    const msg = (await eventsOf(db, conv)).find((e) => e.type === "user_message");
    expect(msg?.payload).toMatchObject({ schedule: m, timeZone: "Asia/Tokyo" });
    // the zone does not leak into the logged marker
    expect((msg?.payload as EventPayload<"user_message"> | undefined)?.schedule).toEqual(m);
    const [run] = await runRows(conv);
    expect(run?.scheduled_task_run_id).toBe(m.taskRunId);
    const left = await db
      .selectFrom("conversation_queue")
      .select("id")
      .where("conversation_id", "=", conv)
      .execute();
    expect(left).toEqual([]);
  });

  /** A conversation whose queue is paused, holding one queued item with a marker. */
  async function pausedWithMarkedItem() {
    const conv = await createConv(owner, orgId, agentId);
    await db
      .updateTable("conversations")
      .set({ queue_paused: true, queue_pause_reason: "run_ended" })
      .where("id", "=", conv)
      .execute();
    const m = await marker();
    const out = await k.app
      .get(ConversationQueue)
      .add(
        orgId,
        conv,
        ownerId,
        { text: "queued digest", clientMessageId: `sched-${m.taskRunId}` },
        { schedule: m, timeZoneOverride: "Asia/Tokyo" },
      );
    expect(out.item).not.toBeNull();
    return { conv, m, itemId: out.item?.id as string };
  }

  it("editing a queued scheduled item makes it the person's message", async () => {
    const { conv, itemId } = await pausedWithMarkedItem();
    await k.app.get(ConversationQueue).edit(orgId, conv, ownerId, itemId, "my own words");
    const row = await db
      .selectFrom("conversation_queue")
      .select("schedule")
      .where("id", "=", itemId)
      .executeTakeFirstOrThrow();
    expect(row.schedule).toBeNull();
    await k.app.get(ConversationQueue).resume(orgId, conv, ownerId);
    await waitForTerminal(db, conv, 1, 30_000);
    const msg = (await eventsOf(db, conv)).find((e) => e.type === "user_message");
    expect(msg?.payload).not.toHaveProperty("schedule");
    const [run] = await runRows(conv);
    expect(run?.scheduled_task_run_id).toBeNull();
  });

  it("sending a queued scheduled item now makes it the person's message", async () => {
    const { conv, itemId } = await pausedWithMarkedItem();
    const event = await k.app.get(ConversationQueue).sendNow(orgId, conv, ownerId, itemId);
    expect(event.payload).not.toHaveProperty("schedule");
    await waitForTerminal(db, conv, 1, 30_000);
    const [run] = await runRows(conv);
    expect(run?.scheduled_task_run_id).toBeNull();
  });

  it("the header renders from the log only", async () => {
    capture.reset();
    const m = await marker();
    const { conversation } = await fireNew(m, "MARK-header digest");
    await waitForTerminal(db, conversation.id, 1, 30_000);
    const sent = capture.sent.filter((r) => JSON.stringify(r.messages).includes("MARK-header"));
    expect(sent).toHaveLength(1);
    const user = (sent[0] as ModelRequest).messages.findLast((x) => x.role === "user");
    expect(JSON.stringify(user?.content)).toContain(JSON.stringify(HEADER));
    // the task is renamed after the run: the rebuilt request is unchanged
    await store.updateTask(db, m.taskId, { name: "Renamed" });
    const [run] = await runRows(conversation.id);
    const snap = await takeSnapshot(db, orgId, conversation.id, run?.id as string, 4_194_304);
    const calls = toEvents(snap).filter(
      (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
    );
    expect(calls).toHaveLength(1);
    const c = calls[0] as Extract<ConversationEvent, { type: "model_call" }>;
    const info = (
      await k.app
        .get(ProviderRegistry)
        .resolve(snap.orgId, { provider: c.payload.provider, model: c.payload.model })
    ).info;
    const out = reconstructRequest(snap, c.seq, { model: info });
    expect(out.drift).toEqual([]);
    expect(out.request).toEqual(sent[0]);
  });
});

describe("the header in request building", () => {
  it("renders as its own text block before the message's content; unmarked messages unchanged", () => {
    const log = new Log();
    const q = log.user("digest please");
    const plain = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
    });
    (q.payload as EventPayload<"user_message">).schedule = {
      taskId: "t1",
      taskRunId: "tr1",
      scheduledFor: "2026-11-11T00:00:00.000Z",
      trial: false,
      taskName: 'Daily\n"digest"',
      localTime: "2026-11-11 09:00",
    };
    const marked = buildModelRequest({
      events: log.events,
      agent: AGENT,
      agentVersion: 1,
      model: MODEL,
      step: 1,
    });
    const last = (r: typeof plain) => r.request.messages.findLast((x) => x.role === "user");
    expect(last(marked)?.content).toEqual([
      { type: "text", text: '[Scheduled task "Daily \\"digest\\"", run for 2026-11-11 09:00]' },
      ...((last(plain)?.content as unknown[]) ?? []),
    ]);
  });
});
