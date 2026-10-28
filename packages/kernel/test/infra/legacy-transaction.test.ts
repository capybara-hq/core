import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { Inject } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KernelSchemaDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { legacyCurrentTrx, legacyKernelView } from "../../src/infra/database/legacy-view.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { Transactional } from "../../src/infra/database/transactional.decorator.js";
import { createLogger } from "../../src/log.js";

// Ruling R8: the legacy view's transaction() runs through TransactionHost (requires_new), so a
// converted helper (KernelDb / @Transactional) called inside a legacy transaction joins it.

let pgc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pool has no schema types
let pool: Kysely<any>;
let host: TransactionHost;
let kdb: KernelDb;
let legacy: KernelSchemaDb;

beforeAll(async () => {
  pgc = await startTestPostgres();
  pool = createDb(pgc.url, 5);
  await sql`create schema if not exists capybara`.execute(pool);
  await sql`create table if not exists capybara.legacy_probe (id text primary key)`.execute(pool);
  host = new TransactionHost(pool, createLogger("error"));
  kdb = new KernelDb(pool, host);
  legacy = legacyKernelView(kdb, host);
}, 120_000);

afterAll(async () => {
  await pool?.destroy();
  await pgc?.stop();
}, 120_000);

const ids = async () =>
  (
    await sql<{ id: string }>`select id from capybara.legacy_probe order by id`.execute(pool)
  ).rows.map((r) => r.id);

/** A converted helper: KernelDb queries in a @Transactional method (REQUIRED: joins). */
class Converted {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  @Transactional()
  async insert(id: string): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: probe table is not in KernelDatabase
    await (this.db.insertInto as any)("legacy_probe").values({ id }).execute();
  }
}

const converted = () => new Converted(kdb, host);

describe("legacy transactions in the async context (R8)", () => {
  it("a converted helper called from a legacy transaction is rolled back with it", async () => {
    await expect(
      legacy.transaction().execute(async (t) => {
        // biome-ignore lint/suspicious/noExplicitAny: probe table is not in KernelDatabase
        await (t.insertInto as any)("legacy_probe").values({ id: "rb-legacy" }).execute();
        await converted().insert("rb-converted");
        throw new Error("legacy caller failed");
      }),
    ).rejects.toThrow("legacy caller failed");
    expect(await ids()).not.toContain("rb-legacy");
    expect(await ids()).not.toContain("rb-converted");
  });

  it("a converted helper sees the legacy transaction's uncommitted writes and commits with it", async () => {
    await legacy.transaction().execute(async (t) => {
      // biome-ignore lint/suspicious/noExplicitAny: probe table is not in KernelDatabase
      await (t.insertInto as any)("legacy_probe").values({ id: "c-legacy" }).execute();
      await converted().insert("c-converted");
      // the helper ran on the legacy transaction's connection: the row is visible there only
      const inside = await sql<{ n: number }>`select count(*)::int as n from capybara.legacy_probe
        where id in ('c-legacy', 'c-converted')`.execute(t);
      expect(inside.rows[0]?.n).toBe(2);
      expect(await ids()).not.toContain("c-converted");
    });
    expect(await ids()).toEqual(expect.arrayContaining(["c-converted", "c-legacy"]));
  });

  it("legacyCurrentTrx() is the legacy transaction; outside one it throws", async () => {
    await legacy.transaction().execute(async (t) => {
      const a = await sql<{ x: string }>`select txid_current()::text as x`.execute(t);
      const b = await sql<{ x: string }>`select txid_current()::text as x`.execute(
        legacyCurrentTrx(),
      );
      expect(b.rows[0]?.x).toBe(a.rows[0]?.x);
    });
    expect(() => legacyCurrentTrx()).toThrow(/outside a transaction/);
  });

  it("keeps requires_new: a legacy transaction inside a @Transactional one is separate", async () => {
    class Outer {
      constructor(@Inject(TransactionHost) readonly txHost: TransactionHost) {}
      @Transactional()
      async run(): Promise<void> {
        await legacy.transaction().execute(async (t) => {
          // biome-ignore lint/suspicious/noExplicitAny: probe table is not in KernelDatabase
          await (t.insertInto as any)("legacy_probe").values({ id: "rn-legacy" }).execute();
        });
        throw new Error("outer failed");
      }
    }
    await expect(new Outer(host).run()).rejects.toThrow("outer failed");
    expect(await ids()).toContain("rn-legacy");
  });

  it("passes the isolation level and access mode through", async () => {
    await legacy
      .transaction()
      .setIsolationLevel("repeatable read")
      .setAccessMode("read only")
      .execute(async (t) => {
        const r = await sql<{
          i: string;
          r: string;
        }>`select current_setting('transaction_isolation') as i,
          current_setting('transaction_read_only') as r`.execute(t);
        expect(r.rows[0]).toEqual({ i: "repeatable read", r: "on" });
      });
  });
});
