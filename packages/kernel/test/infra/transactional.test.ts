import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { Inject } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../src/db/pool.js";
import { afterCommit } from "../../src/infra/database/after-commit.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { Transactional } from "../../src/infra/database/transactional.decorator.js";
import { createLogger } from "../../src/log.js";

let pgc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pool has no schema types
let pool: Kysely<any>;
let host: TransactionHost;
let kdb: KernelDb;

beforeAll(async () => {
  pgc = await startTestPostgres();
  pool = createDb(pgc.url, 5);
  await sql`create schema if not exists capybara`.execute(pool);
  await sql`create table if not exists capybara.tx_probe (id text primary key)`.execute(pool);
  host = new TransactionHost(pool, createLogger("error"));
  kdb = new KernelDb(pool, host);
}, 120_000);

afterAll(async () => {
  await pool?.destroy();
  await pgc?.stop();
}, 120_000);

const ids = async () =>
  (await sql<{ id: string }>`select id from capybara.tx_probe`.execute(pool)).rows.map((r) => r.id);

async function insert(id: string) {
  // biome-ignore lint/suspicious/noExplicitAny: probe table is not in KernelDatabase
  await (kdb.insertInto as any)("tx_probe").values({ id }).execute();
}

class Svc {
  constructor(@Inject(TransactionHost) readonly txHost: TransactionHost) {}

  @Transactional()
  async inner(id: string, fail = false) {
    await insert(id);
    if (fail) throw new Error("inner failed");
  }

  @Transactional()
  async outer(id: string, throwAfter: boolean) {
    await this.inner(`${id}-inner`);
    await insert(id);
    if (throwAfter) throw new Error("outer failed");
  }

  @Transactional({ propagation: "requires_new" })
  async independent(id: string) {
    await insert(id);
  }

  @Transactional()
  async outerWithIndependent(id: string) {
    await this.independent(`${id}-independent`);
    await insert(id);
    throw new Error("outer failed");
  }

  @Transactional({ propagation: "mandatory" })
  async underCallersLock(id: string, fail = false) {
    await insert(id);
    if (fail) throw new Error("mandatory failed");
  }

  @Transactional()
  async callsMandatory(id: string, throwAfter: boolean) {
    await this.underCallersLock(`${id}-mandatory`);
    await insert(id);
    if (throwAfter) throw new Error("outer failed");
  }

  @Transactional()
  async withHook(id: string, order: string[], fail: boolean) {
    await insert(id);
    afterCommit(async () => {
      order.push(`hook:${(await ids()).includes(id)}`);
    });
    if (fail) throw new Error("boom");
    order.push("body-done");
  }
}

const svc = () => new Svc(host);

describe("TransactionHost and @Transactional", () => {
  it("nested REQUIRED calls share one transaction: an outer throw rolls back the inner row", async () => {
    await expect(svc().outer("n1", true)).rejects.toThrow("outer failed");
    expect((await ids()).filter((i) => i.startsWith("n1"))).toEqual([]);
    await svc().outer("n2", false);
    expect((await ids()).filter((i) => i.startsWith("n2")).sort()).toEqual(["n2", "n2-inner"]);
  });

  it("an inner throw rolls back everything when it escapes the outer", async () => {
    await expect(svc().inner("n3", true)).rejects.toThrow("inner failed");
    expect(await ids()).not.toContain("n3");
  });

  it("requires_new survives an outer rollback", async () => {
    await expect(svc().outerWithIndependent("r1")).rejects.toThrow("outer failed");
    const got = await ids();
    expect(got).toContain("r1-independent");
    expect(got).not.toContain("r1");
  });

  it("mandatory throws outside a transaction and writes nothing", async () => {
    await expect(svc().underCallersLock("m-alone")).rejects.toThrow(/mandatory/);
    expect(await ids()).not.toContain("m-alone");
    await expect(host.run(async () => "x", { propagation: "mandatory" })).rejects.toThrow(
      /no transaction in context/,
    );
  });

  it("mandatory joins the caller's transaction: it commits and rolls back with it", async () => {
    await svc().callsMandatory("m-ok", false);
    expect(await ids()).toEqual(expect.arrayContaining(["m-ok", "m-ok-mandatory"]));
    await expect(svc().callsMandatory("m-bad", true)).rejects.toThrow("outer failed");
    const now = await ids();
    expect(now).not.toContain("m-bad");
    expect(now).not.toContain("m-bad-mandatory");
  });

  it("current() is set only inside a transaction", async () => {
    expect(host.current()).toBeUndefined();
    await host.run(async () => {
      expect(host.current()).toBeDefined();
    });
    expect(host.current()).toBeUndefined();
  });

  it("KernelDb outside a transaction writes through the pool (committed immediately)", async () => {
    await insert("pool1");
    expect(await ids()).toContain("pool1");
  });

  it("KernelDb inside a transaction uses it: the row is invisible to the pool until commit", async () => {
    await host.run(async () => {
      await insert("vis1");
      expect(await ids()).not.toContain("vis1");
    });
    expect(await ids()).toContain("vis1");
  });

  it("afterCommit runs after COMMIT, not after rollback", async () => {
    const order: string[] = [];
    await svc().withHook("h1", order, false);
    expect(order).toEqual(["body-done", "hook:true"]);
    const order2: string[] = [];
    await expect(svc().withHook("h2", order2, true)).rejects.toThrow("boom");
    expect(order2).toEqual([]);
  });

  it("afterCommit outside a transaction runs immediately", async () => {
    let ran = false;
    afterCommit(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("a failing afterCommit hook does not fail the committed call", async () => {
    await host.run(async () => {
      afterCommit(() => {
        throw new Error("hook failed");
      });
    });
  });

  it("a continuation created inside the scope sees no transaction after the method returned", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let seen: unknown = "unset";
    let lateRan = false;
    let finished!: Promise<void>;
    const leaked = new Promise<void>((resolve) => {
      finished = host.run(async () => {
        setImmediate(() => {
          void gate.then(async () => {
            seen = host.current();
            // a KernelDb call falls back to the pool instead of the dead transaction
            await insert("leak1");
            afterCommit(() => {
              lateRan = true;
            });
            resolve();
          });
        });
      });
    });
    await finished;
    release();
    await leaked;
    expect(seen).toBeUndefined();
    expect(lateRan).toBe(true);
    expect(await ids()).toContain("leak1");
  });

  it("afterCommit outside a transaction logs a failing hook", async () => {
    const records: string[] = [];
    const log = createLogger("error", { write: (l) => records.push(l) });
    new TransactionHost(pool, log);
    afterCommit(() => {
      throw new Error("sync hook failed");
    });
    afterCommit(async () => {
      throw new Error("async hook failed");
    });
    await vi.waitFor(() => expect(records.join("\n")).toContain("async hook failed"));
    expect(records.join("\n")).toContain("sync hook failed");
    new TransactionHost(pool, createLogger("error"));
  });
});
