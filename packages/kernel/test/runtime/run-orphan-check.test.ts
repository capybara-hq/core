import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AdminOverviewService } from "../../src/admin/overview.service.js";
import { EventLog } from "../../src/conversations/event-log.js";
import type { ConversationEvent, EventPayload } from "../../src/conversations/events.js";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { LockedIntervalScheduler } from "../../src/infra/schedule/locked-interval.js";
import { createLogger } from "../../src/log.js";
import { ConversationLock } from "../../src/runtime/conversation-lock.js";
import { QUEUE_LOST_JOBS_KEY } from "../../src/runtime/queue-lost-jobs.js";
import { RunFinish } from "../../src/runtime/run-finish.js";
import { RUN_ORPHAN_CHECK_JOB, RunOrphanCheck } from "../../src/runtime/run-orphan-check.job.js";
import { RUN_QUEUE_NAME, runJobId, SUBAGENT_RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import { scriptRules } from "../fixtures/plugins/model-script/index.js";
import { legacyDbFor } from "../helpers/conversations.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor } from "../helpers/identity.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
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
  waitForRunJobDone,
  waitForTerminal,
} from "../helpers/runs.js";
import {
  backdateRun,
  type ChildRun,
  childRunsOf,
  dropChildJobs,
  runStatus,
} from "../helpers/subagents.js";

/**
 * Transactional outbox spec §6 "Replica death during a run", "Reads never write" and §8.3: the one
 * repair of a run nobody runs is the `run-orphan-check` (a locked interval, worker role). A run in
 * its state for over a minute with neither a BullMQ job nor a conversation lock holder is
 * - `running` (its replica died, BullMQ dropped the job): failed `run.orphaned`, a sub-agent's
 *   failure delivered to its parent at once, the conversation's next run started;
 * - `queued` (the queue lost its job, which the outbox makes impossible): a canary, logged as an
 *   error and shown in the admin overview, and its job owed again.
 * Reading a conversation never changes run state. One kernel (api and worker) whose own tick of
 * the check is stopped: the tests call `check()` and assert what it did.
 */

const fixture = (name: string) =>
  fileURLToPath(new URL(`../fixtures/plugins/${name}/index.ts`, import.meta.url));
const MODEL_SCRIPT = fixture("model-script");
const SANDBOX_FAKE = fixture("sandbox-fake");

const CHILD = "You are a sub-agent";
const RULES = [
  { when: { systemIncludes: CHILD }, reply: { text: "child ok" } },
  {
    when: { lastUserIncludes: "SCENARIO child", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Agent", input: { description: "Task", prompt: "task-one" } }],
    },
  },
  {
    // the run's own call that asks (Write: ask): it waits on the approval
    when: { lastUserIncludes: "SCENARIO ask", assistantTurns: 0 },
    reply: {
      toolCalls: [{ name: "Write", input: { file_path: "/workspace/p.txt", content: "p" } }],
    },
  },
  { when: {}, reply: { text: "ok" } },
];

let pgc: TestContainer;
let rd: TestContainer;
let db: KernelSchemaDb;
let destroyDb: () => Promise<void>;
let k: TestKernel;
let root: string;
let subQueue: Queue;
let runQueue: Queue;
let redis: Redis;
/** The error lines the kernel logged (the canary's line among them). */
const errors: Record<string, unknown>[] = [];

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const raw = createDb(pgc.url, 3);
  db = legacyDbFor(raw);
  destroyDb = () => raw.destroy();
  root = await mkdtemp(join(tmpdir(), "cap-run-orphan-check-"));
  const logger = createLogger("error", {
    write: (line) => {
      errors.push(JSON.parse(line) as Record<string, unknown>);
    },
  });
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api", "worker"],
        extensions: [MODEL_FAKE, MODEL_SCRIPT, SANDBOX_FAKE],
        extensionConfig: { "model-script": { rules: RULES }, "sandbox-fake": { root } },
      },
    ),
    { logger },
  );
  // the tests call check() themselves and assert what it repaired
  k.app.get(LockedIntervalScheduler).stop(RUN_ORPHAN_CHECK_JOB);
  redis = new Redis(rd.url);
  subQueue = new Queue(SUBAGENT_RUN_QUEUE_NAME, { connection: redis.duplicate() });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redis.duplicate() });
}, 180_000);

afterAll(async () => {
  await subQueue?.close();
  await runQueue?.close();
  redis?.disconnect();
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
  await runQueue.resume();
  await redis.del(QUEUE_LOST_JOBS_KEY);
  await truncateTables(
    db,
    "capybara.audit_events, capybara.subagent_dispatches, capybara.sandboxes, capybara.approvals, capybara.questions, capybara.tool_outputs, capybara.conversation_events, capybara.runs, capybara.conversations, capybara.agent_versions, capybara.agent_members, capybara.agents, capybara.memberships, capybara.orgs, capybara.sessions, capybara.local_passwords, capybara.identities, capybara.accounts, capybara.outbox",
  );
  scriptRules([]);
  errors.length = 0;
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
  await subQueue.resume();
  await runQueue.resume();
});

type Ev<T extends ConversationEvent["type"]> = ConversationEvent & {
  type: T;
  payload: EventPayload<T>;
};
const ofType = <T extends ConversationEvent["type"]>(events: ConversationEvent[], type: T) =>
  events.filter((e): e is Ev<T> => e.type === type);

const check = () => k.app.get(RunOrphanCheck).check();

/** The conversation's runs, oldest first. */
const runsOf = (conv: string) =>
  db
    .selectFrom("runs")
    .select(["id", "status", "trigger_seq"])
    .where("conversation_id", "=", conv)
    .orderBy("created_at")
    .execute();

/**
 * A chat conversation with an unconsumed message and a `running` run for it that nobody runs: no
 * job, no lock holder (its replica died), in its state for five minutes. Written by hand, so no
 * worker ever sees it.
 */
async function runningOrphan(): Promise<{ conv: string; runId: string; seq: number }> {
  const conv = await createConv(owner, orgId, agentId);
  const [msg] = await k.app.get(EventLog).append(conv, [
    {
      type: "user_message",
      payload: { content: [{ type: "text", text: "lost" }], authorAccountId: ownerId },
    },
  ]);
  const seq = msg?.seq as number;
  const runId = randomUUID();
  await db
    .insertInto("runs")
    .values({
      id: runId,
      conversation_id: conv,
      status: "running",
      agent_version: 1,
      trigger_account_id: ownerId,
      trigger_seq: seq,
      started_at: sql<Date>`now()`,
    })
    .execute();
  await backdateRun(db, runId);
  return { conv, runId, seq };
}

describe("run-orphan-check", () => {
  it("a worker killed inside onFailed leaves a running run that the check fails with run.orphaned and reports to its parent", async () => {
    // a background child whose job failed (stalls ran out) and whose replica died inside onFailed:
    // the run stays `running`, BullMQ removed the job (removeOnFail), nobody holds the lock
    await subQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO child");
    await waitForTerminal(db, conv, 1, 20_000);
    const [child] = (await childRunsOf(db, conv)) as [ChildRun];
    expect(await dropChildJobs(subQueue, [child.conversationId])).toBe(1);
    await db
      .updateTable("runs")
      .set({ status: "running", started_at: sql<Date>`now()` })
      .where("id", "=", child.runId)
      .execute();
    await backdateRun(db, child.runId);

    expect(await check()).toEqual({ runningRepaired: 1, queuedReadded: 0 });
    expect(await runStatus(db, child.runId)).toBe("failed");
    const failed = ofType(await eventsOf(db, child.conversationId), "run_failed");
    expect(failed.map((e) => e.payload.error.code)).toEqual(["run.orphaned"]);
    // delivered by the check itself, not by the deliver-to-parent backstop 30 s later
    const delivered = ofType(await eventsOf(db, conv), "subagent_delivery").filter(
      (d) => d.payload.kind === "finished",
    );
    expect(delivered.map((d) => d.payload)).toEqual([
      expect.objectContaining({
        subagentId: child.conversationId,
        status: "failed",
        errorCode: "run.orphaned",
        text: "The run was lost and will not continue",
      }),
    ]);
    // once: a second pass finds nothing
    expect(await check()).toEqual({ runningRepaired: 0, queuedReadded: 0 });
  }, 60_000);

  it("a running chat run nobody runs is failed once, its checkpoints dropped, and the waiting message starts the next run", async () => {
    const { conv, runId, seq } = await runningOrphan();
    await db
      .insertInto("lg_checkpoints")
      .values({
        thread_id: runId,
        checkpoint_ns: "",
        checkpoint_id: "cp-1",
        checkpoint_type: "json",
        checkpoint: Buffer.from("{}"),
        metadata_type: "json",
        metadata: Buffer.from("{}"),
      })
      .execute();
    // a message that arrived while the run was "running" waits for it
    const next = await postMessage(owner, orgId, conv, "after");
    expect((await runsOf(conv)).map((r) => r.status)).toEqual(["running"]);

    expect(await check()).toEqual({ runningRepaired: 1, queuedReadded: 0 });
    const evs = await eventsOf(db, conv);
    const terminal = evs.filter((e) => e.runId === runId && e.type.startsWith("run_"));
    expect(
      terminal.map((e) => [e.type, (e.payload as { error?: { code: string } }).error?.code]),
    ).toEqual([["run_failed", "run.orphaned"]]);
    expect(
      await db
        .selectFrom("lg_checkpoints")
        .select("thread_id")
        .where("thread_id", "=", runId)
        .execute(),
    ).toEqual([]);
    // the next run started from the waiting message and answered it
    const [, second] = await waitForTerminal(db, conv, 2, 20_000);
    expect(second?.type).toBe("run_finished");
    const runs = await runsOf(conv);
    expect(runs.map((r) => [r.status, Number(r.trigger_seq)])).toEqual([
      ["failed", seq],
      ["completed", next],
    ]);
  }, 60_000);

  it("a queued run whose job was removed from Redis is re-added and reported", async () => {
    await runQueue.pause();
    const conv = await createConv(owner, orgId, agentId);
    const seq = await postMessage(owner, orgId, conv, "hello");
    const jobId = runJobId(conv, seq);
    const job = await waitFor(() => runQueue.getJob(jobId), 10_000, "the run's job");
    const [run] = await runsOf(conv);
    // Redis lost the job (durability broke): neither in BullMQ nor owed by the outbox
    await job.remove();
    await backdateRun(db, run?.id as string);

    expect(await check()).toEqual({ runningRepaired: 0, queuedReadded: 1 });
    expect(errors.map((e) => e.msg)).toContain("queued run without a job: the queue lost jobs");
    const attention = await k.app.get(AdminOverviewService).attention();
    expect(attention.queue).toEqual([
      { kind: "queue_lost_jobs", count: 1, lastAt: expect.any(String) },
    ]);
    expect(attention.unavailable).toEqual([]);
    // owed again under its own id: the run runs once the queue resumes
    await waitFor(() => runQueue.getJob(jobId), 10_000, "the run's job re-added");
    await runQueue.resume();
    const [t] = await waitForTerminal(db, conv, 1, 20_000);
    expect(t?.type).toBe("run_finished");
    expect(t?.runId).toBe(run?.id);
    expect(await check()).toEqual({ runningRepaired: 0, queuedReadded: 0 });
  }, 60_000);

  it("leaves alone a run with its job, with a lock holder, in its state for under a minute, or whose job is still owed", async () => {
    // queued with its job (the run queue is paused)
    await runQueue.pause();
    const withJob = await createConv(owner, orgId, agentId);
    const seq = await postMessage(owner, orgId, withJob, "hello");
    await waitFor(() => runQueue.getJob(runJobId(withJob, seq)), 10_000, "the run's job");
    const [queued] = await runsOf(withJob);
    await backdateRun(db, queued?.id as string);
    // running without a job, but the conversation lock is held (its worker is alive)
    const held = await runningOrphan();
    const lease = await k.app.get(ConversationLock).acquire(held.conv, held.runId);
    expect(lease).not.toBeNull();
    // running without a job or lock, but only for a moment
    const fresh = await runningOrphan();
    await db
      .updateTable("runs")
      .set({ created_at: sql<Date>`now()`, started_at: sql<Date>`now()` })
      .where("id", "=", fresh.runId)
      .execute();
    // queued without a job, but the outbox still owes it (Redis was down)
    const owed = await runningOrphan();
    await db.updateTable("runs").set({ status: "queued" }).where("id", "=", owed.runId).execute();
    await db
      .insertInto("outbox")
      .values({
        queue: RUN_QUEUE_NAME,
        job_name: "run",
        job_id: runJobId(owed.conv, owed.seq),
        data: JSON.stringify({ runId: owed.runId, conversationId: owed.conv }),
        org_id: orgId,
        next_attempt_at: sql<Date>`now() + interval '1 hour'`,
      })
      .execute();
    try {
      expect(await check()).toEqual({ runningRepaired: 0, queuedReadded: 0 });
    } finally {
      await lease?.release();
    }
    expect(await runStatus(db, queued?.id as string)).toBe("queued");
    expect(await runStatus(db, held.runId)).toBe("running");
    expect(await runStatus(db, fresh.runId)).toBe("running");
    expect(await runStatus(db, owed.runId)).toBe("queued");
    expect(errors.map((e) => e.msg)).not.toContain("queued run without a job: the queue lost jobs");
  }, 60_000);

  it("reaches an orphan behind a full page of healthy candidates, and skips a dead-lettered job", async () => {
    // 600 queued runs older than the orphan, each with its job still owed (Redis was down): a
    // first page of candidates the check must pass over
    await sql`
      WITH c AS (
        INSERT INTO capybara.conversations (id, org_id, agent_id, account_id, title)
        SELECT gen_random_uuid()::text, ${orgId}, ${agentId}, ${ownerId}, 'Waiting'
        FROM generate_series(1, 600)
        RETURNING id
      ), r AS (
        INSERT INTO capybara.runs
          (id, conversation_id, status, agent_version, trigger_account_id, trigger_seq,
           created_at, queued_at)
        SELECT gen_random_uuid()::text, id, 'queued', 1, ${ownerId}, 1,
          now() - interval '10 minutes', now() - interval '10 minutes'
        FROM c
        RETURNING id, conversation_id
      )
      INSERT INTO capybara.outbox (queue, job_name, job_id, data, org_id, next_attempt_at)
      SELECT ${RUN_QUEUE_NAME}, 'run', 'run-' || conversation_id || '-1',
        jsonb_build_object('runId', id, 'conversationId', conversation_id), ${orgId},
        now() + interval '1 hour'
      FROM r`.execute(db);
    // a queued run whose job the outbox gave up on (dead): the super admin's, not a lost job
    const dead = await runningOrphan();
    await db.updateTable("runs").set({ status: "queued" }).where("id", "=", dead.runId).execute();
    await db
      .insertInto("outbox")
      .values({
        queue: RUN_QUEUE_NAME,
        job_name: "run",
        job_id: runJobId(dead.conv, dead.seq),
        data: JSON.stringify({ runId: dead.runId, conversationId: dead.conv }),
        org_id: orgId,
        attempts: 20,
        dead_at: sql<Date>`now()`,
      })
      .execute();
    // the real orphan, in its state for less long than all of them
    const { runId } = await runningOrphan();
    await db
      .updateTable("runs")
      .set({ started_at: sql<Date>`now() - interval '2 minutes'` })
      .where("id", "=", runId)
      .execute();
    expect(await check()).toEqual({ runningRepaired: 1, queuedReadded: 0 });
    expect(await runStatus(db, runId)).toBe("failed");
    expect(await runStatus(db, dead.runId)).toBe("queued");
    expect(errors.map((e) => e.msg)).not.toContain("queued run without a job: the queue lost jobs");
  }, 60_000);

  it("GET events and opening SSE never change run state", async () => {
    const { conv, runId } = await runningOrphan();
    const jar = cookieJar();
    const r = asUser(k.http, jar);
    const login = await r({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { login: "owner", password: PW },
    });
    expect(login.statusCode).toBe(200);
    for (const url of [
      `/api/v1/orgs/${orgId}/conversations/${conv}/events`,
      `/api/v1/orgs/${orgId}/conversations/${conv}/events?before=end`,
    ]) {
      const res = await r({ method: "GET", url });
      expect(res.statusCode, res.body).toBe(200);
    }
    const ac = new AbortController();
    const res = await fetch(
      `http://127.0.0.1:${k.port}/api/v1/orgs/${orgId}/conversations/${conv}/stream`,
      { headers: { cookie: jar.header() as string }, signal: ac.signal },
    );
    expect(res.status).toBe(200);
    // the stream's catch-up has been read: anything the open did would have happened by now
    const reader = res.body?.getReader();
    await reader?.read();
    ac.abort();
    expect(await runsOf(conv)).toEqual([expect.objectContaining({ id: runId, status: "running" })]);
    expect(ofType(await eventsOf(db, conv), "run_failed")).toEqual([]);
  }, 60_000);

  it("a finished run has no pending waits", async () => {
    const conv = await createConv(owner, orgId, agentId);
    await postMessage(owner, orgId, conv, "SCENARIO ask");
    const approval = await waitFor(
      () =>
        db
          .selectFrom("approvals")
          .select(["id", "run_id"])
          .where("conversation_id", "=", conv)
          .where("status", "=", "pending")
          .executeTakeFirst(),
      20_000,
      "the run's approval",
    );
    await waitFor(
      async () => (await runStatus(db, approval.run_id)) === "waiting",
      20_000,
      "run waiting",
    );
    await waitForRunJobDone(db, runQueue, approval.run_id);
    // the run fails before it suspends (it is still `running`): its terminal transaction cancels
    // the approval it asked for
    await db
      .updateTable("runs")
      .set({ status: "running", waiting_since: null, wait_expires_at: null })
      .where("id", "=", approval.run_id)
      .execute();
    await k.app.get(RunFinish).finish({
      conversationId: conv,
      runId: approval.run_id,
      status: "failed",
      consumed: null,
      event: { type: "run_failed", payload: { error: { code: "test", message: "failed" } } },
    });
    expect(
      await db
        .selectFrom("approvals")
        .select("status")
        .where("run_id", "=", approval.run_id)
        .execute(),
    ).toEqual([{ status: "cancelled" }]);
    const decided = ofType(await eventsOf(db, conv), "approval_decided");
    expect(decided.map((e) => e.payload)).toEqual([
      expect.objectContaining({
        approvalId: approval.id,
        decision: "cancelled",
        byAccountId: null,
      }),
    ]);
    // the cancel comes before the run's terminal event
    const evs = await eventsOf(db, conv);
    const at = (type: string) => evs.findIndex((e) => e.type === type);
    expect(at("approval_decided")).toBeLessThan(at("run_failed"));
  }, 60_000);
});
