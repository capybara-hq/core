import { AsyncLocalStorage } from "node:async_hooks";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { RUN_QUEUE_NAME, runJobId } from "../../src/runtime/run-queue.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import {
  createAgent,
  createConv,
  createOrg,
  PW,
  postMessage,
  type Req,
  runConfig,
  session,
  sleep,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * The cost of the message → run-job-added path (transactional outbox spec §11 "Latency", ruling
 * R6): counted, not timed. A message to an idle conversation, on an api-only kernel (no worker
 * takes the job, no relay runs), from the request until the run's job is in BullMQ and the outbox
 * holds nothing for it. Every PG statement and Redis command issued on that path (the request, its
 * after-commit work and the outbox fast path, which all run in the request's async context) is
 * counted; periodic work of the kernel runs outside that context and is not.
 *
 * Before the outbox (main at 7cb12115f, measured once with this counter): 27 PG statements and 6
 * Redis commands. The outbox adds 10 statements and no command: in the message transaction the
 * ensure-run backstop's insert, in `ensureRun`'s transaction the run job's insert, and after each
 * commit one claim transaction of the fast path (BEGIN; SELECT … FOR UPDATE SKIP LOCKED; DELETE;
 * COMMIT: 4 statements). In Redis the run job's add stays one command, its read-back after the add
 * is gone and the backstop's delayed add is new. The p50 of the same path (100 sends, before and
 * after) is measured and reported with the PR, not asserted here (a timing is not deterministic).
 */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let runs: Queue;
let api: TestKernel;
let req: Req;

/** The counters of the request being measured (its async context). */
const counting = new AsyncLocalStorage<{ pg: string[]; redis: string[] }>();
const pgQuery = pg.Client.prototype.query;
const redisSend = Redis.prototype.sendCommand;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  runs = new Queue(RUN_QUEUE_NAME, { connection: redis });
  // biome-ignore lint/suspicious/noExplicitAny: wraps the driver's overloaded query
  (pg.Client.prototype as any).query = function (this: pg.Client, ...args: any[]) {
    const c = counting.getStore();
    if (c) {
      const q = args[0] as string | { text?: string } | undefined;
      c.pg.push(typeof q === "string" ? q : (q?.text ?? "?"));
    }
    return (pgQuery as (...a: unknown[]) => unknown).apply(this, args);
  };
  // biome-ignore lint/suspicious/noExplicitAny: wraps ioredis' command sender
  (Redis.prototype as any).sendCommand = function (this: Redis, cmd: any, ...rest: any[]) {
    counting.getStore()?.redis.push(String(cmd?.name ?? "?"));
    return (redisSend as (...a: unknown[]) => unknown).apply(this, [cmd, ...rest]);
  };
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  await accountsFor(db).createLocal({ login: "owner", password: PW, displayName: "O" });
  req = await session(api, "owner");
}, 180_000);

afterAll(async () => {
  pg.Client.prototype.query = pgQuery;
  Redis.prototype.sendCommand = redisSend;
  await api?.close();
  await runs?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/** Counts one message's path to its run job; returns the statements and commands issued. */
async function measure(orgId: string, agentId: string): Promise<{ pg: string[]; redis: string[] }> {
  const convId = await createConv(req, orgId, agentId);
  const c = { pg: [] as string[], redis: [] as string[] };
  const seq = await counting.run(c, () => postMessage(req, orgId, convId, "echo:hi"));
  await waitFor(() => runs.getJob(runJobId(convId, seq)), 10_000, "the run job added");
  await waitFor(
    async () =>
      (await db.selectFrom("outbox").select("id").execute()).length === 0 ? true : undefined,
    10_000,
    "the outbox drained",
  );
  // the tail of the fast path (its commit) and the after-commit notifications settle
  let n = -1;
  while (n !== c.pg.length + c.redis.length) {
    n = c.pg.length + c.redis.length;
    await sleep(200);
  }
  return c;
}

describe("message → run job added", () => {
  it("issues a fixed number of PG statements and Redis commands", async () => {
    const orgId = await createOrg(req);
    const agentId = await createAgent(req, orgId);
    // the first message warms the caches (agents, config, extensions) on this kernel
    await measure(orgId, agentId);
    const [a, b] = [await measure(orgId, agentId), await measure(orgId, agentId)];
    expect([b.pg.length, b.redis.length]).toEqual([a.pg.length, a.redis.length]);
    expect({ pg: a.pg.length, redis: a.redis.length }, JSON.stringify(a, null, 1)).toEqual({
      pg: 27 + 10,
      redis: 6,
    });
    // the outbox's share: two inserts and two claim transactions
    const outbox = a.pg.filter((q) => /"capybara"\."outbox"/.test(q));
    // (the fast path's claim runs beside the request's direct ensureRun: compared without order)
    expect(outbox.map((q) => q.split(" ")[0]).sort()).toEqual([
      "delete",
      "delete",
      "insert",
      "insert",
      "select",
      "select",
    ]);
  }, 60_000);
});
