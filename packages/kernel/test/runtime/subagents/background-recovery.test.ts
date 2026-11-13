import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { normalizeStoredDefinition } from "../../../src/agents/definition.js";
import { EventLog } from "../../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { LockedIntervalScheduler } from "../../../src/infra/schedule/locked-interval.js";
import { KERNEL_BUS } from "../../../src/infra/tokens.js";
import { ModelPurposesService } from "../../../src/models/purposes.js";
import { ProviderRegistry } from "../../../src/runtime/providers.js";
import { RUN_QUOTA_PREFIX } from "../../../src/runtime/quota.js";
import { RUN_ORPHAN_CHECK_JOB, RunOrphanCheck } from "../../../src/runtime/run-orphan-check.job.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { SubagentDeliveries } from "../../../src/runtime/subagents/deliveries.js";
import { type DispatchDeps, dispatchSubagent } from "../../../src/runtime/subagents/dispatch.js";
import { resumeJobId } from "../../../src/runtime/waits.js";
import { agentStartedText } from "../../../src/tools/builtins/agent.js";
import {
  openBarrier,
  type ScriptRule,
  scriptRules,
} from "../../fixtures/plugins/model-script/index.js";
import { eventLogFor, legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
import { onlyBuiltins } from "../../helpers/disabled-tools.js";
import { accountsFor } from "../../helpers/identity.js";
import { MODEL_FAKE } from "../../helpers/model-plugins.js";
import {
  createConv,
  createOrg,
  eventsOf,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  type TestKernel,
  waitFor,
  waitForRunJobDone,
  waitForTerminal,
} from "../../helpers/runs.js";
import { webCaller } from "../../helpers/step-context.js";
import {
  backdateRun,
  type ChildRun,
  childRunsOf,
  commitDispatchOwing,
  dropChildJobs,
  finishChildByHand,
  runStatus,
} from "../../helpers/subagents.js";

/**
 * Background sub-agents (agent map spec §4.1, §4.5, §5.4, §10): `Agent` dispatches in the
 * background (its result is immediate, the parent run goes on and may end while the child works,
 * the child's finish reaches the parent as `subagent_finished` plus one `finished`
 * `subagent_delivery`), and that work recovers when it is lost: a child stopped outside its
 * worker delivers its finish at once, and the `run-orphan-check` owes a job the queue lost again,
 * once. One kernel, whose own tick of the check is stopped (the tests call it); the sub-agent
 * queue is paused by the test whenever it needs a child to stay queued.
 *
 * The two suites share the kernel and one model-script rule list (background's parent rule is
 * narrowed to its own scenario so recovery's stays unambiguous), and the kernel runs with
 * `wakeOnBackgroundTask: false` so a delivery never wakes a parent here
 * (subagents/wake.test.ts covers waking).
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const agentCall = (prompt: string) => ({
  name: "Agent",
  input: { description: "Task", prompt },
});

const BACKGROUND_RULES: ScriptRule[] = [
  // the child holds at the barrier until the test opens it
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "bg-hold" },
    reply: { text: "child reply", barrier: { name: "hold", count: 99, timeoutMs: 30_000 } },
  },
  {
    when: { lastUserIncludes: "SCENARIO background", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Agent", input: { description: "Held task", prompt: "bg-hold: do it" } }],
    },
  },
  {
    // narrowed to its own scenario so the recovery suite's parent rule stays unambiguous
    when: {
      lastUserIncludes: "SCENARIO background",
      lastToolResultIncludes: "running in the background",
    },
    reply: { text: "parent went on" },
  },
];

const RECOVERY_RULES: ScriptRule[] = [
  {
    when: { systemIncludes: CHILD, lastUserIncludes: "task-write", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/c.txt", content: "c" } }],
    },
  },
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO write", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-write")] },
  },
  {
    when: { lastUserIncludes: "SCENARIO one", assistantTurns: 0 },
    reply: { toolCalls: [agentCall("task-one")] },
  },
  {
    // the parent's own call that asks (Write: ask): it waits on the approval
    when: { lastUserIncludes: "SCENARIO direct", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/p.txt", content: "p" } }],
    },
  },
  {
    when: { lastUserIncludes: "SCENARIO direct", assistantTurns: 1 },
    reply: { text: "direct done" },
  },
  { when: { lastToolResultIncludes: "in the background" }, reply: { text: "parent done" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let subQueue: Queue;
let runQueue: Queue;
/** The clients the queues above use (quit in afterAll, before Redis stops). */
const redisClients: Redis[] = [];
const redisClient = (): Redis => {
  const c = new Redis(rd.url);
  redisClients.push(c);
  return c;
};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-subagents-bg-recovery-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: {
          "model-script": { rules: [...BACKGROUND_RULES, ...RECOVERY_RULES] },
          "sandbox-fake": { root },
        },
        // these tests are about dispatch and recovery, not waking (subagents/wake.test.ts): a
        // parent woken by its children's deliveries would race their last-reply assertions
        runtime: { wakeOnBackgroundTask: false },
      },
    ),
  );
  k.app.get(LockedIntervalScheduler).stop(RUN_ORPHAN_CHECK_JOB);
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redisClient() });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redisClient() });
});

afterAll(async () => {
  await subQueue?.close();
  await runQueue?.close();
  await Promise.all(redisClients.splice(0).map((c) => c.quit()));
  await k?.close();
  await destroyDb?.();
  await Promise.all([pgc?.stop(), rd?.stop()]);
  if (root) await rm(root, { recursive: true, force: true });
});

let owner: Req;
let ownerId: string;
let orgId: string;
let agentId: string;

beforeEach(async () => {
  await subQueue.resume();
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts",
  );
  scriptRules([]);
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
        disabledTools: onlyBuiltins(["Agent", "Write"].map((name) => ({ kind: "builtin", name }))),
        toolPolicies: { Write: "ask" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
  // a held child of a failed test goes on, so the next test's truncation finds no running work
  openBarrier("hold");
  await subQueue.resume();
  scriptRules([]);
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};

const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const finalText = (events: ConversationEvent[]) =>
  ofType(events, "assistant_message")
    .at(-1)
    ?.payload.content.flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("");

/** Starts the scenario and waits for the parent's first run to end. */
async function background(): Promise<{ conv: string; events: ConversationEvent[] }> {
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, "SCENARIO background");
  await waitForTerminal(db, conv, 1, 30_000);
  return { conv, events: await eventsOf(db, conv) };
}

const finished = async (conv: string) =>
  ofType(await eventsOf(db, conv), "subagent_delivery").filter(
    (d) => d.payload.kind === "finished",
  );

/** Waits for the parent's finished delivery of a child; the parent log's deliveries after. */
async function deliveredOnce(conv: string): Promise<Ev<"subagent_delivery">> {
  const [d] = await waitFor(
    async () => {
      const ds = await finished(conv);
      return ds.length > 0 ? ds : null;
    },
    20_000,
    "the finished delivery",
  );
  return d as Ev<"subagent_delivery">;
}

/**
 * Starts `text` in a new conversation with the sub-agent queue paused, so its child stays queued;
 * returns once the parent's run ended (it never waits on the child) and the child is dispatched.
 */
async function startPaused(text: string): Promise<{ conv: string; child: ChildRun }> {
  await subQueue.pause();
  const conv = await createConv(owner, orgId, agentId);
  await postMessage(owner, orgId, conv, text);
  await waitForTerminal(db, conv, 1, 20_000);
  const [child] = await childRunsOf(db, conv);
  if (!child) throw new Error("no child dispatched");
  return { conv, child };
}

const abortChild = (child: string) =>
  owner({ method: "POST", url: `/api/v1/orgs/${orgId}/conversations/${child}/abort` });

describe("background Agent", () => {
  it("Agent returns the agentId at once and the parent run goes on", async () => {
    const { conv, events } = await background();
    expect(finalText(events)).toBe("parent went on");
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    const result = ofType(events, "tool_result").find((r) => r.payload.toolKey === "Agent");
    expect(result?.payload).toMatchObject({
      content: agentStartedText(child.conversationId),
      isError: false,
    });
    // the result was written with the dispatch, before the child ran: the step never waited
    const dispatched = ofType(events, "subagent_dispatched")[0];
    expect(dispatched?.seq).toBeLessThan(result?.seq ?? 0);
    expect(ofType(events, "run_started")).toHaveLength(1);
    const parentRun = await db
      .selectFrom("runs")
      .select(["status", "waited_ms"])
      .where("conversation_id", "=", conv)
      .executeTakeFirstOrThrow();
    expect(parentRun.status).toBe("completed");
    expect(Number(parentRun.waited_ms)).toBe(0);
    // `tool.called` is audited in the dispatch transaction
    const audits = await db
      .selectFrom("audit_events")
      .select(["action", "detail"])
      .where("action", "=", "tool.called")
      .execute();
    expect(audits.map((a) => (a.detail as { toolKey: string }).toolKey)).toEqual(["Agent"]);
  });

  it("the parent run can finish while the child runs, and the child keeps running", async () => {
    const { conv } = await background();
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    // the parent is done; its child still works (held at the barrier), nothing stopped it
    await waitFor(
      async () => ((await runStatus(db, child.runId)) === "running" ? true : null),
      20_000,
      "the child running",
    );
    await new Promise((r) => setTimeout(r, 500));
    expect(await runStatus(db, child.runId)).toBe("running");
    openBarrier("hold");
    await waitForTerminal(db, child.conversationId, 1, 30_000);
    expect(await runStatus(db, child.runId)).toBe("completed");
  });

  it("a child finish appends subagent_finished and a finished delivery with the final reply when it never handed back", async () => {
    const { conv } = await background();
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    openBarrier("hold");
    const delivery = await waitFor(
      async () => ofType(await eventsOf(db, conv), "subagent_delivery")[0] ?? null,
      30_000,
      "the finished delivery",
    );
    expect(delivery.payload).toEqual({
      subagentId: child.conversationId,
      childRunId: child.runId,
      description: "Held task",
      kind: "finished",
      status: "completed",
      text: "child reply",
      triggerAccountId: ownerId,
    });
    expect(delivery.runId).toBeNull();
    const events = await eventsOf(db, conv);
    const finished = ofType(events, "subagent_finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload).toMatchObject({
      subagentId: child.conversationId,
      childRunId: child.runId,
      status: "completed",
    });
    // the display event comes first, in the same transaction
    expect(finished[0]?.seq).toBe(delivery.seq - 1);
  });
});

describe("finish deliveries", () => {
  /** A `running` parent run of a new conversation, and the tool step context of its step 1. */
  async function parentRun() {
    const conv = await createConv(owner, orgId, agentId);
    const runId = randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: runId,
        conversation_id: conv,
        status: "running",
        agent_version: 1,
        trigger_account_id: ownerId,
        trigger_seq: 0,
      })
      .execute();
    const v = await db
      .selectFrom("agent_versions")
      .select("definition")
      .where("agent_id", "=", agentId)
      .where("version", "=", 1)
      .executeTakeFirstOrThrow();
    const ctx = {
      orgId,
      conversationId: conv,
      runId,
      step: 1,
      agentId,
      agentVersion: 1,
      agent: normalizeStoredDefinition(v.definition),
      accountId: ownerId,
      ...webCaller(ownerId),
      signal: new AbortController().signal,
    };
    return { conv, runId, ctx };
  }

  const deps = (): DispatchDeps => ({
    db,
    eventLog: k.app.get(EventLog),
    purposes: k.app.get(ModelPurposesService),
    registry: k.app.get(ProviderRegistry),
    config: { get: () => k.app.get(KernelConfigService).get() },
    // the children are finished by hand (or not at all) here: no run job is owed, none runs
    owe: async () => true,
    log: { error: () => {}, warn: () => {} },
    commitDispatch: commitDispatchOwing(k.app, k.app.get(EventLog), async () => true),
  });

  it("idempotent finish: two finishers write one delivery", async () => {
    const { conv, ctx } = await parentRun();
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Twice", prompt: "finish twice" },
    });
    if (out.kind !== "dispatched") throw new Error("not dispatched");
    await db
      .updateTable("runs")
      .set({ status: "running" })
      .where("id", "=", out.childRunId)
      .execute();
    await finishChildByHand(
      db,
      eventLogFor(db, k.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
      { conversationId: out.childConversationId, runId: out.childRunId },
      "by hand",
    );
    const deliveries = k.app.get(SubagentDeliveries);
    await Promise.all([
      deliveries.childFinished(out.childRunId),
      deliveries.childFinished(out.childRunId),
    ]);
    await deliveries.childFinished(out.childRunId);
    const events = await eventsOf(db, conv);
    const delivered = ofType(events, "subagent_delivery");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.payload).toMatchObject({ kind: "finished", text: "by hand" });
    expect(ofType(events, "subagent_finished")).toHaveLength(1);
  });

  it("a fork invocation's child is not delivered", async () => {
    const { conv, ctx } = await parentRun();
    const out = await dispatchSubagent(deps(), {
      ctx,
      callId: "c1",
      input: { description: "Fork", prompt: "a fork" },
    });
    if (out.kind !== "dispatched") throw new Error("not dispatched");
    await db
      .updateTable("subagent_dispatches")
      .set({ for_skill: true })
      .where("child_run_id", "=", out.childRunId)
      .execute();
    await finishChildByHand(
      db,
      eventLogFor(db, k.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
      { conversationId: out.childConversationId, runId: out.childRunId },
      "fork reply",
    );
    await k.app.get(SubagentDeliveries).childFinished(out.childRunId);
    expect(ofType(await eventsOf(db, conv), "subagent_delivery")).toEqual([]);
  });
});

describe("a child stopped outside its worker delivers its finish at once", () => {
  it("stopping a child that waits on an approval delivers aborted, by the user", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO write");
    await waitForTerminal(db, conv, 1, 20_000);
    const [child] = await childRunsOf(db, conv);
    if (!child) throw new Error("no child dispatched");
    await waitFor(
      async () => (await runStatus(db, child.runId)) === "waiting",
      20_000,
      "child waiting on its approval",
    );
    const res = await abortChild(child.conversationId);
    expect(res.statusCode, res.body).toBe(202);
    const d = await deliveredOnce(conv);
    expect(d.payload).toMatchObject({
      subagentId: child.conversationId,
      status: "aborted",
      abortedBy: "user",
      text: "",
      triggerAccountId: ownerId,
    });
    expect(ofType(await eventsOf(db, conv), "subagent_finished")[0]?.payload.status).toBe(
      "aborted",
    );
  });

  it("stopping a queued child whose job the queue lost: re-added by the check, it ends aborted", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    // a queued run is never stopped as an orphan: the stop is broadcast and marked
    const res = await abortChild(child.conversationId);
    expect(res.statusCode, res.body).toBe(202);
    expect(await runStatus(db, child.runId)).toBe("queued");
    expect(await k.app.get(RunOrphanCheck).check()).toEqual({
      runningRepaired: 0,
      queuedReadded: 1,
    });
    await subQueue.resume();
    const d = await deliveredOnce(conv);
    expect(await runStatus(db, child.runId)).toBe("aborted");
    expect(d.payload).toMatchObject({ status: "aborted", abortedBy: "user" });
  });
});

describe("recovery by the run-orphan-check", () => {
  it("a child whose job the queue lost: the check owes it again once, no second dispatch", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    expect(await dropChildJobs(subQueue, [child.conversationId])).toBe(1);
    await subQueue.resume();
    await sleep(300);
    expect(await runStatus(db, child.runId)).toBe("queued");
    const check = () => k.app.get(RunOrphanCheck).check();
    // queued for under a minute: nothing happens
    expect((await check()).queuedReadded).toBe(0);
    await backdateRun(db, child.runId);
    expect((await check()).queuedReadded).toBe(1);
    const d = await deliveredOnce(conv);
    expect(d.payload).toMatchObject({ status: "completed", text: "child ok" });
    expect(await childRunsOf(db, conv)).toEqual([{ ...child, status: "completed" }]);
    expect(ofType(await eventsOf(db, conv), "subagent_dispatched")).toHaveLength(1);
  });

  it("a parent queued by a resume whose job the queue lost is owed again under its resume job id", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO direct");
    const approval = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select(["id", "run_id"])
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      20_000,
      "the parent's approval",
    );
    const runId = approval.run_id;
    await waitFor(async () => (await runStatus(db, runId)) === "waiting", 20_000, "parent waiting");
    await waitForRunJobDone(db, runQueue, runId);
    // the approval is decided and the resume committed with its job owed; then the queue lost the
    // job (the outbox row is gone, the job never reached BullMQ)
    await db
      .updateTable("approvals")
      .set({ status: "approved", scope: "once", decided_by: ownerId, decided_at: new Date() })
      .where("id", "=", approval.id)
      .execute();
    await db
      .updateTable("runs")
      .set({
        status: "queued",
        queued_at: new Date(),
        waiting_since: null,
        wait_expires_at: null,
        job_id: resumeJobId(conv, approval.id),
      })
      .where("id", "=", runId)
      .execute();
    const check = () => k.app.get(RunOrphanCheck).check();
    expect((await check()).queuedReadded).toBe(0);
    await backdateRun(db, runId);
    expect((await check()).queuedReadded).toBe(1);
    await waitForTerminal(db, conv, 1, 20_000);
    expect(finalText(await eventsOf(db, conv))).toBe("direct done");
  });

  it("a stopped child still queued ends without an org run slot and never starts (final review m7)", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    // every org run slot is taken
    const redis = redisClient();
    const key = `${RUN_QUOTA_PREFIX}${orgId}`;
    try {
      const n = k.app.get(KernelConfigService).get().runtime.orgConcurrency;
      for (let i = 0; i < n; i++) await redis.zadd(key, Date.now() + 600_000, `busy-${i}`);
      const res = await abortChild(child.conversationId);
      expect(res.statusCode, res.body).toBe(202);
      await subQueue.resume();
      await waitFor(
        async () => (await runStatus(db, child.runId)) === "aborted",
        20_000,
        "child aborted while the quota is full",
      );
      const cev = await eventsOf(db, child.conversationId);
      expect(ofType(cev, "run_started")).toEqual([]);
      expect(ofType(cev, "run_aborted")[0]?.payload).toMatchObject({ byAccountId: ownerId });
    } finally {
      await redis.del(key);
    }
    expect((await deliveredOnce(conv)).payload).toMatchObject({
      status: "aborted",
      abortedBy: "user",
    });
  });
});
