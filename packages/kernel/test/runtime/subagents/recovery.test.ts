import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionContext } from "@capybara-hq/plugin-sdk";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent, EventPayload } from "../../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../../src/db/kernel-schema.js";
import { createDb } from "../../../src/db/pool.js";
import { KernelConfigService } from "../../../src/infra/config/kernel-config.service.js";
import { KERNEL_BUS } from "../../../src/infra/tokens.js";
import { RUN_QUOTA_PREFIX } from "../../../src/runtime/quota.js";
import { RUN_QUEUE_NAME, SUBAGENT_RUN_QUEUE_NAME } from "../../../src/runtime/run-queue.js";
import { resumeJobId, Waits } from "../../../src/runtime/waits.js";
import { type ScriptRule, scriptRules } from "../../fixtures/plugins/model-script/index.js";
import { eventLogFor, legacyDbFor } from "../../helpers/conversations.js";
import { truncateTables } from "../../helpers/db.js";
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
import {
  backdateRun,
  type ChildRun,
  childRunsOf,
  dropChildJobs,
  finishChildByHand,
  runStatus,
} from "../../helpers/subagents.js";

/**
 * Background sub-agents (agent map spec §5.4, §10) recover from lost work: a child stopped outside
 * its worker delivers its finish at once, and the wait sweep re-enqueues a lost child job, fails an
 * orphaned child run and writes a finish delivery its finisher never wrote, each once. One kernel;
 * the sub-agent queue is paused by the test whenever it needs a child to stay queued.
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

const RULES: ScriptRule[] = [
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
  root = await mkdtemp(join(tmpdir(), "cap-subagents-recovery-"));
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    ),
  );
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redisClient() });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redisClient() });
}, 180_000);

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
        tools: ["Agent", "Write"].map((name) => ({ kind: "builtin", name })),
        toolPolicies: { Write: "ask" },
      },
      visibility: "org",
    },
  });
  expect(res.statusCode, res.body).toBe(201);
  agentId = (res.json() as { agent: { id: string } }).agent.id;
});

afterEach(async () => {
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
  }, 60_000);

  it("stopping a queued child no worker holds delivers aborted without the sweep", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    await dropChildJobs(subQueue, [child.conversationId]);
    await backdateRun(db, child.runId);
    const res = await abortChild(child.conversationId);
    expect(res.statusCode, res.body).toBe(202);
    const d = await deliveredOnce(conv);
    expect(await runStatus(db, child.runId)).toBe("aborted");
    expect(d.payload).toMatchObject({ status: "aborted", abortedBy: "user" });
  }, 60_000);
});

describe("recovery by the wait sweep", () => {
  it("crash after the dispatch commit, before the enqueue: the sweep re-enqueues, no second dispatch", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    expect(await dropChildJobs(subQueue, [child.conversationId])).toBe(1);
    await subQueue.resume();
    await sleep(300);
    expect(await runStatus(db, child.runId)).toBe("queued");
    // within the grace period nothing happens
    expect((await k.app.get(Waits).sweep()).requeued).toBe(0);
    await backdateRun(db, child.runId);
    expect((await k.app.get(Waits).sweep()).requeued).toBe(1);
    const d = await deliveredOnce(conv);
    expect(d.payload).toMatchObject({ status: "completed", text: "child ok" });
    expect(await childRunsOf(db, conv)).toEqual([{ ...child, status: "completed" }]);
    expect(ofType(await eventsOf(db, conv), "subagent_dispatched")).toHaveLength(1);
  }, 60_000);

  it("a running child without job or lock: the sweep fails it run.orphaned and delivers the failure", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    await dropChildJobs(subQueue, [child.conversationId]);
    await db
      .updateTable("runs")
      .set({ status: "running", started_at: new Date() })
      .where("id", "=", child.runId)
      .execute();
    await backdateRun(db, child.runId);
    const out = await k.app.get(Waits).sweep();
    expect(out.orphaned).toBe(1);
    const cev = await eventsOf(db, child.conversationId);
    expect(ofType(cev, "run_failed")[0]?.payload.error.code).toBe("run.orphaned");
    const d = await deliveredOnce(conv);
    expect(d.payload).toMatchObject({
      status: "failed",
      errorCode: "run.orphaned",
      text: "The run was lost and will not continue",
    });
  }, 60_000);

  it("child finisher crash: the sweep writes the missing finished delivery, once", async () => {
    const { conv, child } = await startPaused("SCENARIO one");
    await dropChildJobs(subQueue, [child.conversationId]);
    await finishChildByHand(
      db,
      eventLogFor(db, k.app.get<ExtensionContext["bus"]>(KERNEL_BUS)),
      child,
      "finished alone",
    );
    await sleep(300);
    expect(await finished(conv)).toEqual([]);
    // within the grace period nothing happens
    expect((await k.app.get(Waits).sweep()).delivered).toBe(0);
    await backdateRun(db, child.runId);
    expect((await k.app.get(Waits).sweep()).delivered).toBe(1);
    const ds = await finished(conv);
    expect(ds.map((d) => d.payload.text)).toEqual(["finished alone"]);
    expect(ofType(await eventsOf(db, conv), "subagent_finished")).toHaveLength(1);
    // idempotent: a second sweep finds nothing
    expect((await k.app.get(Waits).sweep()).delivered).toBe(0);
    expect(await finished(conv)).toHaveLength(1);
  }, 60_000);

  it("a parent set queued by a resume whose enqueue never happened is enqueued by the sweep (final review m8)", async () => {
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
    // the approval is decided and Waits.resume's update committed, then its replica died before
    // queue.add
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
    expect((await k.app.get(Waits).sweep()).requeued).toBe(0);
    await backdateRun(db, runId);
    expect((await k.app.get(Waits).sweep()).requeued).toBe(1);
    await waitForTerminal(db, conv, 1, 20_000);
    expect(finalText(await eventsOf(db, conv))).toBe("direct done");
  }, 60_000);

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
  }, 60_000);
});
