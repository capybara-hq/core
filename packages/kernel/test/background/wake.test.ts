import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { BackgroundTaskFinisher } from "../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../src/background/launch.js";
import { renderBackgroundFinished } from "../../src/background/render.js";
import { BackgroundTaskStopper } from "../../src/background/stop.js";
import { BackgroundTaskStore } from "../../src/background/store.js";
import { bgWakeJobId, WAKE_WINDOW_MS } from "../../src/background/wake-rules.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { reconstructRequest } from "../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../src/evals/snapshot.js";
import { KernelConfigService } from "../../src/infra/config/kernel-config.service.js";
import { MAINTENANCE_QUEUE_NAME } from "../../src/runtime/maintenance-queue.js";
import { ProviderRegistry } from "../../src/runtime/providers.js";
import { RunQueue } from "../../src/runtime/run-queue.js";
import type { ScriptRule } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { captureProviderRequests } from "../helpers/provider-capture.js";
import {
  consumedSeq,
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

/**
 * A finished background task reaches the model and wakes an idle conversation (spec
 * 2026-11-05-background-bash-design §2.4, §3). One kernel with model-script; tasks are rows
 * finished with `BackgroundTaskFinisher` directly (no sandbox: the poll runs hourly here), as the
 * poller, `TaskOutput` and `TaskStop` do. Barriers hold a model call while a test finishes a task.
 */

const MODEL_SCRIPT = fileURLToPath(
  new URL("../fixtures/plugins/model-script/index.ts", import.meta.url),
);
const TOOLS_COUNT = fileURLToPath(
  new URL("../fixtures/plugins/tools-count/index.ts", import.meta.url),
);
const SANDBOX_FAKE = fileURLToPath(
  new URL("../fixtures/plugins/sandbox-fake/index.ts", import.meta.url),
);
const COUNT = "plugin__tools-count__count";
const ASK = "plugin__tools-count__ask";

const held = (name: string) => ({ name, count: 99, timeoutMs: 60_000 });
const RULES: ScriptRule[] = [
  // step 1 calls a tool; its model call is held while the test finishes a task
  {
    when: { lastUserIncludes: "SCENARIO mid", assistantTurns: 0 },
    reply: { toolCalls: [{ name: COUNT, input: { n: 1 } }], barrier: held("mid") },
  },
  // the run's only (last) model call is held
  {
    when: { lastUserIncludes: "SCENARIO last", assistantTurns: 0 },
    reply: { text: "held", barrier: held("last") },
  },
  // a tool that needs approval: the run waits
  {
    when: { lastUserIncludes: "SCENARIO wait", assistantTurns: 0 },
    reply: { toolCalls: [{ name: ASK, input: { n: 2 } }] },
  },
  // the wake run's first model call is held while a second task finishes
  {
    when: { lastUserIncludes: "SCENARIO two", assistantTurns: 1 },
    reply: { toolCalls: [{ name: COUNT, input: { n: 3 } }], barrier: held("two") },
  },
];

type Barriers = Map<string, { arrived: number; waiters: (() => void)[] }>;
const barriers = (): Barriers | undefined =>
  (globalThis as { __modelScript?: { barriers: Barriers } }).__modelScript?.barriers;
/** Waits until a model call is held at barrier `name`. */
const arrived = (name: string) =>
  waitFor(async () => (barriers()?.get(name)?.arrived ?? 0) >= 1, 15_000, `barrier ${name}`);
const release = (name: string) => {
  for (const w of barriers()?.get(name)?.waiters.splice(0) ?? []) w();
};

const capture = captureProviderRequests();

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;
let owner: Req;
let ownerId: string;
let bobId: string;
let orgId: string;
let agentId: string;
let store: BackgroundTaskStore;
let finisher: BackgroundTaskFinisher;
let runs: RunQueue;
let root: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-bg-wake-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, TOOLS_COUNT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
        sandbox: { background: { pollSeconds: 3600 } },
      },
    ),
  );
  store = k.app.get(BackgroundTaskStore);
  finisher = k.app.get(BackgroundTaskFinisher);
  runs = k.app.get(RunQueue);
  const accounts = accountsFor(db);
  ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" })).id;
  bobId = (await accounts.createLocal({ login: "bob", password: PW, displayName: "B" })).id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, bobId, "member", ownerId);
  const en = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/tools-count`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const res = await owner({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Waker",
        instructions: "Work in the background.",
        model: { provider: "model-script", model: "script-1" },
        tools: [
          { kind: "plugin", plugin: "tools-count", name: "count" },
          { kind: "plugin", plugin: "tools-count", name: "ask" },
        ],
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  for (const name of barriers()?.keys() ?? []) release(name);
  capture.restore();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

type Finished = Extract<ConversationEvent, { type: "background_task_finished" }>;

/** A running task row of `conversationId` (no process: the poll runs hourly here). */
async function runningTask(conversationId: string, account = ownerId) {
  const id = newTaskId();
  const startedAt = new Date(Date.now() - 5_000);
  await store.insert({
    id,
    orgId,
    conversationId,
    sandboxConversationId: conversationId,
    // a row without a process: no instance to address
    environmentId: null,
    runId: "run-x",
    callId: "call-x",
    triggerAccountId: account,
    description: `Task ${id}`,
    command: "true",
    sid: "4242",
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + 3_600_000),
    sandboxCreatedAt: new Date(),
  });
  const task = await store.get(id);
  if (!task) throw new Error("task row missing");
  return task;
}

const finishedEvent = async (conversationId: string, taskId: string) =>
  (await eventsOf(db, conversationId)).find(
    (e): e is Finished => e.type === "background_task_finished" && e.payload.taskId === taskId,
  ) as Finished;

/** Finishes a new task of `conversationId` as the poller (or, `reported`, a tool call) does. */
async function finishTask(
  conversationId: string,
  opts: { account?: string; reported?: boolean } = {},
): Promise<Finished> {
  const id = newTaskId();
  const startedAt = new Date(Date.now() - 5_000);
  await store.insert({
    id,
    orgId,
    conversationId,
    sandboxConversationId: conversationId,
    // a row without a process: no instance to address
    environmentId: null,
    runId: "run-x",
    callId: "call-x",
    triggerAccountId: opts.account ?? ownerId,
    description: `Task ${id}`,
    command: "true",
    sid: "4242",
    outputPath: taskOutputPath(id),
    startedAt,
    deadlineAt: new Date(startedAt.getTime() + 3_600_000),
    sandboxCreatedAt: new Date(),
  });
  const task = await store.get(id);
  if (!task) throw new Error("task row missing");
  const done = await finisher.finish(
    task,
    { status: "completed", exitCode: 0 },
    `out of ${id}\n`,
    opts.reported ?? false,
  );
  expect(done).toBe(true);
  return (await eventsOf(db, conversationId)).find(
    (e): e is Finished => e.type === "background_task_finished" && e.payload.taskId === id,
  ) as Finished;
}

const systemTexts = (r: ModelRequest | undefined) =>
  (r?.messages ?? []).flatMap((m) =>
    m.role === "system" && typeof m.content === "string" ? [m.content] : [],
  );
/** The requests the provider received that mention `marker`, in order. */
const requestsWith = (marker: string) =>
  capture.sent.filter((r) => JSON.stringify(r.messages).includes(marker));

type RunRow = { id: string; trigger_seq: string; trigger_account_id: string; status: string };
const runRows = (conversationId: string): Promise<RunRow[]> =>
  db
    .selectFrom("runs")
    .select(["id", "trigger_seq", "trigger_account_id", "status"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at")
    .execute();

const runStarted = async (conversationId: string, runId: string) =>
  (await eventsOf(db, conversationId)).find(
    (e) => e.type === "run_started" && e.runId === runId,
  ) as Extract<ConversationEvent, { type: "run_started" }>;

/** A conversation with one finished run (`text` answered). */
async function idleConversation(text: string): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 30_000);
  return conv;
}

/** Every model call of the run's snapshot rebuilds the request the provider received. */
async function expectZeroDrift(conversationId: string, runId: string, marker: string) {
  const snap = await takeSnapshot(db, orgId, conversationId, runId, 4_194_304);
  const calls = toEvents(snap).filter(
    (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
  );
  const sent = requestsWith(marker);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls).toHaveLength(sent.length);
  for (const [i, c] of calls.entries()) {
    const info = (
      await k.app
        .get(ProviderRegistry)
        .resolve(snap.orgId, { provider: c.payload.provider, model: c.payload.model })
    ).info;
    const out = reconstructRequest(snap, c.seq, { model: info });
    expect(out.drift, `model_call seq ${c.seq}`).toEqual([]);
    expect(out.request, `model_call seq ${c.seq}`).toEqual(sent[i]);
  }
}

/** No run starts for the conversation now (and none had). */
async function expectNoWake(conversationId: string, before: number): Promise<void> {
  expect(await runs.ensureRun(conversationId)).toBeNull();
  expect(await runRows(conversationId)).toHaveLength(before);
}

describe("a finish during a run", { timeout: 60_000 }, () => {
  it("between steps: the next request has it right after the tool results, and consumed_seq passes it", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO mid");
    await arrived("mid");
    const f = await finishTask(conv);
    release("mid");
    const [end] = await waitForTerminal(db, conv, 1, 30_000);
    expect(end?.type).toBe("run_finished");
    const sent = requestsWith("SCENARIO mid");
    expect(sent).toHaveLength(2);
    expect(systemTexts(sent[0])).toEqual([]);
    const step2 = sent[1] as ModelRequest;
    expect(step2.messages.at(-1)).toEqual({
      role: "system",
      content: renderBackgroundFinished(f.payload),
    });
    expect(step2.messages.at(-2)?.content).toMatchObject([
      { type: "tool_result", content: "counted 1" },
    ]);
    expect(
      ((end as ConversationEvent).payload as EventPayload<"run_finished">).consumedUpToSeq,
    ).toBeGreaterThanOrEqual(f.seq);
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(f.seq);
    // consumed: no wake run follows
    await expectNoWake(conv, 1);
    await expectZeroDrift(conv, (await runRows(conv))[0]?.id as string, "SCENARIO mid");
  });

  it("during the last model call: in no request of that run; a wake run follows whose first request has it (Review Focus 4)", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO last");
    await arrived("last");
    const f = await finishTask(conv);
    release("last");
    const ends = await waitForTerminal(db, conv, 2, 30_000);
    expect(ends.map((e) => e.type)).toEqual(["run_finished", "run_finished"]);
    expect(
      ((ends[0] as ConversationEvent).payload as EventPayload<"run_finished">).consumedUpToSeq,
    ).toBeLessThan(f.seq);
    const [first, wake] = await runRows(conv);
    expect(Number(wake?.trigger_seq)).toBe(f.seq);
    expect(wake?.trigger_account_id).toBe(ownerId);
    expect((await runStarted(conv, wake?.id as string)).payload.trigger).toBe("background_task");
    expect((await runStarted(conv, first?.id as string)).payload.trigger).toBeUndefined();
    const sent = requestsWith("SCENARIO last");
    expect(sent).toHaveLength(2);
    expect(systemTexts(sent[0])).toEqual([]);
    expect(sent[1]?.messages.at(-1)).toEqual({
      role: "system",
      content: renderBackgroundFinished(f.payload),
    });
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(f.seq);
    // step replay of every call, the wake run's included, rebuilds the request: zero drift
    await expectZeroDrift(conv, wake?.id as string, "SCENARIO last");
  });

  it("while the run waits for an approval: absorbed after the resume", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO wait");
    const approval = await waitFor(
      async () =>
        db
          .selectFrom("approvals")
          .select("id")
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      15_000,
      "pending approval",
    );
    await waitFor(
      async () => (await runRows(conv))[0]?.status === "waiting",
      15_000,
      "run waiting",
    );
    const f = await finishTask(conv);
    // the waiting run is the conversation's run: no wake
    expect(await runs.ensureRun(conv)).toBeNull();
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approval.id}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    await waitForTerminal(db, conv, 1, 30_000);
    const sent = requestsWith("SCENARIO wait");
    expect(sent).toHaveLength(2);
    expect(systemTexts(sent[0])).toEqual([]);
    expect(sent[1]?.messages.at(-1)).toEqual({
      role: "system",
      content: renderBackgroundFinished(f.payload),
    });
    expect(sent[1]?.messages.at(-2)?.content).toMatchObject([
      { type: "tool_result", content: "asked 2" },
    ]);
    await expectNoWake(conv, 1);
  });
});

describe("waking an idle conversation", { timeout: 60_000 }, () => {
  it("a finish wakes a run attributed to the task's trigger account", async () => {
    const conv = await idleConversation("SCENARIO idle");
    const f = await finishTask(conv, { account: bobId });
    await waitForTerminal(db, conv, 2, 30_000);
    const wake = (await runRows(conv))[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(f.seq);
    expect(wake.trigger_account_id).toBe(bobId);
    const started = await runStarted(conv, wake.id);
    expect(started.payload).toMatchObject({ triggerAccountId: bobId, trigger: "background_task" });
    const sent = requestsWith("SCENARIO idle");
    expect(sent.at(-1)?.messages.at(-1)).toEqual({
      role: "system",
      content: renderBackgroundFinished(f.payload),
    });
    await expectNoWake(conv, 2);
  });

  it("two finishes close together give one wake run that sees both; a third inside the window waits for its end", async () => {
    const conv = await idleConversation("SCENARIO two");
    const a = await finishTask(conv);
    // the wake run's first model call is held: the second finish lands during it
    await arrived("two");
    const b = await finishTask(conv);
    expect(await runs.ensureRun(conv)).toBeNull();
    release("two");
    await waitForTerminal(db, conv, 2, 30_000);
    const rows = await runRows(conv);
    expect(rows).toHaveLength(2);
    const wake = rows[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(a.seq);
    const sent = requestsWith("SCENARIO two");
    const wakeRequests = sent.slice(1);
    expect(wakeRequests).toHaveLength(2);
    expect(systemTexts(wakeRequests[0])).toEqual([renderBackgroundFinished(a.payload)]);
    expect(systemTexts(wakeRequests[1])).toEqual([
      renderBackgroundFinished(a.payload),
      renderBackgroundFinished(b.payload),
    ]);
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(b.seq);

    // a third finish seconds after that wake started: inside the window, a delayed job instead
    const c = await finishTask(conv);
    expect(await runRows(conv)).toHaveLength(2);
    const { started } = await db
      .selectFrom("runs")
      .select(sql<string>`floor(extract(epoch from created_at) * 1000)::bigint`.as("started"))
      .where("id", "=", wake.id)
      .executeTakeFirstOrThrow();
    const windowEnd = Number(started) + WAKE_WINDOW_MS;
    const queue = k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
    const job = await queue.getJob(bgWakeJobId(conv, windowEnd));
    expect(job?.name).toBe("bg-wake");
    expect(job?.data).toEqual({ conversationId: conv });
    expect(await job?.getState()).toBe("delayed");
    // a second ensureRun in the window keeps the one job
    expect(await runs.ensureRun(conv)).toBeNull();
    expect((await queue.getDelayed()).filter((j) => j.data?.conversationId === conv)).toHaveLength(
      1,
    );
    // the window ends (moved back instead of waiting a minute): the job wakes the conversation
    await sql`UPDATE capybara.runs SET created_at = created_at - interval '61 seconds'
      WHERE id = ${wake.id}`.execute(raw);
    await job?.promote();
    await waitForTerminal(db, conv, 3, 30_000);
    const third = (await runRows(conv))[2] as RunRow;
    expect(Number(third.trigger_seq)).toBe(c.seq);
    expect((await runStarted(conv, third.id)).payload.trigger).toBe("background_task");
    expect(systemTexts(requestsWith("SCENARIO two").at(-1)).at(-1)).toBe(
      renderBackgroundFinished(c.payload),
    );
  });
});

describe("no wake", { timeout: 60_000 }, () => {
  it("for the parent, on a sub-agent's task: the finish wakes the sub-agent, never its parent", async () => {
    const conv = await idleConversation("SCENARIO child");
    const child = randomUUID();
    await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
      VALUES (${child}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${conv})`.execute(raw);
    const f = await finishTask(child);
    // the child's wake run (agent map spec §5.3; its run is covered by the sub-agent wake tests)
    const wake = await waitFor(
      async () => (await runRows(child))[0] ?? null,
      15_000,
      "the child's wake run",
    );
    expect(Number(wake.trigger_seq)).toBe(f.seq);
    expect(wake.trigger_account_id).toBe(ownerId);
    await expectNoWake(conv, 1);
  });

  it("while the queue is paused", async () => {
    const conv = await idleConversation("SCENARIO paused");
    await sql`UPDATE capybara.conversations SET queue_paused = true, queue_pause_reason = 'run_ended'
      WHERE id = ${conv}`.execute(raw);
    expect(await finishTask(conv)).toBeDefined();
    await expectNoWake(conv, 1);
  });

  it("with runtime.wakeOnBackgroundTask false", async () => {
    const conv = await idleConversation("SCENARIO deployment off");
    const config = k.app.get(KernelConfigService);
    const real = config.get();
    vi.spyOn(config, "get").mockReturnValue({
      ...real,
      runtime: { ...real.runtime, wakeOnBackgroundTask: false },
    });
    expect(await finishTask(conv)).toBeDefined();
    await expectNoWake(conv, 1);
  });

  it("with the org override set to false, even when the deployment wakes", async () => {
    const conv = await idleConversation("SCENARIO org off");
    await sql`UPDATE capybara.orgs SET settings = settings || '{"wakeOnBackgroundTask": false}'
      WHERE id = ${orgId}`.execute(raw);
    try {
      expect(await finishTask(conv)).toBeDefined();
      await expectNoWake(conv, 1);
    } finally {
      await sql`UPDATE capybara.orgs SET settings = settings - 'wakeOnBackgroundTask'
        WHERE id = ${orgId}`.execute(raw);
    }
  });

  it("when the task's trigger account left the org: the next message picks the finish up (Review Focus 5)", async () => {
    const carolId = (
      await accountsFor(db).createLocal({ login: "carol", password: PW, displayName: "C" })
    ).id;
    await testMembers(db).add(orgId, carolId, "member", ownerId);
    const conv = await idleConversation("SCENARIO left");
    await sql`DELETE FROM capybara.memberships WHERE org_id = ${orgId} AND account_id = ${carolId}`.execute(
      raw,
    );
    const f = await finishTask(conv, { account: carolId });
    await expectNoWake(conv, 1);
    expect(await consumedSeq(db, conv)).toBeLessThan(f.seq);
    await postMessage(owner, orgId, conv, "next");
    await waitForTerminal(db, conv, 2, 30_000);
    const next = (await runRows(conv))[1] as RunRow;
    expect(next.trigger_account_id).toBe(ownerId);
    expect((await runStarted(conv, next.id)).payload.trigger).toBeUndefined();
    expect(systemTexts(requestsWith("SCENARIO left").at(-1))).toEqual([
      renderBackgroundFinished(f.payload),
    ]);
  });

  it("for a finish a tool call already reported: no wake; the next request has the short line", async () => {
    const conv = await idleConversation("SCENARIO reported");
    const f = await finishTask(conv, { reported: true });
    await expectNoWake(conv, 1);
    await postMessage(owner, orgId, conv, "next");
    await waitForTerminal(db, conv, 2, 30_000);
    const short = renderBackgroundFinished(f.payload);
    expect(short).toBe(
      `Background task ${f.payload.taskId} ("Task ${f.payload.taskId}") completed; already reported.`,
    );
    expect(systemTexts(requestsWith("SCENARIO reported").at(-1))).toEqual([short]);
  });
});

describe("fix round 1", { timeout: 60_000 }, () => {
  it("a person's stop on an idle conversation wakes nothing; the next message's run absorbs it", async () => {
    const conv = await idleConversation("SCENARIO person stop");
    const task = await runningTask(conv);
    await k.app.get(BackgroundTaskStopper).stop(task, "person");
    const f = await finishedEvent(conv, task.id);
    expect(f.payload).toMatchObject({ reported: false, stoppedBy: "person" });
    await expectNoWake(conv, 1);
    expect(await consumedSeq(db, conv)).toBeLessThan(f.seq);
    await postMessage(owner, orgId, conv, "next");
    await waitForTerminal(db, conv, 2, 30_000);
    expect(systemTexts(requestsWith("SCENARIO person stop").at(-1))).toEqual([
      renderBackgroundFinished(f.payload),
    ]);
    expect(await consumedSeq(db, conv)).toBeGreaterThan(f.seq);
  });

  it("a bg-wake job that fires before the window ends reschedules itself and wakes at the end", async () => {
    const conv = await idleConversation("SCENARIO early");
    await finishTask(conv);
    await waitForTerminal(db, conv, 2, 30_000);
    const wake = (await runRows(conv))[1] as RunRow;
    const late = await finishTask(conv);
    const windowEndOf = async () =>
      Number(
        (
          await db
            .selectFrom("runs")
            .select(sql<string>`floor(extract(epoch from created_at) * 1000)::bigint`.as("t"))
            .where("id", "=", wake.id)
            .executeTakeFirstOrThrow()
        ).t,
      ) + WAKE_WINDOW_MS;
    const queue = k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
    const job = await queue.getJob(bgWakeJobId(conv, await windowEndOf()));
    expect(await job?.getState()).toBe("delayed");
    // the window now ends in about 3 s on the database's clock; the job fires before that
    await sql`UPDATE capybara.runs SET created_at = created_at - interval '57 seconds'
      WHERE id = ${wake.id}`.execute(raw);
    const end = await windowEndOf();
    await job?.promote();
    const retry = await waitFor(
      async () => queue.getJob(bgWakeJobId(conv, end, 1)),
      10_000,
      "rescheduled wake job",
    );
    expect(retry.data).toEqual({ conversationId: conv, retry: 1 });
    expect(await runRows(conv)).toHaveLength(2);
    await waitForTerminal(db, conv, 3, 20_000);
    const third = (await runRows(conv))[2] as RunRow;
    expect(Number(third.trigger_seq)).toBe(late.seq);
    expect((await runStarted(conv, third.id)).payload).toMatchObject({
      trigger: "background_task",
      triggerSeq: late.seq,
    });
  });

  it("an orphaned wake run is repaired by ensureRun; later finishes and messages go on", async () => {
    const conv = await idleConversation("SCENARIO orphan");
    // a finish whose wake run was queued, and whose job was lost (no job ever existed). The
    // orphan goes in first: the run that just ended may still be in its own ensureRun, which
    // would otherwise start a wake run for the finish itself. The conversation row is locked
    // first, as the kernel's ensureRun does (an insert's foreign key check alone deadlocked).
    const task = await runningTask(conv);
    const orphan = randomUUID();
    await raw.transaction().execute(async (t) => {
      await sql`SELECT id FROM capybara.conversations WHERE id = ${conv} FOR UPDATE`.execute(t);
      await sql`INSERT INTO capybara.runs
          (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
        VALUES (${orphan}, ${conv}, 'queued', 1, ${ownerId}, 0)`.execute(t);
    });
    const [ev] = await k.app.get(EventLog).append(conv, [
      {
        type: "background_task_finished",
        payload: {
          taskId: task.id,
          description: task.description,
          status: "completed",
          exitCode: 0,
          elapsedMs: 1_000,
          lastLines: "",
          outputPath: `/workspace/${task.outputPath}`,
          reported: false,
        },
      },
    ]);
    await sql`UPDATE capybara.runs SET trigger_seq = ${ev?.seq ?? 0} WHERE id = ${orphan}`.execute(
      raw,
    );
    // past the queued grace period and outside the wake window
    await sql`UPDATE capybara.runs SET created_at = now() - interval '2 minutes',
      queued_at = now() - interval '2 minutes' WHERE id = ${orphan}`.execute(raw);
    expect(await runs.ensureRun(conv)).toBeNull();
    const repaired = (await runRows(conv)).find((r) => r.id === orphan);
    expect(repaired?.status).toBe("failed");
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(ev?.seq ?? 0);
    const failed = (await eventsOf(db, conv)).find(
      (e) => e.type === "run_failed" && e.runId === orphan,
    );
    expect(failed?.payload).toMatchObject({ error: { code: "run.orphaned" } });
    // a later finish wakes the conversation again
    const next = await finishTask(conv);
    await waitFor(
      async () => (await runRows(conv)).some((r) => Number(r.trigger_seq) === next.seq),
      15_000,
      "wake run after the repair",
    );
    await waitFor(
      async () =>
        (await runRows(conv)).every((r) => r.status !== "queued" && r.status !== "running"),
      30_000,
      "wake run finished",
    );
    // and a message runs as usual
    const seq = await postMessage(owner, orgId, conv, "after");
    await waitFor(
      async () =>
        (await runRows(conv)).some(
          (r) => Number(r.trigger_seq) === seq && r.status === "completed",
        ),
      30_000,
      "message run",
    );
  });
});
