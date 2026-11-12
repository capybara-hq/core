import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ConversationEvent } from "../../src/conversations/events.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import {
  OUTBOX_DISPATCH_FAILS,
  OutboxDispatcher,
} from "../../src/infra/outbox/outbox.dispatcher.js";
import { OUTBOX_STRICT_CONFLICTS } from "../../src/infra/outbox/outbox.service.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-queue.js";
import {
  MAINTENANCE_QUEUE_NAME,
  resumeJobId,
  Waits,
  waitTimeoutJobId,
} from "../../src/runtime/waits.js";
import { approvalExpiredText } from "../../src/tools/pipeline.js";
import { memState } from "../fixtures/plugins/mem-connector/index.js";
import { truncateTables } from "../helpers/db.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
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
  waitForEvent,
  waitForTerminal,
} from "../helpers/runs.js";

/**
 * Transactional outbox spec §6 "Resumes and timeouts" and "Decisions resume in their own
 * transaction": a decision (an approval, an answer, a reply that skips a question) moves its
 * waiting run to `queued` and owes the run's resume job (`run-<conv>-resume-<waitId>`) in the
 * decision's transaction; a suspend owes its `wait-timeout-<waitId>` job (`run_at` = the wait's
 * deadline) in the suspend's transaction. Each test lets the run reach `waiting` normally, then
 * makes every queue add of the kernel's outbox dispatcher fail (`OUTBOX_DISPATCH_FAILS`): neither
 * the fast path nor the relay delivers, so what the decision owed stays in the outbox, and the
 * test delivers it with one relay pass (`OutboxDispatcher.dispatchDue`) once adds work again.
 */

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';
const ASK = 'tool:plugin__mem-connector__ask:{"rounds":1}';

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runQueue: Queue;
let maint: Queue;
let req: Req;
let orgId: string;
let agentId: string;
/** While true, every queue add of the kernel's outbox dispatcher fails. */
let failing = false;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [MODEL_FAKE, MEM_CONNECTOR] }),
    {
      overrides: [
        { provide: OUTBOX_DISPATCH_FAILS, useValue: () => failing },
        { provide: OUTBOX_STRICT_CONFLICTS, useValue: true },
      ],
    },
  );
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redis });
  maint = new Queue(MAINTENANCE_QUEUE_NAME, { connection: redis });
}, 180_000);

afterAll(async () => {
  failing = false;
  await runQueue?.close();
  await maint?.close();
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  failing = false;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.audit_events, capybara.outbox",
  );
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  const st = memState();
  st.echoCalls = 0;
  st.askCalls = [];
  req = await session(k, "owner");
  orgId = await createOrg(req);
  const en = await req({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/mem-connector`,
    payload: { enabled: true },
  });
  expect(en.statusCode, en.body).toBe(200);
  const ag = await req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/agents`,
    payload: {
      definition: {
        name: "Helper",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([
          { kind: "plugin", plugin: "mem-connector", name: "echo" },
          { kind: "plugin", plugin: "mem-connector", name: "ask" },
        ]),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  agentId = (ag.json() as { agent: { id: string } }).agent.id;
});

const runStatus = async (runId: string) =>
  (await db.selectFrom("runs").select("status").where("id", "=", runId).executeTakeFirstOrThrow())
    .status;

/** The outbox rows of job `name` whose data names `runId` or whose job id is `jobId`. */
const owed = (name: string, jobId: string) =>
  db
    .selectFrom("outbox")
    .select(["queue", "job_id", "data", "org_id"])
    .where("job_name", "=", name)
    .where("job_id", "=", jobId)
    .execute();

/** Every owed resume job of the conversation (`run-<conv>-resume-*`). */
const owedResumes = (convId: string) =>
  db
    .selectFrom("outbox")
    .select("job_id")
    .where("job_id", "like", `run-${convId}-resume-%`)
    .execute();

/** Sends `text` and waits until its run is idle in `waiting` (its run job finished). */
async function startAndWait(
  convId: string,
  text: string,
  type: "approval_requested" | "question_asked",
): Promise<{ runId: string; waitId: string }> {
  await postMessage(req, orgId, convId, text);
  const event = await waitForEvent(db, convId, (e) => e.type === type, 10_000, type);
  const runId = event.runId as string;
  await waitFor(async () => (await runStatus(runId)) === "waiting", 10_000, "run waiting");
  await waitFor(async () => (await runQueue.getActiveCount()) === 0, 10_000, "run job finished");
  const payload = event.payload as { approvalId?: string; questionId?: string };
  return { runId, waitId: (payload.approvalId ?? payload.questionId) as string };
}

/** One relay pass with adds working again: delivers every owed row now due. */
async function deliver(): Promise<void> {
  failing = false;
  await db.updateTable("outbox").set({ next_attempt_at: sql<Date>`now()` }).execute();
  await k.app.get(OutboxDispatcher).dispatchDue(500);
}

const decide = (id: string) =>
  req({
    method: "POST",
    url: `/api/v1/orgs/${orgId}/approvals/${id}/decision`,
    payload: { decision: "approve" },
  });

/** Sessions of this database waiting for a lock (the requests a held lock blocks). */
const lockWaiters = async () =>
  Number(
    (
      await sql<{ n: string }>`SELECT count(*) AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`.execute(raw)
    ).rows[0]?.n,
  );

/**
 * Holds `lock` (a `SELECT … FOR UPDATE`) in an open transaction until the returned release is
 * called; resolves once the lock is held.
 */
async function holdLock(
  lock: (trx: typeof raw) => Promise<unknown>,
): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  let held!: () => void;
  const holding = new Promise<void>((r) => {
    held = r;
  });
  const done = raw.transaction().execute(async (trx) => {
    await lock(trx as unknown as typeof raw);
    held();
    await gate;
  });
  await holding;
  return {
    release: async () => {
      open();
      await done;
    },
  };
}

const resultsOf = (evs: ConversationEvent[]) =>
  evs.flatMap((e) => (e.type === "tool_result" ? [e.payload] : []));

describe("decisions resume their run in the decision's transaction", () => {
  it("an approval decided with the fast path disabled resumes the run after the relay tick", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    failing = true;
    expect((await decide(waitId)).statusCode).toBe(200);
    // the decision's transaction moved the run and owed its resume job
    expect(await runStatus(runId)).toBe("queued");
    const jobId = resumeJobId(convId, waitId);
    expect(await owed("run", jobId)).toEqual([
      {
        queue: RUN_QUEUE_NAME,
        job_id: jobId,
        data: { runId, conversationId: convId },
        org_id: orgId,
      },
    ]);
    const run = await db
      .selectFrom("runs")
      .select(["job_id", "waiting_since"])
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(run).toEqual({ job_id: jobId, waiting_since: null });
    expect(await runQueue.getJob(jobId)).toBeUndefined();
    await deliver();
    await waitForTerminal(db, convId, 1);
    expect(memState().echoCalls).toBe(1);
    expect(resultsOf(await eventsOf(db, convId))).toMatchObject([
      { content: '{"text":"hi"}', isError: false },
    ]);
  });

  it("an approval decided while the run is still running leaves it running and suspend does not wait", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    // the moment between the worker's suspend decision and `running → waiting`: the run is running
    await sql`UPDATE capybara.runs SET status = 'running', waiting_since = NULL WHERE id = ${runId}`.execute(
      raw,
    );
    failing = true;
    expect((await decide(waitId)).statusCode).toBe(200);
    // the decision saw a running run: it wrote nothing more
    expect(await runStatus(runId)).toBe("running");
    expect(await owedResumes(convId)).toEqual([]);
    // the suspend's re-check sees the committed decision and resumes instead of waiting
    await k.app.get(Waits).suspend(runId, convId, {
      kind: "approval",
      id: waitId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(await runStatus(runId)).toBe("queued");
    expect(await owedResumes(convId)).toEqual([{ job_id: resumeJobId(convId, waitId) }]);
    await deliver();
    await waitForTerminal(db, convId, 1);
    expect(memState().echoCalls).toBe(1);
  });

  it("a wait timeout fires with the fast path disabled", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    // suspend again with adds failing: the timeout is owed in the suspend's transaction only
    await sql`UPDATE capybara.runs SET status = 'running', waiting_since = NULL WHERE id = ${runId}`.execute(
      raw,
    );
    const delivered = await waitFor(() => maint.getJob(waitTimeoutJobId(waitId)), 5_000, "job");
    await delivered.remove();
    failing = true;
    const approval = await db
      .selectFrom("approvals")
      .select("expires_at")
      .where("id", "=", waitId)
      .executeTakeFirstOrThrow();
    await k.app.get(Waits).suspend(runId, convId, {
      kind: "approval",
      id: waitId,
      expiresAt: new Date(approval.expires_at).toISOString(),
    });
    expect(await runStatus(runId)).toBe("waiting");
    // `run_at` is the approval's deadline, compared on the database's values
    const row = await sql<{ queue: string; data: unknown; skew_ms: number }>`
      SELECT o.queue, o.data,
        abs(extract(epoch FROM o.run_at - a.expires_at) * 1000)::float8 AS skew_ms
      FROM capybara.outbox o, capybara.approvals a
      WHERE o.job_id = ${waitTimeoutJobId(waitId)} AND a.id = ${waitId}`.execute(raw);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0]).toMatchObject({
      queue: MAINTENANCE_QUEUE_NAME,
      data: { kind: "approval", id: waitId },
    });
    expect(row.rows[0]?.skew_ms).toBeLessThan(1);
    expect(await maint.getJob(waitTimeoutJobId(waitId))).toBeUndefined();
    // the deadline passes; the relay's pass delivers the timeout, which expires the approval
    await sql`UPDATE capybara.approvals SET expires_at = now(), created_at = now() - interval '24 hours'
      WHERE id = ${waitId}`.execute(raw);
    await sql`UPDATE capybara.outbox SET run_at = now() WHERE job_id = ${waitTimeoutJobId(waitId)}`.execute(
      raw,
    );
    await deliver();
    await waitForTerminal(db, convId, 1);
    expect(memState().echoCalls).toBe(0);
    expect(resultsOf(await eventsOf(db, convId))).toMatchObject([
      { content: approvalExpiredText(24), isError: true },
    ]);
  });

  it("a run with two pending approvals stays waiting after one decision", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    // a second pending approval of the same run
    const second = `${waitId}-2`;
    await sql`INSERT INTO capybara.approvals
      SELECT (jsonb_populate_record(NULL::capybara.approvals,
        to_jsonb(a) || jsonb_build_object('id', ${second}::text, 'call_id', 'other-call'))).*
      FROM capybara.approvals a WHERE a.id = ${waitId}`.execute(raw);
    failing = true;
    expect((await decide(waitId)).statusCode).toBe(200);
    expect(await runStatus(runId)).toBe("waiting");
    expect(await owedResumes(convId)).toEqual([]);
    expect((await decide(second)).statusCode).toBe(200);
    expect(await runStatus(runId)).toBe("queued");
    expect(await owedResumes(convId)).toEqual([{ job_id: resumeJobId(convId, second) }]);
  });

  it("an answer resumes the run in the answer's transaction", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ASK, "question_asked");
    failing = true;
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/questions/${waitId}/answer`,
      payload: { answer: { color: "blue" } },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await runStatus(runId)).toBe("queued");
    expect(await owedResumes(convId)).toEqual([{ job_id: resumeJobId(convId, waitId) }]);
    await deliver();
    await waitForTerminal(db, convId, 1);
    expect(memState().askCalls).toHaveLength(2);
  });

  it("a reply that skips a question resumes the run in the message's transaction", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ASK, "question_asked");
    failing = true;
    await postMessage(req, orgId, convId, "echo:instead");
    const q = await db
      .selectFrom("questions")
      .select("status")
      .where("id", "=", waitId)
      .executeTakeFirstOrThrow();
    expect(q.status).toBe("skipped");
    expect(await runStatus(runId)).toBe("queued");
    expect(await owedResumes(convId)).toEqual([{ job_id: resumeJobId(convId, waitId) }]);
  });

  it("a decision holding the run's lock while suspend waits for it: suspend still does not wait", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    await sql`UPDATE capybara.runs SET status = 'running', waiting_since = NULL WHERE id = ${runId}`.execute(
      raw,
    );
    failing = true;
    // the run row is held: the decision queues on it first, then the suspend's update behind it
    const blocker = await holdLock((t) =>
      sql`SELECT 1 FROM capybara.runs WHERE id = ${runId} FOR UPDATE`.execute(t),
    );
    const decision = decide(waitId);
    await waitFor(async () => (await lockWaiters()) >= 1, 10_000, "decision blocked on the run");
    const suspended = k.app.get(Waits).suspend(runId, convId, {
      kind: "approval",
      id: waitId,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    await waitFor(async () => (await lockWaiters()) >= 2, 10_000, "suspend blocked on the run");
    await blocker.release();
    expect((await decision).statusCode).toBe(200);
    await suspended;
    // the decision saw `running` and wrote nothing to the run; the suspend's re-check resumed it
    expect(await runStatus(runId)).toBe("queued");
    expect(await owedResumes(convId)).toEqual([{ job_id: resumeJobId(convId, waitId) }]);
    await deliver();
    await waitForTerminal(db, convId, 1);
    expect(memState().echoCalls).toBe(1);
  });
});

describe("one lock order for decisions and stops (conversation, decided row, run)", () => {
  it("a decision and a stop of the same waiting run, forced to interleave, neither errors", async () => {
    const convId = await createConv(req, orgId, agentId);
    const { runId, waitId } = await startAndWait(convId, ECHO, "approval_requested");
    // the conversation row is held: the stop queues on it first, then the decision. With the
    // decision taking the approval row before the conversation, the stop (conversation, run,
    // approvals) and the decision would deadlock once released.
    const blocker = await holdLock((t) =>
      sql`SELECT 1 FROM capybara.conversations WHERE id = ${convId} FOR UPDATE`.execute(t),
    );
    const stop = req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${convId}/abort`,
    });
    await waitFor(async () => (await lockWaiters()) >= 1, 10_000, "stop blocked");
    const decision = decide(waitId);
    await waitFor(async () => (await lockWaiters()) >= 2, 10_000, "decision blocked");
    await blocker.release();
    const [s, d] = await Promise.all([stop, decision]);
    // the stop went first: it cancelled the approval and ended the run; the decision finds the
    // approval decided (409), not a deadlock (500)
    expect(s.statusCode, s.body).toBe(202);
    expect(d.statusCode, d.body).toBe(409);
    expect(await runStatus(runId)).toBe("aborted");
    const a = await db
      .selectFrom("approvals")
      .select("status")
      .where("id", "=", waitId)
      .executeTakeFirstOrThrow();
    expect(a.status).toBe("cancelled");
    expect(await owedResumes(convId)).toEqual([]);
    expect(memState().echoCalls).toBe(0);
  });
});
