import { randomUUID } from "node:crypto";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import type { Account } from "../../src/identity/accounts.js";
import { LockService } from "../../src/infra/lock/lock.service.js";
import { KERNEL_MIGRATIONS_DIR } from "../../src/kernel.js";
import { createLogger } from "../../src/log.js";
import { PushStaleJob } from "../../src/push/stale.job.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor, handlesFor } from "../helpers/identity.js";
import { PW } from "../helpers/runs.js";

/**
 * The daily prune of push registrations not seen for 60 days (mobile app spec §9.3), a
 * `@LockedCron` that runs once per tick across replicas.
 */

let pgc: TestContainer;
let rd: TestContainer;
let redis: Redis;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let alice: Account;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, { schema: "capybara", dir: KERNEL_MIGRATIONS_DIR });
  raw = createDb(pgc.url, 5);
  db = kernelDb(raw);
  redis = new Redis(rd.url);
});
afterAll(async () => {
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});
beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts");
  await redis.flushdb();
  alice = await accountsFor(db).createLocal({ login: "alice", password: PW, displayName: "A" });
});

const quiet = createLogger("error", { write: () => {} });
/** One replica's instance of the job (no scheduler scope: the tick marker alone decides). */
const job = () => new PushStaleJob(handlesFor(raw).db, new LockService(redis, quiet), quiet);

/** Inserts a registration last seen `days` ago; returns its id. */
async function seenDaysAgo(days: number): Promise<string> {
  const id = randomUUID();
  await db
    .insertInto("push_registrations")
    .values({
      id,
      account_id: alice.id,
      session_id: null,
      platform: "android",
      app_id: "com.example.app",
      provider: "fake-push",
      token_hash: randomUUID(),
      master_key_id: "k",
      token_ciphertext: Buffer.from("x"),
      locale: "en",
      device_name: "Phone",
      last_seen_at: sql<Date>`now() - make_interval(days => ${days})`,
    })
    .execute();
  return id;
}

const ids = async () =>
  (await db.selectFrom("push_registrations").select("id").execute()).map((r) => r.id).sort();

describe("PushStaleJob", () => {
  it("deletes only registrations last seen more than 60 days ago", async () => {
    const fresh = await seenDaysAgo(59);
    await seenDaysAgo(61);
    expect(await job().prune()).toBe(1);
    expect(await ids()).toEqual([fresh]);
  });

  it("deletes in batches until nothing stale is left", async () => {
    const fresh = await seenDaysAgo(1);
    await Promise.all(Array.from({ length: 503 }, () => seenDaysAgo(90)));
    expect(await job().prune()).toBe(503);
    expect(await ids()).toEqual([fresh]);
  });

  it("two holders of the same tick run the prune once", async () => {
    await seenDaysAgo(61);
    const a = job();
    const b = job();
    const pa = vi.spyOn(a, "prune");
    const pb = vi.spyOn(b, "prune");
    await Promise.all([a.sweep(), b.sweep()]);
    expect(pa.mock.calls.length + pb.mock.calls.length).toBe(1);
    expect(await ids()).toEqual([]);
  });
});
