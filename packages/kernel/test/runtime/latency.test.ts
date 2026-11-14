import { AsyncLocalStorage } from "node:async_hooks";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OUTBOX_FAST_PATH_SETTLED } from "../../src/infra/outbox/outbox.module.js";
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
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/**
 * The cost of the message → run-job-added path (transactional outbox spec §11 "Latency", ruling
 * R6): counted, not timed. A message to an idle conversation, on an api-only kernel (no worker
 * takes the job, no relay runs). Every PG statement and Redis command issued in the request's async
 * context is counted: the request itself, its after-commit work, and the outbox fast-path passes it
 * started, awaited through the `OUTBOX_FAST_PATH_SETTLED` seam. Periodic work of the kernel runs
 * outside that context and is not counted.
 *
 * Before the outbox (main at 7cb12115f, measured once with this counter): 27 PG statements and 6
 * Redis commands. Now 33 and 4. PG: the ensure-run backstop's insert in the message transaction,
 * the run job's insert and the duplicate-trigger count (R21, a PG read instead of a Redis one) in
 * `ensureRun`'s transaction, and one claim transaction of the fast path for the run job (BEGIN;
 * SELECT … FOR UPDATE SKIP LOCKED; DELETE; COMMIT). The backstop is delayed, so the relay delivers
 * it, not this path (R20). One read fewer: the channel delivery hint after each append (a
 * `channel_deliveries` read) is gone, since an append reads the channel target in its row-lock
 * statement and owes the IM delivery only for a conversation that has one (spec §8.1). Redis: the run job's add stays one command; its read-back after the add
 * and the read of a job for the same trigger before it are gone. The p50 of the same path (100
 * sends, before and after) is reported with the PR, not asserted (a timing is not deterministic).
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
const counting = new AsyncLocalStorage<Counts>();

/** What one request issued, and the fast-path passes it started after its commits. */
interface Counts {
  pg: string[];
  redis: string[];
  passes: Promise<void>[];
}
const pgQuery = pg.Client.prototype.query;
const redisSend = Redis.prototype.sendCommand;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  api = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"] }), {
    // each detached fast-path pass, kept with the request that started it
    overrides: [
      {
        provide: OUTBOX_FAST_PATH_SETTLED,
        useValue: (pass: Promise<void>) => counting.getStore()?.passes.push(pass),
      },
    ],
  });
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
});

afterAll(async () => {
  pg.Client.prototype.query = pgQuery;
  Redis.prototype.sendCommand = redisSend;
  await api?.close();
  await runs?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

/**
 * Counts one message's path to its run job: what the request issued until its response, then what
 * the fast-path passes it started issued until they settled (awaited through the seam; no quiet
 * period is guessed). The run's job must then be in BullMQ.
 */
async function measure(orgId: string, agentId: string): Promise<Counts> {
  const convId = await createConv(req, orgId, agentId);
  const c: Counts = { pg: [], redis: [], passes: [] };
  const seq = await counting.run(c, () => postMessage(req, orgId, convId, "echo:hi"));
  await Promise.all(c.passes);
  expect(await runs.getJob(runJobId(convId, seq))).toBeDefined();
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
      pg: 27 + 6,
      redis: 4,
    });
    // the outbox's share: two inserts and one claim transaction (the run job's)
    const outbox = a.pg.filter((q) => /"capybara"\."outbox"/.test(q));
    expect(outbox.map((q) => q.split(" ")[0]).sort()).toEqual([
      "delete",
      "insert",
      "insert",
      "select",
    ]);
  });
});
