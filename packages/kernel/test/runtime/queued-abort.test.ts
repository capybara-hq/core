import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RunControl } from "../../src/runtime/run-control.js";
import { RUN_QUEUE_NAME } from "../../src/runtime/run-jobs.js";
import { RUN_HOOKS, type RunHooks } from "../../src/runtime/run-worker.js";
import { accountsFor } from "../helpers/identity.js";
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
  waitForRunJobDone,
} from "../helpers/runs.js";

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

/** The worker's seams: each test sets the pauses it needs. */
const hooks: RunHooks = {};

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"] }), {
    overrides: [{ provide: RUN_HOOKS, useValue: hooks }],
  });
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runQueue = new Queue(RUN_QUEUE_NAME, { connection: redis });
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(k, "owner");
  orgId = await createOrg(req);
  agentId = await createAgent(req, orgId);
}, 180_000);

afterAll(async () => {
  await k?.close();
  await runQueue?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(() => {
  delete hooks.afterRunRead;
  delete hooks.beforeRunStarted;
});

/** Pauses the worker at `point` for `conv`'s run; resolves the run id once it got there. */
function pauseAt(
  point: "afterRunRead" | "beforeRunStarted",
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
