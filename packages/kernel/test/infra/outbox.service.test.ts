import { fileURLToPath } from "node:url";
import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { type OutboxJob, OutboxService } from "../../src/infra/outbox/outbox.service.js";
import type { OutboxJobName } from "../../src/infra/outbox/registry.js";
import { createLogger, type KernelLogger } from "../../src/log.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, orgsFor } from "../helpers/identity.js";

/**
 * Transactional outbox spec §3.2, §4, §9: `OutboxService.add` writes the owed job in the caller's
 * transaction (and refuses to run outside one), a second add of the same (queue, jobId) is a no-op,
 * a conflicting add with other data throws under strict conflicts and logs otherwise, the fast path
 * gets the transaction's ids after the commit only, and an org's deletion takes its pending rows.
 */

/** A name no registry entry carries: the registry is checked at the type level only (R2). */
const TEST_JOB = "outbox-test-job" as OutboxJobName;

let pgc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pool has no schema types
let pool: Kysely<any>;
let db: KernelSchemaDb;
let host: TransactionHost;
let kdb: KernelDb;
let fastPath: ReturnType<typeof vi.fn<(ids: readonly string[]) => Promise<void>>>;
let log: KernelLogger;

const outboxWith = (strict: boolean) => new OutboxService(host, kdb, log, fastPath, strict);

const job = (jobId: string, data: unknown = { n: 1 }, extra: Partial<OutboxJob<unknown>> = {}) => ({
  queue: "cap-kernel-maintenance" as const,
  name: TEST_JOB,
  jobId,
  data,
  ...extra,
});

const rows = () =>
  db
    .selectFrom("outbox")
    .select(["id", "job_id", "data", "org_id", "run_at"])
    .orderBy("id")
    .execute();

beforeAll(async () => {
  pgc = await startTestPostgres();
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  pool = createDb(pgc.url, 5);
  db = kernelDb(pool);
  host = new TransactionHost(pool, createLogger("error", { write: () => {} }));
  kdb = new KernelDb(pool, host);
}, 120_000);

afterAll(async () => {
  await pool?.destroy();
  await pgc?.stop();
}, 120_000);

beforeEach(async () => {
  await truncateTables(pool, "capybara.outbox, capybara.accounts, capybara.orgs");
  fastPath = vi.fn(async (_ids: readonly string[]) => {});
  log = createLogger("error", { write: () => {} });
});

describe("OutboxService.add", () => {
  it("add outside a transaction throws", async () => {
    await expect(outboxWith(true).add(job("a"))).rejects.toThrow(/propagation "mandatory"/);
    expect(await rows()).toEqual([]);
  });

  it("add inside a committed transaction writes the row and hands its ids to the fast path after the commit", async () => {
    const outbox = outboxWith(true);
    const runAt = new Date(Date.now() + 60_000);
    let calledInside = false;
    const inserted = await host.run(async () => {
      const a = await outbox.add(job("a", { x: [1, 2] }, { runAt, orgId: "org-1" }));
      const b = await outbox.add(job("b"));
      calledInside = fastPath.mock.calls.length > 0;
      return [a, b];
    });
    expect(inserted).toEqual([true, true]);
    expect(calledInside).toBe(false);
    const stored = await rows();
    expect(stored).toMatchObject([
      { job_id: "a", data: { x: [1, 2] }, org_id: "org-1", run_at: runAt },
      { job_id: "b", data: { n: 1 }, org_id: null, run_at: null },
    ]);
    // one call per transaction, with every row it inserted
    expect(fastPath).toHaveBeenCalledTimes(1);
    expect(fastPath).toHaveBeenCalledWith(stored.map((r) => r.id));
  });

  it("add inside a rolled-back transaction leaves no row", async () => {
    const outbox = outboxWith(true);
    await expect(
      host.run(async () => {
        await outbox.add(job("a"));
        throw new Error("business write failed");
      }),
    ).rejects.toThrow("business write failed");
    expect(await rows()).toEqual([]);
    expect(fastPath).not.toHaveBeenCalled();
  });

  it("a second add of the same (queue, jobId) returns false and keeps one row", async () => {
    const outbox = outboxWith(true);
    expect(await host.run(() => outbox.add(job("a", { n: 1, at: "x" })))).toBe(true);
    // the same data (keys in another order) in a later transaction: a no-op
    expect(await host.run(() => outbox.add(job("a", { at: "x", n: 1 })))).toBe(false);
    // the same job id on another queue is another job
    expect(
      await host.run(() => outbox.add({ ...job("a"), queue: "cap-kernel-runs" as const })),
    ).toBe(true);
    expect((await rows()).map((r) => r.job_id)).toEqual(["a", "a"]);
    // the no-op transaction had nothing for the fast path
    expect(fastPath.mock.calls.map((c) => c[0].length)).toEqual([1, 1]);
  });

  it("a conflicting add with different data throws in tests", async () => {
    const outbox = outboxWith(true);
    await host.run(() => outbox.add(job("a", { n: 1 })));
    await expect(host.run(() => outbox.add(job("a", { n: 2 })))).rejects.toThrow(
      /outbox job id reused with different data/,
    );
    expect(await rows()).toMatchObject([{ job_id: "a", data: { n: 1 } }]);
  });

  it("a conflicting add with different data logs an error in production and returns false", async () => {
    const error = vi.fn();
    log = { ...createLogger("error", { write: () => {} }), error } as KernelLogger;
    const outbox = outboxWith(false);
    await host.run(() => outbox.add(job("a", { n: 1 })));
    expect(await host.run(() => outbox.add(job("a", { n: 2 })))).toBe(false);
    expect(error).toHaveBeenCalledWith(
      "outbox job id reused with different data",
      expect.objectContaining({ queue: "cap-kernel-maintenance", jobId: "a", job: TEST_JOB }),
    );
    expect(await rows()).toMatchObject([{ job_id: "a", data: { n: 1 } }]);
  });
});

describe("org deletion", () => {
  it("deleting an org removes its pending rows and keeps rows without org_id", async () => {
    const outbox = outboxWith(true);
    const accounts = accountsFor(pool);
    const orgs = orgsFor(pool);
    const alice = await accounts.createLocal({
      login: "alice",
      password: "correct horse battery",
      displayName: "Alice",
    });
    const gone = await orgs.create({ name: "Gone" }, alice);
    const kept = await orgs.create({ name: "Kept" }, alice);
    await host.run(async () => {
      await outbox.add(job("gone-pending", {}, { orgId: gone.id }));
      await outbox.add(job("gone-dead", {}, { orgId: gone.id }));
      await outbox.add(job("other-org", {}, { orgId: kept.id }));
      await outbox.add(job("platform"));
    });
    // a dead letter stays for the super admin's overview
    await db
      .updateTable("outbox")
      .set({ dead_at: new Date() })
      .where("job_id", "=", "gone-dead")
      .execute();

    await orgs.softDelete(gone.id, alice);

    expect((await rows()).map((r) => r.job_id)).toEqual(["gone-dead", "other-org", "platform"]);
  });
});
