import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OutboxDeadService } from "../../src/admin/outbox-dead.service.js";
import type { AdminAttention, AdminOverviewStats } from "../../src/admin/overview.service.js";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { OutboxDispatcher } from "../../src/infra/outbox/outbox.dispatcher.js";
import { PlatformOperations } from "../../src/platform/registry.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, apiTokensFor, orgsFor, settingsFor } from "../helpers/identity.js";
import {
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
  waitFor,
} from "../helpers/runs.js";

/**
 * Dead outbox rows for the super admin (transactional outbox spec §3.4): the overview's attention
 * list counts them (`outbox_dead`), `GET /api/v1/admin/outbox/dead` lists them, a retry makes a
 * row due again (or, when the same job is owed already, discards the dead copy: ruling R8) and a
 * discard deletes it, each audited. Super admins only.
 *
 * Test job names are not registered (ruling R2): the assertions stop at the job landing on its
 * queue, not at its processing.
 */

const QUEUE = "cap-kernel-maintenance";
const TEST_JOB = "outbox-dead-test-job";

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let redis: Redis;
let queue: Queue;
let root: Req;
let owner: Req;
let rootId: string;
let orgId: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  // the api role only: no relay runs, so a row stays until the test dispatches it
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api"], extensions: [] }),
  );
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  redis = new Redis(rd.url, { maxRetriesPerRequest: null });
  queue = new Queue(QUEUE, { connection: redis });
  const accounts = accountsFor(db);
  rootId = (
    await accounts.createLocal({
      login: "root",
      password: PW,
      displayName: "Root",
      superAdmin: true,
    })
  ).id;
  const ownerAccount = await accounts.createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
  orgId = (
    await orgsFor(db, settingsFor(db), apiTokensFor(db)).create({ name: "Acme" }, ownerAccount)
  ).id;
  root = await session(k, "root");
  owner = await session(k, "owner");
}, 180_000);

afterAll(async () => {
  await queue?.close();
  await k?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

beforeEach(async () => {
  await truncateTables(raw, "capybara.outbox, capybara.audit_events");
  await queue.obliterate({ force: true });
});

/** A row the dispatcher gave up on: 20 attempts, the last error, `dead_at` set. */
async function deadRow(
  jobId: string,
  over: { data?: unknown; orgId?: string; deadAt?: Date } = {},
): Promise<string> {
  const row = await db
    .insertInto("outbox")
    .values({
      queue: QUEUE,
      job_name: TEST_JOB,
      job_id: jobId,
      data: JSON.stringify(over.data ?? { jobId }),
      org_id: over.orgId ?? null,
      attempts: 20,
      last_error: "connect ECONNREFUSED 127.0.0.1:6379",
      dead_at: over.deadAt ?? new Date(),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return String(row.id);
}

const auditOf = (action: string) =>
  db
    .selectFrom("audit_events")
    .select(["actor_account_id", "org_id", "target", "detail"])
    .where("action", "=", action)
    .execute();

describe("dead outbox rows", { timeout: 60_000 }, () => {
  it("a dead row appears in the overview attention list", async () => {
    const older = new Date(Date.now() - 3_600_000);
    await deadRow("dead-1", { deadAt: older });
    await deadRow("dead-2");
    const a = await root({ method: "GET", url: "/api/v1/admin/overview/attention" });
    expect(a.statusCode, a.body).toBe(200);
    const attention = a.json() as AdminAttention;
    expect(attention.outbox).toEqual([
      { kind: "outbox_dead", count: 2, oldestAt: older.toISOString() },
    ]);
    expect(attention.more.outbox).toBe(0);
    const s = await root({ method: "GET", url: "/api/v1/admin/overview" });
    // every dead row waits for the super admin
    expect((s.json() as AdminOverviewStats).attentionTotal).toBeGreaterThanOrEqual(2);
    const list = await root({ method: "GET", url: "/api/v1/admin/outbox/dead" });
    expect(list.statusCode, list.body).toBe(200);
    const { items } = list.json() as { items: Record<string, unknown>[] };
    expect(items.map((i) => i.jobId)).toEqual(["dead-1", "dead-2"]);
    expect(items[0]).toEqual({
      id: expect.any(String),
      queue: QUEUE,
      jobName: TEST_JOB,
      jobId: "dead-1",
      orgId: null,
      attempts: 20,
      lastError: "connect ECONNREFUSED 127.0.0.1:6379",
      deadAt: older.toISOString(),
      createdAt: expect.any(String),
    });
    // a pending row is not dead: not listed, not counted
    await db
      .insertInto("outbox")
      .values({ queue: QUEUE, job_name: TEST_JOB, job_id: "pending-1", data: "{}" })
      .execute();
    const again = (
      await root({ method: "GET", url: "/api/v1/admin/overview/attention" })
    ).json() as AdminAttention;
    expect(again.outbox[0]?.count).toBe(2);
  });

  it("no dead row: no outbox attention item", async () => {
    const a = (
      await root({ method: "GET", url: "/api/v1/admin/overview/attention" })
    ).json() as AdminAttention;
    expect(a.outbox).toEqual([]);
  });

  it("retry makes it due again and the relay delivers it", async () => {
    const id = await deadRow("retry-1");
    const r = await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ outcome: "retried" });
    const audits = await auditOf("outbox.retried");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      org_id: null,
      target: id,
      detail: { outcome: "retried", queue: QUEUE, jobName: TEST_JOB, jobId: "retry-1" },
    });
    // the relay's pass (the fast path may have delivered it already: either way it lands once)
    await k.app.get(OutboxDispatcher).dispatchDue(100);
    const job = await waitFor(() => queue.getJob("retry-1"), 5000, "the retried job");
    expect(job.name).toBe(TEST_JOB);
    expect(job.data).toEqual({ jobId: "retry-1" });
    await waitFor(
      async () =>
        (await db.selectFrom("outbox").select("id").where("id", "=", id).executeTakeFirst()) ===
        undefined,
      5000,
      "the delivered row deleted",
    );
    // no longer dead: listed nowhere
    const list = (await root({ method: "GET", url: "/api/v1/admin/outbox/dead" })).json() as {
      items: unknown[];
    };
    expect(list.items).toEqual([]);
  });

  it("retrying a row whose job is owed already discards the dead copy (R8)", async () => {
    const id = await deadRow("owed-1");
    await db
      .insertInto("outbox")
      .values({
        queue: QUEUE,
        job_name: TEST_JOB,
        job_id: "owed-1",
        data: JSON.stringify({ jobId: "owed-1" }),
        next_attempt_at: new Date(Date.now() + 3_600_000),
      })
      .execute();
    const r = await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ outcome: "already_owed" });
    const left = await db.selectFrom("outbox").select(["job_id", "dead_at"]).execute();
    expect(left).toEqual([{ job_id: "owed-1", dead_at: null }]);
    expect((await auditOf("outbox.retried"))[0]?.detail).toMatchObject({
      outcome: "already_owed",
    });
  });

  it("a pending row added while the retry runs makes it already_owed (the unique index)", async () => {
    const id = await deadRow("race-1");
    const service = k.app.get(OutboxDeadService);
    // biome-ignore lint/suspicious/noExplicitAny: spying on the private one-attempt transaction
    const internal = service as any;
    const real = internal.retryOnce.bind(service);
    const spy = vi.spyOn(internal, "retryOnce").mockImplementationOnce(async () => {
      // the same job owed again between the check and the update: the update hits the index
      await db
        .insertInto("outbox")
        .values({
          queue: QUEUE,
          job_name: TEST_JOB,
          job_id: "race-1",
          data: "{}",
          next_attempt_at: new Date(Date.now() + 3_600_000),
        })
        .execute();
      await db.updateTable("outbox").set({ dead_at: null }).where("id", "=", id).execute();
    });
    spy.mockImplementation(real);
    try {
      const r = await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` });
      expect(r.statusCode, r.body).toBe(200);
      expect(r.json()).toEqual({ outcome: "already_owed" });
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      spy.mockRestore();
    }
    expect(await db.selectFrom("outbox").select(["job_id", "dead_at"]).execute()).toEqual([
      { job_id: "race-1", dead_at: null },
    ]);
  });

  it("discard deletes it and writes the audit", async () => {
    const id = await deadRow("discard-1");
    const r = await root({ method: "DELETE", url: `/api/v1/admin/outbox/dead/${id}` });
    expect(r.statusCode, r.body).toBe(204);
    expect(await db.selectFrom("outbox").select("id").execute()).toEqual([]);
    const audits = await auditOf("outbox.discarded");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actor_account_id: expect.any(String),
      org_id: null,
      target: id,
      detail: { queue: QUEUE, jobName: TEST_JOB, jobId: "discard-1" },
    });
    // gone: a second discard or retry is 404
    const again = await root({ method: "DELETE", url: `/api/v1/admin/outbox/dead/${id}` });
    expect(again.statusCode).toBe(404);
    expect((again.json() as { error: { code: string } }).error.code).toBe("outbox.not_found");
    const retry = await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` });
    expect(retry.statusCode).toBe(404);
  });

  it("a pending row is neither retried nor discarded", async () => {
    const row = await db
      .insertInto("outbox")
      .values({ queue: QUEUE, job_name: TEST_JOB, job_id: "pending-2", data: "{}" })
      .returning("id")
      .executeTakeFirstOrThrow();
    const id = String(row.id);
    expect(
      (await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` })).statusCode,
    ).toBe(404);
    expect(
      (await root({ method: "DELETE", url: `/api/v1/admin/outbox/dead/${id}` })).statusCode,
    ).toBe(404);
    expect(
      (await root({ method: "DELETE", url: "/api/v1/admin/outbox/dead/not-a-number" })).statusCode,
    ).toBe(400);
  });

  it("an org admin gets 403", async () => {
    const id = await deadRow("forbidden-1");
    for (const r of [
      { method: "GET" as const, url: "/api/v1/admin/outbox/dead" },
      { method: "POST" as const, url: `/api/v1/admin/outbox/dead/${id}/retry` },
      { method: "DELETE" as const, url: `/api/v1/admin/outbox/dead/${id}` },
    ]) {
      const res = await owner(r);
      expect(res.statusCode, `${r.method} ${r.url}`).toBe(403);
    }
    expect(await db.selectFrom("outbox").select(["job_id", "dead_at"]).execute()).toEqual([
      { job_id: "forbidden-1", dead_at: expect.any(Date) },
    ]);
  });

  it("retrying a row whose entity is gone runs a harmless job", async () => {
    // the org and the conversation it names were deleted since: the retry does not look them up,
    // it owes the job again, and the processor's own state check (the job's idempotency sentence)
    // finds nothing to do
    const id = await deadRow("gone-1", {
      orgId: "00000000-0000-4000-8000-000000000000",
      data: { conversationId: "deleted-conversation" },
    });
    const r = await root({ method: "POST", url: `/api/v1/admin/outbox/dead/${id}/retry` });
    expect(r.json()).toEqual({ outcome: "retried" });
    await k.app.get(OutboxDispatcher).dispatchDue(100);
    const job = await waitFor(() => queue.getJob("gone-1"), 5000, "the retried job");
    expect(job.data).toEqual({ conversationId: "deleted-conversation" });
  });

  it("the Platform operations list, retry and discard through the same service", async () => {
    const ops = k.app.get(PlatformOperations);
    const op = (id: string) => {
      const o = ops.get(id);
      if (o === null) throw new Error(`no operation ${id}`);
      return o;
    };
    const ctx = {
      orgId,
      actorAccountId: rootId,
      agentId: "agent-1",
      conversationId: "conv-1",
      runId: "run-1",
      signal: new AbortController().signal,
    };
    const retryId = await deadRow("op-retry-1");
    const discardId = await deadRow("op-discard-1");
    expect(op("admin.outbox-list-dead").confirm).toBe("read");
    expect(op("admin.outbox-retry").confirm).toBe("platform");
    expect(op("admin.outbox-discard").confirm).toBe("platform");
    const listed = (await op("admin.outbox-list-dead").run({}, ctx)) as {
      items: { id: string }[];
    };
    expect(listed.items.map((i) => i.id)).toEqual([retryId, discardId]);
    expect(await op("admin.outbox-retry").run({ id: retryId }, ctx)).toEqual({
      outcome: "retried",
    });
    expect(await op("admin.outbox-discard").run({ id: discardId }, ctx)).toEqual({
      id: discardId,
      discarded: true,
    });
    expect((await auditOf("outbox.retried"))[0]?.detail).toMatchObject({
      outcome: "retried",
      via: "agent",
      operation: "admin.outbox-retry",
    });
    expect((await auditOf("outbox.discarded"))[0]?.detail).toMatchObject({
      via: "agent",
      operation: "admin.outbox-discard",
    });
    // gone: the precheck refuses before the card
    expect(await op("admin.outbox-discard").precheck?.({ id: discardId }, ctx)).toMatchObject({
      ok: false,
      code: "outbox.not_found",
    });
  });
});
