import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SANDBOX_ROOTS, type ModelRequest } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { getQueueToken } from "@nestjs/bullmq";
import type { Queue } from "bullmq";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BackgroundTaskFinisher } from "../../../src/background/finish.js";
import { newTaskId, taskOutputPath } from "../../../src/background/launch.js";
import { BackgroundTaskStore } from "../../../src/background/store.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { reconstructRequest } from "../../../src/evals/reconstruct.js";
import { takeSnapshot, toEvents } from "../../../src/evals/snapshot.js";
import { devicePathsText } from "../../../src/runtime/context/device-paths.js";
import { MAINTENANCE_QUEUE_NAME } from "../../../src/runtime/maintenance-queue.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { RunQueue } from "../../../src/runtime/run-queue.js";
import { SubagentDeliveries } from "../../../src/runtime/subagents/deliveries.js";
import { renderSubagentDelivery } from "../../../src/runtime/subagents/render.js";
import { Waits } from "../../../src/runtime/waits.js";
import type { ScriptRule } from "../../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../../helpers/conversations.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { testMembers } from "../../helpers/members.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import { captureProviderRequests } from "../../helpers/provider-capture.js";
import { isRunContextText } from "../../helpers/run-context.js";
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
} from "../../helpers/runs.js";
import { childRunsOf } from "../../helpers/subagents.js";

/**
 * Agent map spec §5.3 (Task A5): a sub-agent's delivery wakes an idle parent under the background
 * Bash §3 rules (the 60 s window, the paused queue and the "can the trigger account still send"
 * checks, read on the root conversation), and a child's own background task wakes the idle child.
 * One kernel with model-script; barriers hold model calls while the test arranges a race.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const held = (name: string) => ({ name, count: 99, timeoutMs: 60_000 });
const agent = (description: string, prompt: string) => ({
  name: "Agent",
  input: { description, prompt },
});
const READ = { name: "Read", input: { file_path: "/workspace/none.txt" } };

const RULES: ScriptRule[] = [
  // children
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-hold" },
    reply: { text: "held child done", barrier: held("child") },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-trio" },
    reply: { text: "trio child done", barrier: held("trio") },
  },
  { when: { systemIncludes: CHILD, lastUserIncludes: "child-quick" }, reply: { text: "quick" } },
  // hands back a report, then its final call is held
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-handback", assistantTurns: 0 },
    reply: { toolCalls: [{ name: "SubagentHandback", input: { message: "HB report" } }] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "child-handback" },
    reply: { text: "after the handback", barrier: held("handback") },
  },
  // an intermediate child: dispatches a held leaf, goes on, and answers when woken
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "mid-dispatch", assistantTurns: 0 },
    reply: { toolCalls: [agent("Leaf", "child-hold: leaf")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "mid-dispatch", assistantTurns: 2 },
    reply: { text: "mid woke" },
  },
  // an intermediate child that dispatches a held leaf and holds its own next call
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "tree-mid", assistantTurns: 0 },
    reply: { toolCalls: [agent("Tree leaf", "child-hold: tree leaf")] },
  },
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "tree-mid", assistantTurns: 1 },
    reply: { text: "tree mid done", barrier: held("tree-mid") },
  },
  // parents: step 1 dispatches
  {
    when: { lastUserIncludes: "SCENARIO hold", assistantTurns: 0 },
    reply: { toolCalls: [agent("Held task", "child-hold: work")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO quick", assistantTurns: 0 },
    reply: { toolCalls: [agent("Quick task", "child-quick: work")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO handback", assistantTurns: 0 },
    reply: { toolCalls: [agent("Reporter", "child-handback: work")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO deep", assistantTurns: 0 },
    reply: { toolCalls: [agent("Mid task", "mid-dispatch: go")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO tree", assistantTurns: 0 },
    reply: { toolCalls: [agent("Tree mid", "tree-mid: go")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO trio", assistantTurns: 0 },
    reply: {
      toolCalls: [
        agent("Trio A", "child-trio: a"),
        agent("Trio B", "child-trio: b"),
        agent("Trio C", "child-trio: c"),
      ],
    },
  },
  // SCENARIO absorb: step 2 is held while the child delivers, then a step 3 follows
  {
    when: { lastUserIncludes: "SCENARIO absorb", assistantTurns: 0 },
    reply: { toolCalls: [agent("Quick task", "child-quick: work")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO absorb", assistantTurns: 1 },
    reply: { toolCalls: [READ], barrier: held("absorb") },
  },
  // SCENARIO trio: the wake run's first call is held until all three delivered
  {
    when: { lastUserIncludes: "SCENARIO trio", assistantTurns: 2 },
    reply: { toolCalls: [READ], barrier: held("trio-wake") },
  },
  {
    when: { lastToolResultIncludes: "running in the background" },
    reply: { text: "parent went on" },
  },
];

type Barriers = Map<string, { arrived: number; waiters: (() => void)[] }>;
const barriers = (): Barriers | undefined =>
  (globalThis as { __modelScript?: { barriers: Barriers } }).__modelScript?.barriers;
/** How many model calls arrived at barrier `name` so far. */
const arrivals = (name: string) => barriers()?.get(name)?.arrived ?? 0;
const arrived = (name: string) =>
  waitFor(async () => (barriers()?.get(name)?.arrived ?? 0) >= 1, 20_000, `barrier ${name}`);
/** Waits until `n` model calls are held at barrier `name` right now. */
const waiting = (name: string, n = 1) =>
  waitFor(
    async () => (barriers()?.get(name)?.waiters.length ?? 0) >= n,
    20_000,
    `${n} held at ${name}`,
  );
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
let orgId: string;
let agentId: string;
let runs: RunQueue;
let root: string;

beforeAll(async () => {
  capture.install();
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  root = await mkdtemp(join(tmpdir(), "cap-subagents-wake-"));
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
  runs = k.app.get(RunQueue);
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
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
        disabledTools: onlyBuiltins(["Agent", "Read"].map((name) => ({ kind: "builtin", name }))),
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

type Delivery = Extract<ConversationEvent, { type: "subagent_delivery" }>;
type RunRow = {
  id: string;
  trigger_seq: string;
  trigger_account_id: string;
  status: string;
  budget_run_id: string | null;
};

const runRows = (conversationId: string): Promise<RunRow[]> =>
  db
    .selectFrom("runs")
    .select(["id", "trigger_seq", "trigger_account_id", "status", "budget_run_id"])
    .where("conversation_id", "=", conversationId)
    .orderBy("created_at")
    .execute();

const deliveriesOf = async (conversationId: string) =>
  (await eventsOf(db, conversationId)).filter((e): e is Delivery => e.type === "subagent_delivery");

const runStarted = async (conversationId: string, runId: string) =>
  (await eventsOf(db, conversationId)).find(
    (e) => e.type === "run_started" && e.runId === runId,
  ) as Extract<ConversationEvent, { type: "run_started" }>;

/** The request's system messages, run context snapshots left out (run context spec §4). */
const systemTexts = (r: ModelRequest | undefined) =>
  (r?.messages ?? []).flatMap((m) =>
    m.role === "system" && typeof m.content === "string" && !isRunContextText(m.content)
      ? [m.content]
      : [],
  );
/** The parent requests the provider received that carry `marker`, in order (children excluded). */
const parentRequests = (marker: string) =>
  capture.sent.filter(
    (r) =>
      JSON.stringify(r.messages).includes(marker) && !r.system.some((s) => s.text.includes(CHILD)),
  );

/** No run starts for the conversation now (and the number of runs stays `before`). */
async function expectNoWake(conversationId: string, before: number): Promise<void> {
  expect(await runs.ensureRun(conversationId)).toBeNull();
  expect(await runRows(conversationId)).toHaveLength(before);
}

/** Every model call of the run's snapshot rebuilds the request the provider received. */
async function expectZeroDrift(conversationId: string, runId: string, marker: string) {
  const snap = await takeSnapshot(db, orgId, conversationId, runId, 4_194_304);
  const calls = toEvents(snap).filter(
    (e): e is Extract<ConversationEvent, { type: "model_call" }> => e.type === "model_call",
  );
  const sent = parentRequests(marker);
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

/** A parent conversation whose first run dispatched and ended (the child may still run). */
async function dispatched(text: string): Promise<string> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 30_000);
  return conv;
}

/**
 * A note delivery to the idle conversation `conv` from a hand-made child whose run was triggered
 * by `accountId` (the delivery's trigger account), through `SubagentDeliveries` as `SendMessage`
 * does: the domain event follows the commit.
 */
async function noteFrom(conv: string, accountId: string): Promise<Delivery> {
  const child = randomUUID();
  const childRunId = randomUUID();
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id, title)
    VALUES (${child}, ${orgId}, ${agentId}, ${ownerId}, 'subagent', ${conv}, 'Hand child')`.execute(
    raw,
  );
  await sql`INSERT INTO capybara.runs
      (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq)
    VALUES (${childRunId}, ${child}, 'completed', 1, ${accountId}, 1)`.execute(raw);
  const seq = await k.app.get(SubagentDeliveries).deliverIn(
    {
      parentRunId: randomUUID(),
      parentCallId: "call-x",
      parentConversationId: conv,
      childConversationId: child,
      childRunId,
    },
    { kind: "note", text: "a note" },
    { idemKey: `note:${childRunId}` },
  );
  expect(seq).not.toBeNull();
  return (await deliveriesOf(conv)).find((d) => d.seq === seq) as Delivery;
}

describe("waking on sub-agent deliveries", { timeout: 90_000 }, () => {
  it('a delivery to an idle root starts a wake run with trigger "subagent" and the child\'s trigger account', async () => {
    capture.reset();
    const conv = await dispatched("SCENARIO hold");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    const [first] = await runRows(conv);
    expect(await runRows(conv)).toHaveLength(1);
    await waiting("child");
    release("child");
    await waitForTerminal(db, conv, 2, 30_000);
    const [delivery] = await deliveriesOf(conv);
    if (!delivery) throw new Error("no delivery");
    const childRun = await db
      .selectFrom("runs")
      .select("trigger_account_id")
      .where("id", "=", child.runId)
      .executeTakeFirstOrThrow();
    expect(delivery.payload.triggerAccountId).toBe(childRun.trigger_account_id);
    const wake = (await runRows(conv))[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(delivery.seq);
    expect(wake.trigger_account_id).toBe(delivery.payload.triggerAccountId);
    // the wake run counts against the root's budget window: the person-triggered run
    expect(wake.budget_run_id).toBe(first?.id);
    expect(first?.budget_run_id).toBeNull();
    expect((await runStarted(conv, wake.id)).payload).toMatchObject({
      trigger: "subagent",
      triggerSeq: delivery.seq,
      triggerAccountId: ownerId,
    });
    const sent = parentRequests("SCENARIO hold");
    expect(sent.at(-1)?.messages.at(-1)).toEqual({
      role: "system",
      content: renderSubagentDelivery(delivery.payload),
    });
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(delivery.seq);
    await expectNoWake(conv, 2);
    await expectZeroDrift(conv, wake.id, "SCENARIO hold");
  });

  it("a child that handed back wakes the idle root with its report; its completion wakes nobody", async () => {
    capture.reset();
    const conv = await dispatched("SCENARIO handback");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    // the report wakes the idle parent while the child's final call is held
    await waiting("handback");
    await waitForTerminal(db, conv, 2, 30_000);
    const [report, ...more] = await deliveriesOf(conv);
    expect(more).toEqual([]);
    expect(report?.payload).toMatchObject({ kind: "report", text: "HB report" });
    const wake = (await runRows(conv))[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(report?.seq);
    // the child completes: only subagent_finished, no finished delivery, no wake run
    release("handback");
    const finished = await waitFor(
      async () =>
        (await eventsOf(db, conv)).find(
          (e) => e.type === "subagent_finished" && e.payload.childRunId === child.runId,
        ) ?? null,
      30_000,
      "the child's subagent_finished",
    );
    await new Promise((r) => setTimeout(r, 500));
    expect((await deliveriesOf(conv)).map((d) => d.payload.kind)).toEqual(["report"]);
    expect(await consumedSeq(db, conv)).toBeLessThan(finished.seq);
    await expectNoWake(conv, 2);
    await expectZeroDrift(conv, wake.id, "SCENARIO handback");
  });

  it("delivery during a parent run is absorbed, not woken", async () => {
    capture.reset();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO absorb");
    await arrived("absorb");
    // the child finished and delivered while the parent's step 2 is in its model call
    const delivery = await waitFor(
      async () => (await deliveriesOf(conv))[0] ?? null,
      30_000,
      "the finished delivery",
    );
    expect(await runs.ensureRun(conv)).toBeNull();
    release("absorb");
    const [end] = await waitForTerminal(db, conv, 1, 30_000);
    expect(end?.type).toBe("run_finished");
    const sent = parentRequests("SCENARIO absorb");
    expect(sent).toHaveLength(3);
    expect(systemTexts(sent[1])).toEqual([]);
    // ruling R22: the step's first sandbox call recorded the device's directories
    expect(systemTexts(sent[2])).toEqual([
      renderSubagentDelivery(delivery.payload),
      devicePathsText({ roots: DEFAULT_SANDBOX_ROOTS, tier: "dev", isolation: "sandbox" }),
    ]);
    expect(
      ((end as ConversationEvent).payload as EventPayload<"run_finished">).consumedUpToSeq,
    ).toBeGreaterThanOrEqual(delivery.seq);
    // absorbed exactly once, and no wake run follows
    await new Promise((r) => setTimeout(r, 500));
    await expectNoWake(conv, 1);
    await expectZeroDrift(conv, (await runRows(conv))[0]?.id as string, "SCENARIO absorb");
  });

  it("three children finishing within 60 s cause one wake run that absorbs all three", async () => {
    capture.reset();
    const conv = await dispatched("SCENARIO trio");
    expect(await childRunsOf(db, conv)).toHaveLength(3);
    await waiting("trio", 3);
    release("trio");
    await arrived("trio-wake");
    const all = await waitFor(
      async () => {
        const d = await deliveriesOf(conv);
        return d.length >= 3 ? d : null;
      },
      30_000,
      "three deliveries",
    );
    release("trio-wake");
    await waitForTerminal(db, conv, 2, 30_000);
    await new Promise((r) => setTimeout(r, 500));
    expect(await runRows(conv)).toHaveLength(2);
    const wake = (await runRows(conv))[1] as RunRow;
    // the boundary is the newest delivery when the wake started
    expect(all.map((d) => d.seq)).toContain(Number(wake.trigger_seq));
    const wakeRequests = parentRequests("SCENARIO trio").slice(2);
    expect(wakeRequests).toHaveLength(2);
    expect(systemTexts(wakeRequests[1])).toEqual([
      ...all.map((d) => renderSubagentDelivery(d.payload)),
      // ruling R22: the wake run's first sandbox call recorded the device's directories
      devicePathsText({ roots: DEFAULT_SANDBOX_ROOTS, tier: "dev", isolation: "sandbox" }),
    ]);
    expect(await consumedSeq(db, conv)).toBeGreaterThanOrEqual(all[2]?.seq ?? 0);
    // everything consumed: no delayed wake waits for this conversation
    const queue = k.app.get<Queue>(getQueueToken(MAINTENANCE_QUEUE_NAME));
    expect((await queue.getDelayed()).filter((j) => j.data?.conversationId === conv)).toEqual([]);
    await expectNoWake(conv, 2);
  });

  it("a paused root queue holds the wake", async () => {
    const conv = await dispatched("SCENARIO quick paused");
    await waitForTerminal(db, conv, 2, 30_000);
    const before = (await runRows(conv)).length;
    await sql`UPDATE capybara.conversations SET queue_paused = true, queue_pause_reason = 'run_ended'
      WHERE id = ${conv}`.execute(raw);
    const d = await noteFrom(conv, ownerId);
    await expectNoWake(conv, before);
    expect(await consumedSeq(db, conv)).toBeLessThan(d.seq);
    // resumed: the next ensureRun wakes it
    await sql`UPDATE capybara.conversations SET queue_paused = false, queue_pause_reason = NULL
      WHERE id = ${conv}`.execute(raw);
    await sql`UPDATE capybara.runs SET created_at = created_at - interval '61 seconds'
      WHERE conversation_id = ${conv}`.execute(raw);
    expect(await runs.ensureRun(conv)).not.toBeNull();
    await waitForTerminal(db, conv, before + 1, 30_000);
    expect(Number((await runRows(conv)).at(-1)?.trigger_seq)).toBe(d.seq);
  });

  it("a trigger account that can no longer send to the root gets no wake, the event waits for the next message", async () => {
    const carolId = (
      await accountsFor(db).createLocal({ login: "carol", password: PW, displayName: "C" })
    ).id;
    await testMembers(db).add(orgId, carolId, "member", ownerId);
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO left");
    await waitForTerminal(db, conv, 1, 30_000);
    await sql`DELETE FROM capybara.memberships WHERE org_id = ${orgId} AND account_id = ${carolId}`.execute(
      raw,
    );
    const d = await noteFrom(conv, carolId);
    await expectNoWake(conv, 1);
    expect(await consumedSeq(db, conv)).toBeLessThan(d.seq);
    capture.reset();
    await postMessage(owner, orgId, conv, "next");
    await waitForTerminal(db, conv, 2, 30_000);
    const next = (await runRows(conv))[1] as RunRow;
    expect(next.trigger_account_id).toBe(ownerId);
    expect((await runStarted(conv, next.id)).payload.trigger).toBeUndefined();
    expect(systemTexts(parentRequests("SCENARIO left").at(-1))).toEqual([
      renderSubagentDelivery(d.payload),
    ]);
  });

  it("a child's own background task finish wakes the idle child", async () => {
    const conv = await dispatched("SCENARIO hold child task");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waiting("child");
    const [rootRun] = await runRows(conv);
    // the child started a background task; its run ends while the task still runs
    const store = k.app.get(BackgroundTaskStore);
    const id = newTaskId();
    const startedAt = new Date(Date.now() - 5_000);
    await store.insert({
      id,
      orgId,
      conversationId: child.conversationId,
      sandboxConversationId: conv,
      // a row without a process: no instance to address
      deviceId: null,
      runId: child.runId,
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
    release("child");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    // the parent's wake from the child's finish ends too
    await waitForTerminal(db, conv, 2, 30_000);
    // the finished child's task was not stopped: it can still wake the child
    const task = await store.get(id);
    if (!task) throw new Error("task row missing");
    expect(task.status).toBe("running");
    expect(
      await k.app
        .get(BackgroundTaskFinisher)
        .finish(task, { status: "completed", exitCode: 0 }, "out\n", false),
    ).toBe(true);
    const finished = (await eventsOf(db, child.conversationId)).find(
      (e) => e.type === "background_task_finished",
    );
    if (!finished) throw new Error("no finish in the child's log");
    // the child's wake run holds at the same barrier as its first run
    await waiting("child");
    release("child");
    await waitForTerminal(db, child.conversationId, 2, 30_000);
    const wake = (await runRows(child.conversationId))[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(finished.seq);
    expect(wake.trigger_account_id).toBe(ownerId);
    expect(wake.budget_run_id).toBe(rootRun?.id);
    expect(wake.status).toBe("completed");
    expect((await runStarted(child.conversationId, wake.id)).payload).toMatchObject({
      trigger: "background_task",
      triggerSeq: finished.seq,
    });
    expect(await consumedSeq(db, child.conversationId)).toBeGreaterThanOrEqual(finished.seq);
  });

  it("a child's wake run finishing delivers to the parent", async () => {
    const conv = await dispatched("SCENARIO quick wake delivers");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    await waitForTerminal(db, conv, 2, 30_000);
    await finishChildTask(conv, child);
    await waitForTerminal(db, child.conversationId, 2, 30_000);
    const wake = (await runRows(child.conversationId))[1] as RunRow;
    const ofWake = async () =>
      (await deliveriesOf(conv)).filter((d) => d.payload.childRunId === wake.id);
    const [d] = await waitFor(
      async () => {
        const got = await ofWake();
        return got.length > 0 ? got : null;
      },
      30_000,
      "the wake run's delivery",
    );
    expect(d?.payload).toEqual({
      subagentId: child.conversationId,
      childRunId: wake.id,
      description: "Quick task",
      kind: "finished",
      status: "completed",
      text: "quick",
      triggerAccountId: ownerId,
    });
    const finished = (await eventsOf(db, conv)).filter(
      (e) => e.type === "subagent_finished" && e.payload.childRunId === wake.id,
    );
    expect(finished).toHaveLength(1);
    // exactly once: the end handling again, and the sweep, write nothing more
    expect(await k.app.get(Waits).childFinished(wake.id)).toBe(false);
    await k.app.get(Waits).sweep();
    expect(await ofWake()).toHaveLength(1);
  });

  /**
   * A child that finished, its root woken by the delivery, then a second message to the root that
   * opened a new budget window; `exhaustOld` uses up the first window first. Then the child's
   * background task wakes it: its wake run, the windows and their token counters.
   */
  async function childWokenAfterNewWindow(marker: string, exhaustOld: boolean) {
    const conv = await dispatched(`SCENARIO quick ${marker}`);
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    await waitForTerminal(db, conv, 2, 30_000);
    const [oldWindow] = await runRows(conv);
    if (!oldWindow) throw new Error("no root run");
    await postMessage(owner, orgId, conv, "second window");
    await waitForTerminal(db, conv, 3, 30_000);
    const newWindow = (await runRows(conv))[2] as RunRow;
    expect(newWindow.budget_run_id).toBeNull();
    if (exhaustOld) {
      await sql`UPDATE capybara.runs SET subagent_tokens_used = 1000000000
        WHERE id = ${oldWindow.id}`.execute(raw);
    }
    const tokensOf = async (runId: string) =>
      Number(
        (
          await db
            .selectFrom("runs")
            .select("subagent_tokens_used")
            .where("id", "=", runId)
            .executeTakeFirstOrThrow()
        ).subagent_tokens_used,
      );
    const before = { old: await tokensOf(oldWindow.id), current: await tokensOf(newWindow.id) };
    await finishChildTask(conv, child);
    await waitForTerminal(db, child.conversationId, 2, 30_000);
    const wake = (await runRows(child.conversationId))[1] as RunRow;
    expect(wake.budget_run_id).toBe(newWindow.id);
    return {
      wake,
      terminal: (await eventsOf(db, child.conversationId)).at(-1),
      old: { before: before.old, after: await tokensOf(oldWindow.id) },
      current: { before: before.current, after: await tokensOf(newWindow.id) },
    };
  }

  it("a child's wake run counts its tokens on the root's current budget window", async () => {
    const r = await childWokenAfterNewWindow("budget counted", false);
    expect(r.wake.status).toBe("completed");
    // one model call of 10 + 5 tokens, on the window of the second message only
    expect(r.current.after).toBe(r.current.before + 15);
    expect(r.old.after).toBe(r.old.before);
  });

  it("a child's wake run is not refused by a used-up earlier budget window", async () => {
    const r = await childWokenAfterNewWindow("budget refused", true);
    expect(r.terminal).toMatchObject({ type: "run_finished", payload: { reason: "completed" } });
    expect(r.current.after).toBe(r.current.before + 15);
    expect(r.old.after).toBe(1_000_000_000);
  });

  it("a grandchild's delivery wakes the intermediate child, whose wake run reaches the root", async () => {
    const conv = await dispatched("SCENARIO deep");
    const [mid] = await childRunsOf(db, conv);
    if (!mid) throw new Error("no child dispatched");
    await waitForTerminal(db, mid.conversationId, 1, 30_000);
    const [leaf] = await childRunsOf(db, mid.conversationId);
    if (!leaf) throw new Error("no grandchild dispatched");
    expect(await runRows(mid.conversationId)).toHaveLength(1);
    await waiting("child");
    release("child");
    await waitForTerminal(db, mid.conversationId, 2, 30_000);
    const [leafDelivery] = await deliveriesOf(mid.conversationId);
    if (!leafDelivery) throw new Error("no delivery to the intermediate child");
    expect(leafDelivery.payload).toMatchObject({ childRunId: leaf.runId, text: "held child done" });
    const midWake = (await runRows(mid.conversationId))[1] as RunRow;
    expect(Number(midWake.trigger_seq)).toBe(leafDelivery.seq);
    expect(midWake.budget_run_id).toBe((await runRows(conv))[0]?.id);
    expect((await runStarted(mid.conversationId, midWake.id)).payload.trigger).toBe("subagent");
    const reached = await waitFor(
      async () =>
        (await deliveriesOf(conv)).find((d) => d.payload.childRunId === midWake.id) ?? null,
      30_000,
      "the intermediate child's wake delivery at the root",
    );
    expect(reached.payload).toMatchObject({
      subagentId: mid.conversationId,
      kind: "finished",
      status: "completed",
      text: "mid woke",
    });
  });

  it("a tree stop wakes neither the stopped agent nor the root", async () => {
    const conv = await dispatched("SCENARIO tree");
    const [mid] = await childRunsOf(db, conv);
    if (!mid) throw new Error("no child dispatched");
    await waiting("tree-mid");
    await waiting("child");
    const [leaf] = await childRunsOf(db, mid.conversationId);
    if (!leaf) throw new Error("no grandchild dispatched");
    // a task an earlier run of the mid started: it stops with the stopped mid too
    const earlier = await finishChildTask(
      conv,
      { ...mid, runId: "run-earlier" },
      { finish: false },
    );
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${mid.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    // the leaf's aborted finish lands in the stopped mid's log, the mid's in the root's
    const leafDelivery = await waitFor(
      async () => (await deliveriesOf(mid.conversationId))[0] ?? null,
      30_000,
      "the leaf's delivery",
    );
    expect(leafDelivery.payload).toMatchObject({ childRunId: leaf.runId, status: "aborted" });
    const midDelivery = await waitFor(
      async () => (await deliveriesOf(conv))[0] ?? null,
      30_000,
      "the mid's delivery",
    );
    expect(midDelivery.payload).toMatchObject({ childRunId: mid.runId, status: "aborted" });
    await new Promise((r) => setTimeout(r, 500));
    await expectNoWake(mid.conversationId, 1);
    await expectNoWake(conv, 1);
    expect(await consumedSeq(db, mid.conversationId)).toBeLessThan(leafDelivery.seq);
    const stopped = await waitFor(
      async () =>
        (await eventsOf(db, mid.conversationId)).find(
          (e) => e.type === "background_task_finished" && e.payload.taskId === earlier.taskId,
        ) ?? null,
      15_000,
      "the earlier task stopped",
    );
    expect(stopped.payload).toMatchObject({ stoppedBy: "subagent_end" });
  });

  /** The task's `background_task_finished` in `conversationId`'s log, once it was written. */
  const taskFinish = (conversationId: string, taskId: string) =>
    waitFor(
      async () =>
        (await eventsOf(db, conversationId)).find(
          (e) => e.type === "background_task_finished" && e.payload.taskId === taskId,
        ) ?? null,
      15_000,
      `task ${taskId} stopped`,
    );

  it("a tree stop stops an idle descendant's background tasks, so their finish wakes nobody", async () => {
    // (earlier tests leave aborted waiters at the barriers: wait for new arrivals instead)
    const before = { mid: arrivals("tree-mid"), leaf: arrivals("child") };
    const conv = await dispatched("SCENARIO tree idle leaf");
    const [mid] = await childRunsOf(db, conv);
    if (!mid) throw new Error("no child dispatched");
    await waitFor(
      async () => arrivals("tree-mid") > before.mid && arrivals("child") > before.leaf,
      20_000,
      "the mid and the leaf held",
    );
    const [leaf] = await childRunsOf(db, mid.conversationId);
    if (!leaf) throw new Error("no grandchild dispatched");
    // the leaf ends on its own (idle) and keeps a running task its run started
    release("child");
    await waitForTerminal(db, leaf.conversationId, 1, 30_000);
    const task = await finishChildTask(conv, leaf, { finish: false });
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${mid.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const stopped = await taskFinish(leaf.conversationId, task.taskId);
    expect(stopped.payload).toMatchObject({ stoppedBy: "subagent_end" });
    await waitForTerminal(db, mid.conversationId, 1, 30_000);
    await new Promise((r) => setTimeout(r, 500));
    await expectNoWake(leaf.conversationId, 1);
    await expectNoWake(mid.conversationId, 1);
  });

  it("stopping an idle agent with a running descendant also stops its own background tasks", async () => {
    const before = arrivals("child");
    const conv = await dispatched("SCENARIO deep idle mid");
    const [mid] = await childRunsOf(db, conv);
    if (!mid) throw new Error("no child dispatched");
    // the mid dispatched a held leaf and ended its run: idle, its leaf still running
    await waitForTerminal(db, mid.conversationId, 1, 30_000);
    const [leaf] = await childRunsOf(db, mid.conversationId);
    if (!leaf) throw new Error("no grandchild dispatched");
    await waitFor(async () => arrivals("child") > before, 20_000, "the leaf held");
    const task = await finishChildTask(conv, mid, { finish: false });
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${mid.conversationId}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    const stopped = await taskFinish(mid.conversationId, task.taskId);
    expect(stopped.payload).toMatchObject({ stoppedBy: "subagent_end" });
    await waitFor(
      async () =>
        (await deliveriesOf(mid.conversationId)).find((d) => d.payload.childRunId === leaf.runId) ??
        null,
      30_000,
      "the leaf's aborted delivery",
    );
    await new Promise((r) => setTimeout(r, 500));
    await expectNoWake(mid.conversationId, 1);
  });

  it("deleting the root stops its sub-agents' background tasks as a deletion", async () => {
    const before = arrivals("child");
    const conv = await dispatched("SCENARIO hold deleted");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waitFor(async () => arrivals("child") > before, 20_000, "the child held");
    const task = await finishChildTask(conv, child, { finish: false });
    const res = await owner({
      method: "DELETE",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}`,
    });
    expect(res.statusCode, res.body).toBe(204);
    const stopped = await taskFinish(child.conversationId, task.taskId);
    expect(stopped.payload).toMatchObject({ stoppedBy: "deletion" });
  });

  it("unpausing the root wakes the sub-agents whose wake it held", async () => {
    const conv = await dispatched("SCENARIO quick unpause");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    await waitForTerminal(db, conv, 2, 30_000);
    await sql`UPDATE capybara.conversations SET queue_paused = true, queue_pause_reason = 'run_ended'
      WHERE id = ${conv}`.execute(raw);
    const finished = await finishChildTask(conv, child);
    await expectNoWake(child.conversationId, 1);
    const res = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/queue/resume`,
    });
    expect(res.statusCode, res.body).toBe(202);
    await waitForTerminal(db, child.conversationId, 2, 30_000);
    const wake = (await runRows(child.conversationId))[1] as RunRow;
    expect(Number(wake.trigger_seq)).toBe(finished.seq);
  });
});

/**
 * Starts a background task of the child as its run `child.runId` and, unless `finish` is false,
 * finishes it; the finish event, or (not finished) the task id.
 */
async function finishChildTask(
  conv: string,
  child: { conversationId: string; runId: string },
  opts: { finish: false },
): Promise<{ taskId: string }>;
async function finishChildTask(
  conv: string,
  child: { conversationId: string; runId: string },
): Promise<ConversationEvent>;
async function finishChildTask(
  conv: string,
  child: { conversationId: string; runId: string },
  opts: { finish?: boolean } = {},
): Promise<ConversationEvent | { taskId: string }> {
  const store = k.app.get(BackgroundTaskStore);
  const id = newTaskId();
  const startedAt = new Date(Date.now() - 5_000);
  await store.insert({
    id,
    orgId,
    conversationId: child.conversationId,
    sandboxConversationId: conv,
    // a row without a process: no instance to address
    deviceId: null,
    runId: child.runId,
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
  if (opts.finish === false) return { taskId: id };
  const task = await store.get(id);
  if (!task) throw new Error("task row missing");
  expect(
    await k.app
      .get(BackgroundTaskFinisher)
      .finish(task, { status: "completed", exitCode: 0 }, "out\n", false),
  ).toBe(true);
  const finished = (await eventsOf(db, child.conversationId)).find(
    (e) => e.type === "background_task_finished" && e.payload.taskId === id,
  );
  if (!finished) throw new Error("no finish in the child's log");
  return finished;
}
