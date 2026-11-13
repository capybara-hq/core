import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_DISPATCH_FAILS } from "../../src/infra/outbox/outbox.dispatcher.js";
import { RUN_STOP_JOB } from "../../src/orgs/offboarding.js";
import { RunContextService } from "../../src/runtime/run-context.service.js";
import { RunControl } from "../../src/runtime/run-control.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { RunQueue } from "../../src/runtime/run-queue.js";
import { RUN_HOOKS, type RunHooks } from "../../src/runtime/run-worker.js";
import { SkillsCatalogService } from "../../src/skills/catalog.js";
import { onlyBuiltins } from "../helpers/disabled-tools.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import { MODEL_FAKE } from "../helpers/model-plugins.js";
import { drainOutbox } from "../helpers/outbox.js";
import {
  createAgent,
  createConv,
  createOrg,
  eventsOf,
  gate,
  PW,
  postMessage,
  type Req,
  runConfig,
  runsOf,
  session,
  startKernel,
  type TestKernel,
  waitFor,
  waitForEvent,
  waitForRunJobDone,
} from "../helpers/runs.js";

const MEM_CONNECTOR = fileURLToPath(
  new URL("../fixtures/plugins/mem-connector/index.ts", import.meta.url),
);
/** The fake model calls the connector's echo tool, which asks for approval first. */
const ECHO = 'tool:plugin__mem-connector__echo:{"text":"hi"}';

/**
 * A queued run stopped in PG (`RunQueue.abortQueued`: an offboarded member's run, a person's stop
 * of a queued run; ruling R27) never starts: a run job that read the run as `queued` before the
 * stop re-checks it under the conversation and run row locks before its `run_started`, and the
 * status update never moves a terminal run back to `running`. The reverse order (the worker holds
 * the conversation first) leaves the run to the worker.
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runQueue: Queue;
let k: TestKernel;
let req: Req;
let orgId: string;
let agentId: string;
let ownerId: string;
/** An agent whose echo tool asks for approval (a run that waits, then resumes). */
let askerId: string;
/** While true, the outbox's adds to the run queue fail (a resume job stays owed). */
let failing = false;

/** The worker's seams: each test sets the pauses it needs. */
const hooks: RunHooks = {};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      { roles: ["api", "worker"], extensions: [MODEL_FAKE, MEM_CONNECTOR] },
    ),
    {
      overrides: [
        { provide: RUN_HOOKS, useValue: hooks },
        {
          provide: OUTBOX_DISPATCH_FAILS,
          useValue: (queue: string) => failing && queue === RUN_QUEUE_NAME,
        },
      ],
    },
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redis });
  ownerId = (await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  req = await session(k, "owner");
  orgId = await createOrg(req);
  agentId = await createAgent(req, orgId);
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
        name: "Asker",
        instructions: "Be helpful.",
        model: { provider: "model-fake", model: "fake-1" },
        disabledTools: onlyBuiltins([{ kind: "plugin", plugin: "mem-connector", name: "echo" }]),
        toolPolicies: { "plugin__mem-connector__echo": "ask" },
      },
      visibility: "org",
    },
  });
  expect(ag.statusCode, ag.body).toBe(201);
  askerId = (ag.json() as { agent: { id: string } }).agent.id;
}, 180_000);

afterAll(async () => {
  await k?.close();
  await runQueue?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(() => {
  failing = false;
  delete hooks.afterRunRead;
  delete hooks.beforeRunStarted;
  delete hooks.beforeRunning;
});

/** Pauses the worker at `point` for `conv`'s run; resolves the run id once it got there. */
function pauseAt(
  point: "afterRunRead" | "beforeRunStarted" | "beforeRunning",
  conv: string,
): { reached: Promise<string>; release: () => void } {
  const g = gate();
  let reached!: (runId: string) => void;
  const p = new Promise<string>((r) => {
    reached = r;
  });
  hooks[point] = async (runId, conversationId) => {
    if (conversationId !== conv) return;
    reached(runId);
    await g.promise;
  };
  return { reached: p, release: g.open };
}

const types = async (conv: string) => (await eventsOf(db, conv)).map((e) => e.type);

describe("a queued run stopped in PG", () => {
  it("a worker that read it as queued before the stop never starts it", async () => {
    const conv = await createConv(req, orgId, agentId);
    const pause = pauseAt("afterRunRead", conv);
    await postMessage(req, orgId, conv, "hi");
    const runId = await pause.reached;
    expect(await k.app.get(RunControl).abortQueued(conv, runId, null)).toBe(true);
    pause.release();
    await waitForRunJobDone(db, runQueue, runId, 15_000);
    expect((await runsOf(db, conv)).find((r) => r.id === runId)?.status).toBe("aborted");
    const t = await types(conv);
    expect(t).toContain("run_aborted");
    expect(t).not.toContain("run_started");
  }, 30_000);

  it("a person's stop of a queued run ends it in PG", async () => {
    const conv = await createConv(req, orgId, agentId);
    const pause = pauseAt("afterRunRead", conv);
    await postMessage(req, orgId, conv, "hi");
    const runId = await pause.reached;
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    // ended at once, without a worker: not left to the stop marker
    expect((await runsOf(db, conv)).find((r) => r.id === runId)?.status).toBe("aborted");
    pause.release();
    await waitForRunJobDone(db, runQueue, runId, 15_000);
    expect((await runsOf(db, conv)).find((r) => r.id === runId)?.status).toBe("aborted");
    expect(await types(conv)).not.toContain("run_started");
  }, 30_000);

  it("the reverse order: a worker that holds the conversation keeps the run", async () => {
    const conv = await createConv(req, orgId, agentId);
    const pause = pauseAt("beforeRunStarted", conv);
    await postMessage(req, orgId, conv, "hi");
    const runId = await pause.reached;
    expect(await k.app.get(RunControl).abortQueued(conv, runId, null)).toBe(false);
    pause.release();
    await waitFor(
      async () =>
        (await runsOf(db, conv)).find((r) => r.id === runId)?.status === "completed" || null,
      15_000,
      "run completed",
    );
    const t = await types(conv);
    expect(t).toContain("run_started");
    expect(t).not.toContain("run_aborted");
  }, 30_000);
});

describe("the running update never overwrites a terminal status", () => {
  it("a run ended between its run_started and its running update is handled as finished", async () => {
    const conv = await createConv(req, orgId, agentId);
    const pause = pauseAt("beforeRunning", conv);
    await postMessage(req, orgId, conv, "hi");
    const runId = await pause.reached;
    // a terminal writer got there first (the status alone: what the update guards)
    await sql`UPDATE capybara.runs SET status = 'aborted', finished_at = now() WHERE id = ${runId}`.execute(
      raw,
    );
    pause.release();
    await waitForRunJobDone(db, runQueue, runId, 15_000);
    expect((await runsOf(db, conv)).find((r) => r.id === runId)?.status).toBe("aborted");
    expect(await types(conv)).not.toContain("assistant_message");
  }, 30_000);
});

describe("a run resumed from waiting back to queued is stopped in PG too", () => {
  const runStatus = async (id: string) =>
    (await db.selectFrom("runs").select("status").where("id", "=", id).executeTakeFirstOrThrow())
      .status;

  /** A run of `as` that started, asked for approval and was approved with its resume job held. */
  async function resumedQueued(as: Req, conv: string): Promise<string> {
    await postMessage(as, orgId, conv, ECHO);
    const ev = await waitForEvent(db, conv, (e) => e.type === "approval_requested", 15_000);
    const runId = ev.runId as string;
    await waitFor(async () => (await runStatus(runId)) === "waiting", 15_000, "run waiting");
    await waitFor(async () => (await runQueue.getActiveCount()) === 0, 15_000, "run job done");
    failing = true;
    const approvalId = (ev.payload as { approvalId: string }).approvalId;
    const res = await as({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/approvals/${approvalId}/decision`,
      payload: { decision: "approve" },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await runStatus(runId)).toBe("queued");
    const started = await db
      .selectFrom("runs")
      .select("started_at")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    expect(started.started_at).not.toBeNull();
    return runId;
  }

  /** Delivers the held resume job; waits until it ran. */
  async function deliverResume(runId: string): Promise<void> {
    failing = false;
    await db
      .updateTable("outbox")
      .set({ next_attempt_at: sql<Date>`now()` as unknown as Date })
      .where("queue", "=", RUN_QUEUE_NAME)
      .execute();
    await drainOutbox(k.app, { queue: RUN_QUEUE_NAME });
    await waitForRunJobDone(db, runQueue, runId, 15_000);
  }

  /** The events after the run's `run_aborted`: nothing the run did once stopped. */
  const afterAbort = async (conv: string, runId: string) => {
    const evs = (await eventsOf(db, conv)).filter((e) => e.runId === runId);
    const at = evs.findIndex((e) => e.type === "run_aborted");
    expect(at).toBeGreaterThanOrEqual(0);
    return evs.slice(at + 1).map((e) => e.type);
  };

  it("a person's stop ends it in PG and the held resume job does not run it", async () => {
    const conv = await createConv(req, orgId, askerId);
    const runId = await resumedQueued(req, conv);
    const res = await req({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/conversations/${conv}/abort`,
    });
    expect(res.statusCode, res.body).toBe(202);
    expect(await runStatus(runId)).toBe("aborted");
    await deliverResume(runId);
    expect(await runStatus(runId)).toBe("aborted");
    expect(await afterAbort(conv, runId)).toEqual([]);
  }, 60_000);

  it("a resume job that read it as queued before the stop appends no catalog or run context", async () => {
    const conv = await createConv(req, orgId, askerId);
    const runId = await resumedQueued(req, conv);
    const catalog = vi.spyOn(k.app.get(SkillsCatalogService), "record");
    const context = vi.spyOn(k.app.get(RunContextService), "record");
    try {
      // the resume job reads `queued` (its run_started is there), then the stop ends the run
      const pause = pauseAt("afterRunRead", conv);
      const delivered = deliverResume(runId);
      expect(await pause.reached).toBe(runId);
      expect(await k.app.get(RunControl).abortQueued(conv, runId, null)).toBe(true);
      pause.release();
      await delivered;
      expect(await runStatus(runId)).toBe("aborted");
      const forRun = (calls: unknown[][]) =>
        calls.filter((c) => (c[0] as { runId?: string }).runId === runId);
      // the catalog's transaction re-reads the run under the locks: ended, nothing appended
      const tried = catalog.mock.calls.flatMap((c, i) =>
        (c[0] as { runId?: string }).runId === runId ? [catalog.mock.results[i]?.value] : [],
      );
      expect(await Promise.all(tried)).toEqual(tried.map(() => false));
      expect(forRun(context.mock.calls)).toEqual([]);
      expect(await afterAbort(conv, runId)).toEqual([]);
    } finally {
      catalog.mockRestore();
      context.mockRestore();
    }
  }, 60_000);

  it("a stop that saw the lock free and ends the run after the worker took it: nothing is recorded after run_aborted", async () => {
    const conv = await createConv(req, orgId, askerId);
    const runId = await resumedQueued(req, conv);
    const service = k.app.get(SkillsCatalogService);
    const real = service.record.bind(service);
    const { name } = await db
      .selectFrom("orgs")
      .select("name")
      .where("id", "=", orgId)
      .executeTakeFirstOrThrow();
    // the worker holds the conversation lock and is about to record: a stop that read the lock
    // free before the worker took it now runs its PG half (`abortQueued` past its holder check);
    // a resumed run has its started_at, so the first-start refusal does not keep it
    const catalog = vi.spyOn(service, "record").mockImplementationOnce(async (input, opts) => {
      // biome-ignore lint/suspicious/noExplicitAny: the stop's private PG half
      const stopped = await (k.app.get(RunQueue) as any).abortQueuedIn(conv, runId, null);
      expect(stopped).not.toBeNull();
      // a changed context: an append after the end would show as a run_context event
      await db
        .updateTable("orgs")
        .set({ name: `${name} renamed` })
        .where("id", "=", orgId)
        .execute();
      return real(input, opts);
    });
    const context = vi.spyOn(k.app.get(RunContextService), "record");
    try {
      await deliverResume(runId);
      expect(catalog).toHaveBeenCalledTimes(1);
      expect(await runStatus(runId)).toBe("aborted");
      // the catalog's transaction saw the end: no run context record was even tried
      expect(context).not.toHaveBeenCalled();
      expect(await afterAbort(conv, runId)).toEqual([]);
    } finally {
      catalog.mockRestore();
      context.mockRestore();
      await db.updateTable("orgs").set({ name }).where("id", "=", orgId).execute();
    }
  }, 60_000);

  it("offboarding's run-stop ends it in PG and the held resume job does not run it", async () => {
    const login = `m-${Date.now()}`;
    const memberId = (
      await accountsFor(db).createLocal({ login, password: PW, displayName: login })
    ).id;
    await testMembers(db).add(orgId, memberId, "member", ownerId);
    const memberReq = await session(k, login);
    const conv = await createConv(memberReq, orgId, askerId);
    const runId = await resumedQueued(memberReq, conv);
    const res = await req({ method: "DELETE", url: `/api/v1/orgs/${orgId}/members/${memberId}` });
    expect(res.statusCode, res.body).toBe(204);
    // the run-stop job (maintenance queue: the fast path works) ends it without throwing
    await waitFor(async () => (await runStatus(runId)) === "aborted", 15_000, "run aborted");
    // the run-stop's row is gone once the pass that added its job committed
    await drainOutbox(k.app, { jobName: RUN_STOP_JOB });
    await deliverResume(runId);
    expect(await runStatus(runId)).toBe("aborted");
    expect(await afterAbort(conv, runId)).toEqual([]);
  }, 60_000);
});
