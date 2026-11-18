import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { Inject } from "@nestjs/common";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb } from "../../src/db/pool.js";
import { afterCommit } from "../../src/infra/database/after-commit.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFence,
  withTransactionFencePrelude,
} from "../../src/infra/database/transaction-host.js";
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
});

afterAll(async () => {
  await pool?.destroy();
  await pgc?.stop();
});

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

  /** A requires_new decision whose afterCommit hook writes (REQUIRED) after it commits. */
  @Transactional({ propagation: "requires_new" })
  async decideWithHook(id: string) {
    await insert(id);
    afterCommit(() => this.inner(`${id}-hook`));
  }

  @Transactional()
  async outerWithDecision(id: string) {
    await this.decideWithHook(`${id}-decision`);
    await insert(id);
    throw new Error("outer failed");
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
  it("checks an execution fence inside each new transaction and does not leak it into afterCommit", async () => {
    const fence = vi.fn(async () => {
      expect(host.current()).toBeDefined();
      throw new Error("execution revoked");
    });
    await expect(withTransactionFence(fence, () => svc().inner("fenced-write"))).rejects.toThrow(
      "execution revoked",
    );
    expect(await ids()).not.toContain("fenced-write");
    expect(fence).toHaveBeenCalledOnce();
    let allowed = true;
    await withTransactionFence(
      async () => {
        if (!allowed) throw new Error("execution revoked");
        afterCommit(() => {
          allowed = false;
        });
      },
      () => svc().decideWithHook("fenced-hook"),
    );
    expect(await ids()).toContain("fenced-hook-hook");
    await svc().inner("unscoped-write");
    expect(await ids()).toContain("unscoped-write");
  });

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

  it("the afterCommit hooks of a requires_new nested in an outer transaction run outside it", async () => {
    await expect(svc().outerWithDecision("h1")).rejects.toThrow("outer failed");
    const got = await ids();
    expect(got).toContain("h1-decision");
    // the hook's REQUIRED write opened its own transaction: the outer rollback does not undo it
    expect(got).toContain("h1-decision-hook");
    expect(got).not.toContain("h1");
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

it("ordered authority preludes run inside inherited fences, join nested writes and reject new nested transactions", async () => {
  const order: string[] = [];
  await withTransactionFence(
    async ({ shared, prelude }) => {
      expect(shared).toBe(false);
      // the org-level admission, then the authority prelude, then the conversation rows
      order.push("fence:org");
      await prelude?.();
      order.push("fence:conversations");
      await sql`select 1`.execute(kdb.db);
    },
    () =>
      withTransactionFencePrelude(
        async () => {
          order.push("authority");
          await sql`select 1`.execute(kdb.db);
        },
        () =>
          host.run(async () => {
            order.push("body");
            await host.run(async () => {
              order.push("joined");
            });
            await expect(
              host.run(
                async () => {
                  throw new Error("must not run");
                },
                { propagation: "requires_new" },
              ),
            ).rejects.toThrow("only one new transaction");
          }),
      ),
  );
  expect(order).toEqual(["fence:org", "authority", "fence:conversations", "body", "joined"]);
  // a fence that skips the prelude never admits the transaction without the authority locks
  await expect(
    withTransactionFence(
      async () => {},
      () =>
        withTransactionFencePrelude(
          async () => {},
          () => host.run(async () => "ran"),
        ),
    ),
  ).rejects.toThrow("did not run the ordered authority prelude");
  // without an inherited fence the prelude runs first in the new transaction
  const alone: string[] = [];
  await withTransactionFencePrelude(
    async () => {
      alone.push("authority");
    },
    () =>
      host.run(async () => {
        alone.push("body");
      }),
  );
  expect(alone).toEqual(["authority", "body"]);
  await expect(
    host.run(() =>
      withTransactionFencePrelude(
        async () => {},
        async () => {},
      ),
    ),
  ).rejects.toThrow("before opening a transaction");
});
