import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDb } from "../../src/db/pool.js";
import { afterCommit } from "../../src/infra/database/after-commit.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { StartupActivationError } from "../../src/infra/database/startup-activation-transaction.js";
import {
  runOutsideTransaction,
  TransactionHost,
  withTransactionFence,
} from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";

let pgc: TestContainer;
let pool: ReturnType<typeof createDb>;
let host: TransactionHost;
let db: KernelDb;
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const required = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error("Missing database fixture result");
  return value;
};
const options = (signal = new AbortController().signal) => ({
  connectionString: pgc.url,
  signal,
  remainingMs: () => 30_000,
});
const rows = async () =>
  (
    await sql<{ id: string }>`select id from capybara.startup_probe order by id`.execute(pool)
  ).rows.map((r) => r.id);
async function insert(id: string) {
  await sql`insert into capybara.startup_probe values (${id})`.execute(db.db);
}
beforeAll(async () => {
  pgc = await startTestPostgres();
  pool = createDb(pgc.url, 5);
  await sql`create schema capybara`.execute(pool);
  await sql`create table capybara.startup_probe (id text primary key)`.execute(pool);
  host = new TransactionHost(pool, createLogger("error", { write: () => {} }));
  db = new KernelDb(pool, host);
});
beforeEach(async () => {
  await sql`truncate capybara.startup_probe`.execute(pool);
});
afterAll(async () => {
  await pool?.destroy();
  await pgc?.stop();
});

it("uses the owned context for schema, inherited fence, mandatory writers and confirmed hooks", async () => {
  const pids: number[] = [];
  await withTransactionFence(
    async () => {
      pids.push(
        required(
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
        ).pid,
      );
      await insert("fence");
    },
    () =>
      host.runStartupActivation(async () => {
        expect(host.current()).toBeDefined();
        expect(db.db.isTransaction).toBe(true);
        const row = await host.run(
          async () => {
            await insert("body");
            return required(
              (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
            );
          },
          { propagation: "mandatory" },
        );
        pids.push(row.pid);
        afterCommit(async () => {
          expect(host.current()).toBeUndefined();
          await host.run(() => insert("hook"));
        });
      }, options()),
  );
  expect(pids[0]).toBe(pids[1]);
  expect(await rows()).toEqual(["body", "fence", "hook"]);
  expect(
    (
      await sql<{
        n: number;
      }>`select count(*)::int as n from pg_stat_activity where pid=${pids[0]}`.execute(pool)
    ).rows[0]?.n,
  ).toBe(0);
});

it("startup-final-commit-gate", async () => {
  const abort = new AbortController();
  const staged = gate();
  const finish = gate();
  let hooks = 0;
  const run = host.runStartupActivation(async () => {
    await insert("staged");
    afterCommit(() => {
      hooks++;
    });
    staged.resolve();
    await finish.promise;
  }, options(abort.signal));
  const result = run.catch((e: unknown) => e);
  await staged.promise;
  const start = performance.now();
  abort.abort();
  expect(await result).toBeInstanceOf(Error);
  expect(performance.now() - start).toBeLessThan(2_000);
  finish.resolve();
  expect(await rows()).toEqual([]);
  expect(hooks).toBe(0);
});

it("startup-owned-session-lock-abort", async () => {
  const blocker = new pg.Client({ connectionString: pgc.url });
  await blocker.connect();
  const abort = new AbortController();
  const entered = gate();
  let pid = 0;
  await blocker.query("begin");
  await blocker.query("select pg_advisory_xact_lock(619902)");
  const run = host.runStartupActivation(async () => {
    pid = required(
      (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
    ).pid;
    entered.resolve();
    await sql`select pg_advisory_xact_lock(619902)`.execute(db.db);
    await insert("late");
  }, options(abort.signal));
  const outcome = run.catch((e: unknown) => e);
  try {
    await entered.promise;
    await vi.waitFor(async () => {
      expect(
        (
          await pool
            .selectNoFrom(
              sql<boolean>`exists(select 1 from pg_locks where pid=${pid} and not granted)`.as(
                "waiting",
              ),
            )
            .executeTakeFirstOrThrow()
        ).waiting,
      ).toBe(true);
    });
    const start = performance.now();
    abort.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(performance.now() - start).toBeLessThan(2_000);
    await blocker.query("rollback");
    expect(await rows()).toEqual([]);
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_locks where pid=${pid}`.execute(pool)
        ).rows[0]?.n,
      ).toBe(0);
    });
  } finally {
    await blocker.end();
  }
});

it("startup-late-continuation-cannot-dispatch", async () => {
  const abort = new AbortController();
  const entered = gate();
  const resume = gate();
  const lateDone = gate();
  const errors: unknown[] = [];
  const run = host.runStartupActivation(async () => {
    const captured = required(host.current());
    await insert("rollback");
    entered.resolve();
    await resume.promise;
    for (const attempt of [
      () => sql`insert into capybara.startup_probe values ('captured')`.execute(captured),
      () => insert("context"),
      () => host.run(() => insert("new")),
      () => runOutsideTransaction(() => host.run(() => insert("outside"))),
    ]) {
      try {
        await attempt();
      } catch (e) {
        errors.push(e);
      }
    }
    lateDone.resolve();
  }, options(abort.signal));
  const outcome = run.catch((e: unknown) => e);
  await entered.promise;
  abort.abort();
  expect(await outcome).toBeInstanceOf(Error);
  resume.resolve();
  await lateDone.promise;
  expect(errors).toHaveLength(4);
  expect(await rows()).toEqual([]);
  await host.run(() => insert("shared-still-live"));
  expect(await rows()).toEqual(["shared-still-live"]);
});

it("refuses nesting and already-aborted startup without domain work", async () => {
  const abort = new AbortController();
  abort.abort();
  let entered = false;
  await expect(
    host.runStartupActivation(async () => {
      entered = true;
    }, options(abort.signal)),
  ).rejects.toThrow();
  expect(entered).toBe(false);
  await host.run(async () => {
    await expect(host.runStartupActivation(async () => {}, options())).rejects.toThrow(
      /existing transaction/,
    );
  });
  await host.runStartupActivation(async () => {
    await expect(host.run(async () => {}, { propagation: "requires_new" })).rejects.toThrow(
      /startup/,
    );
  }, options());
});

it("startup-commit-ack-uncertain", async () => {
  const abort = new AbortController();
  const dispatched = gate();
  const ack = gate();
  let hooks = 0;
  const original = pg.Client.prototype.query;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    const result = Reflect.apply(original, this, args);
    if (args[0] === "commit")
      return (result as Promise<unknown>).then(async (value) => {
        dispatched.resolve();
        await ack.promise;
        return value;
      });
    return result;
  } as typeof original);
  const run = host.runStartupActivation(async () => {
    await insert("committed-lost-ack");
    afterCommit(() => {
      hooks++;
    });
  }, options(abort.signal));
  const outcome = run.catch((e: unknown) => e);
  try {
    await dispatched.promise;
    abort.abort();
    expect(await outcome).toMatchObject({ outcome: "uncertain" });
    expect(await rows()).toEqual(["committed-lost-ack"]);
    expect(hooks).toBe(0);
  } finally {
    ack.resolve();
    spy.mockRestore();
  }
});

it("startup-abort-during-begin-and-setup", async () => {
  for (const phase of ["begin", "setup"] as const) {
    const abort = new AbortController();
    const entered = gate();
    const release = gate();
    const original = pg.Client.prototype.query;
    let domain = false;
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const result = Reflect.apply(original, this, args);
      if (args[0] === (phase === "begin" ? "begin" : "select 42 as setup"))
        return (result as Promise<unknown>).then(async (value) => {
          entered.resolve();
          await release.promise;
          return value;
        });
      return result;
    } as typeof original);
    const run = withTransactionFence(
      async () => {
        await sql`select 42 as setup`.execute(db.db);
      },
      () =>
        host.runStartupActivation(async () => {
          domain = true;
          await insert(phase);
        }, options(abort.signal)),
    );
    const outcome = run.catch((e: unknown) => e);
    try {
      await entered.promise;
      const at = performance.now();
      abort.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(performance.now() - at).toBeLessThan(2_000);
      release.resolve();
      expect(domain).toBe(false);
      expect(await rows()).toEqual([]);
    } finally {
      release.resolve();
      spy.mockRestore();
    }
  }
});

it("startup-abort-during-connect", async () => {
  const { createServer } = await import("node:net");
  const accepted = gate();
  const closed = gate();
  const server = createServer((socket) => {
    accepted.resolve();
    socket.on("data", () => {});
    socket.on("close", () => closed.resolve());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const abort = new AbortController();
  let domain = false;
  const run = host.runStartupActivation(
    async () => {
      domain = true;
    },
    {
      ...options(abort.signal),
      connectionString: `postgres://test:test@127.0.0.1:${(server.address() as { port: number }).port}/test`,
    },
  );
  const outcome = run.catch((e: unknown) => e);
  try {
    await accepted.promise;
    abort.abort();
    expect(await outcome).toBeInstanceOf(Error);
    await closed.promise;
    expect(domain).toBe(false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("queued owned work checks abort after dequeue", async () => {
  const abort = new AbortController();
  const entered = gate();
  let pid = 0;
  let query: Promise<unknown> | undefined;
  let queued: Promise<unknown> | undefined;
  const run = host.runStartupActivation(async () => {
    pid = required(
      (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
    ).pid;
    query = sql`select pg_sleep(10)`.execute(db.db).catch((e: unknown) => e);
    queued = insert("queued-late").catch((e: unknown) => e);
    entered.resolve();
    await Promise.all([query, queued]);
  }, options(abort.signal));
  const outcome = run.catch((e: unknown) => e);
  await entered.promise;
  await vi.waitFor(async () => {
    expect(
      (
        await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_stat_activity where pid=${pid} and wait_event='PgSleep') as waiting`.execute(
          pool,
        )
      ).rows[0]?.waiting,
    ).toBe(true);
  });
  abort.abort();
  expect(await outcome).toBeInstanceOf(Error);
  expect(await queued).toBeInstanceOf(Error);
  expect(await rows()).toEqual([]);
});

it("client read timeout cannot release queued domain work before server completion", async () => {
  const dsn = new URL(pgc.url);
  dsn.searchParams.set("query_timeout", "100");
  const abort = new AbortController(),
    entered = gate();
  const forwarded: string[] = [];
  const original = pg.Client.prototype.query;
  let owned: pg.Client | undefined;
  let pid = 0,
    settled = false;
  let queued: Promise<unknown> | undefined;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    if (args[0] === "begin") owned = this;
    if (this === owned && typeof args[0] === "string") forwarded.push(args[0]);
    return Reflect.apply(original, this, args);
  } as typeof original);
  const run = host.runStartupActivation(
    async () => {
      pid = required(
        (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
      ).pid;
      const query = sql`select pg_sleep(10)`
        .execute(db.db)
        .finally(() => {
          settled = true;
        })
        .catch((e: unknown) => e);
      queued =
        sql`select pg_advisory_xact_lock(614002); insert into capybara.startup_probe values ('client-timeout-late')`
          .execute(db.db)
          .catch((e: unknown) => e);
      entered.resolve();
      await Promise.all([query, queued]);
    },
    { ...options(abort.signal), connectionString: dsn.toString() },
  );
  const outcome = run.catch((e: unknown) => e);
  const control = new pg.Client({ connectionString: dsn.toString() });
  try {
    await entered.promise;
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            waiting: boolean;
          }>`select exists(select 1 from pg_stat_activity where pid=${pid} and wait_event='PgSleep') as waiting`.execute(
            pool,
          )
        ).rows[0]?.waiting,
      ).toBe(true);
    });
    // A separate real client read-timeout event establishes that the DSN's timeout elapsed.
    // Its query has no domain writes; no test sleep or retry controls this boundary.
    await control.connect();
    await expect(control.query("select pg_sleep(10)")).rejects.toThrow("Query read timeout");
    const prematurelySettled = settled;
    const forwardedBeforeAbort = [...forwarded];
    abort.abort();
    expect(await outcome).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    expect(prematurelySettled).toBe(false);
    expect(forwardedBeforeAbort.some((query) => query.includes("client-timeout-late"))).toBe(false);
    expect(
      forwarded.some((query) => query.includes("client-timeout-late") || query === "commit"),
    ).toBe(false);
    expect(await rows()).toEqual([]);
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_stat_activity where pid=${pid}`.execute(pool)
        ).rows[0]?.n,
      ).toBe(0);
    });
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_locks where locktype='advisory' and objid=614002`.execute(
          pool,
        )
      ).rows[0]?.n,
    ).toBe(0);
    await sql`insert into capybara.startup_probe values ('shared-after-client-timeout')`.execute(
      pool,
    );
    expect(await rows()).toEqual(["shared-after-client-timeout"]);
  } finally {
    abort.abort();
    await outcome;
    await control.end();
    spy.mockRestore();
  }
});

it.each(["options", "direct", "conflicting"])(
  "startup-cancel-unavailable-server-timeout: %s",
  async (spelling) => {
    const { createRequire } = await import("node:module");
    const Connection = createRequire(import.meta.url)("pg/lib/connection.js");
    const cancel = vi.spyOn(Connection.prototype, "cancel").mockImplementation(() => {});
    const original = pg.Client.prototype.query;
    const defaults: string[][] = [];
    let transactionDefaults: string[] = [];
    const dispatched: string[] = [];
    const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
      this: pg.Client,
      ...args: unknown[]
    ) {
      const query = args[0];
      if (typeof query === "string") dispatched.push(query);
      if (query === "begin") {
        // Observe actual server defaults before controlled BEGIN or any inherited fence SQL.
        return Reflect.apply(original, this, [
          "select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l, current_setting('idle_in_transaction_session_timeout') as i",
        ]).then((settings: pg.QueryResult) => {
          defaults.push(Object.values(settings.rows[0]) as string[]);
          return Reflect.apply(original, this, args);
        });
      }
      const value = Reflect.apply(original, this, args);
      if (query === "rollback")
        return (value as Promise<unknown>).then(async (result) => {
          const settings = await Reflect.apply(original, this, [
            "select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l, current_setting('idle_in_transaction_session_timeout') as i",
          ]);
          defaults.push(Object.values(settings.rows[0]) as string[]);
          return result;
        });
      return value;
    } as typeof original);
    const abort = new AbortController();
    const entered = gate();
    let pid = 0;
    const withDsn = new URL(pgc.url);
    if (spelling !== "direct")
      withDsn.searchParams.set(
        "options",
        "-c statement_timeout=0 -c lock_timeout=0 -c idle_in_transaction_session_timeout=0",
      );
    if (spelling !== "options")
      for (const key of [
        "statement_timeout",
        "lock_timeout",
        "idle_in_transaction_session_timeout",
      ])
        withDsn.searchParams.set(key, "30000");
    const run = host.runStartupActivation(
      async () => {
        const settings = required(
          (
            await sql<{
              s: string;
              l: string;
              i: string;
              pid: number;
            }>`select current_setting('statement_timeout') as s, current_setting('lock_timeout') as l, current_setting('idle_in_transaction_session_timeout') as i, pg_backend_pid() as pid`.execute(
              db.db,
            )
          ).rows[0],
        );
        transactionDefaults = [settings.s, settings.l, settings.i];
        pid = settings.pid;
        await insert("timeout-rollback");
        entered.resolve();
        await sql`select pg_sleep(10)`.execute(db.db);
      },
      { ...options(abort.signal), connectionString: withDsn.toString() },
    );
    const outcome = run.catch((e: unknown) => e);
    try {
      await entered.promise;
      await vi.waitFor(async () => {
        expect(
          (
            await sql<{
              waiting: boolean;
            }>`select exists(select 1 from pg_stat_activity where pid=${pid} and wait_event='PgSleep') as waiting`.execute(
              pool,
            )
          ).rows[0]?.waiting,
        ).toBe(true);
      });
      const start = performance.now();
      abort.abort();
      expect(await outcome).toBeInstanceOf(Error);
      expect(performance.now() - start).toBeLessThan(2_000);
      expect(await rows()).toEqual([]);
      expect(transactionDefaults).toEqual(["500ms", "500ms", "5s"]);
      expect(defaults).toEqual([
        ["500ms", "500ms", "5s"],
        ["500ms", "500ms", "5s"],
      ]);
      expect(dispatched.some((q) => /pg_(cancel|terminate)_backend/.test(q))).toBe(false);
      await vi.waitFor(async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int as n from pg_stat_activity where pid=${pid}`.execute(pool)
          ).rows[0]?.n,
        ).toBe(0);
      });
    } finally {
      spy.mockRestore();
      cancel.mockRestore();
    }
  },
);

it("startup-delayed-old-cancel-key-replacement-safe", async () => {
  const { createRequire } = await import("node:module");
  const Connection = createRequire(import.meta.url)("pg/lib/connection.js");
  let old: { pid: number; key: number } | undefined;
  const cancel = vi
    .spyOn(Connection.prototype, "cancel")
    .mockImplementation((...args: unknown[]) => {
      old = { pid: Number(args[0]), key: Number(args[1]) };
    });
  const abort = new AbortController();
  const entered = gate();
  const run = host.runStartupActivation(async () => {
    await insert("original");
    entered.resolve();
    await sql`select pg_sleep(10)`.execute(db.db);
  }, options(abort.signal));
  const outcome = run.catch((e: unknown) => e);
  await entered.promise;
  abort.abort();
  expect(await outcome).toBeInstanceOf(Error);
  cancel.mockRestore();
  expect(Boolean(old)).toBe(true);
  const oldIdentity = required(old);
  await vi.waitFor(async () => {
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where pid=${oldIdentity.pid}`.execute(
          pool,
        )
      ).rows[0]?.n,
    ).toBe(0);
  });
  const blocker = new pg.Client({ connectionString: pgc.url });
  const replacement = new pg.Client({ connectionString: pgc.url });
  blocker.on("error", () => {});
  replacement.on("error", () => {});
  await blocker.connect();
  await replacement.connect();
  const id = replacement as unknown as { processID: number; secretKey: number };
  const send = async (pid: number, key: number) => {
    const client = new pg.Client({ connectionString: pgc.url }) as unknown as {
      connection: {
        stream: import("node:net").Socket;
        on: (event: string, fn: () => void) => void;
        connect: (port: number, host: string) => void;
        cancel: (pid: number, key: number) => void;
      };
      connectionParameters: { host: string; port: number };
    };
    const conn = client.connection;
    await new Promise<void>((resolve, reject) => {
      conn.stream.on("error", reject);
      conn.stream.on("close", resolve);
      conn.on("connect", () => conn.cancel(pid, key));
      conn.connect(client.connectionParameters.port, client.connectionParameters.host);
    });
  };
  try {
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(619903)");
    await replacement.query("begin");
    const query = replacement.query("select pg_advisory_xact_lock(619903)");
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            waiting: boolean;
          }>`select exists(select 1 from pg_locks where pid=${id.processID} and not granted) as waiting`.execute(
            pool,
          )
        ).rows[0]?.waiting,
      ).toBe(true);
    });
    await send(oldIdentity.pid, oldIdentity.key);
    // Controlled-key check, not forced operating-system PID reuse: pair the old key with
    // the replacement PID and prove the server refuses that mismatched identity.
    expect(oldIdentity.key === id.secretKey).toBe(false);
    await send(id.processID, oldIdentity.key);
    expect(
      (
        await sql<{
          waiting: boolean;
        }>`select exists(select 1 from pg_locks where pid=${id.processID} and not granted) as waiting`.execute(
          pool,
        )
      ).rows[0]?.waiting,
    ).toBe(true);
    await blocker.query("rollback");
    await query;
    await replacement.query("insert into capybara.startup_probe values ('replacement')");
    await replacement.query("commit");
    expect(await rows()).toEqual(["replacement"]);
  } finally {
    await blocker.end();
    await replacement.end();
    cancel.mockRestore();
  }
});

it("absolute work deadline fences a late continuation without an external abort", async () => {
  const entered = gate(),
    resume = gate(),
    done = gate();
  let late: unknown;
  const run = host.runStartupActivation(
    async () => {
      await insert("deadline-rollback");
      entered.resolve();
      await resume.promise;
      try {
        await insert("deadline-late");
      } catch (e) {
        late = e;
      }
      done.resolve();
    },
    { ...options(), remainingMs: () => 250 },
  );
  const outcome = run.catch((e: unknown) => e);
  await entered.promise;
  expect(await outcome).toBeInstanceOf(Error);
  resume.resolve();
  await done.promise;
  expect(late).toBeInstanceOf(Error);
  expect(await rows()).toEqual([]);
});

it("rollback failure disposes the owned backend and reports uncertainty without exposing driver errors", async () => {
  const original = pg.Client.prototype.query;
  let pid = 0;
  const spy = vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    if (args[0] === "rollback") return Promise.reject(new Error("secret-rollback-driver-input"));
    return Reflect.apply(original, this, args);
  } as typeof original);
  try {
    const result = await host
      .runStartupActivation(async () => {
        pid = required(
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
        ).pid;
        await sql`select pg_advisory_xact_lock(619904)`.execute(db.db);
        await insert("rollback-dispose");
        throw new Error("secret-driver-failure");
      }, options())
      .catch((e: unknown) => e);
    expect(result).toMatchObject({ outcome: "uncertain" });
    expect(String(result)).not.toContain("secret-");
    await vi.waitFor(async () => {
      expect(
        (
          await sql<{
            n: number;
          }>`select count(*)::int as n from pg_locks where pid=${pid}`.execute(pool)
        ).rows[0]?.n,
      ).toBe(0);
    });
    expect(await rows()).toEqual([]);
    await sql`insert into capybara.startup_probe values ('shared-after-disposal')`.execute(pool);
    expect(await rows()).toEqual(["shared-after-disposal"]);
  } finally {
    spy.mockRestore();
  }
});

/** Blocks the event loop for `ms`, the way a descheduled or GC-paused process stalls. */
function stall(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    // busy wait: no timer, no I/O, nothing else runs
  }
}

it("a client pause of 600 ms between statements still commits (idle bound above client pauses)", async () => {
  await host.runStartupActivation(async () => {
    await insert("before-pause");
    stall(600);
    await insert("after-pause");
  }, options());
  expect(await rows()).toEqual(["after-pause", "before-pause"]);
});

it("a client pause longer than the idle bound fails closed and leaves nothing behind", async () => {
  let pid = 0;
  const outcome = await host
    .runStartupActivation(
      async () => {
        pid = required(
          (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db.db)).rows[0],
        ).pid;
        await insert("stalled");
        stall(300);
        await insert("never");
      },
      { ...options(), idleInTransactionTimeoutMs: 100 },
    )
    .catch((e: unknown) => e);
  expect(outcome).toBeInstanceOf(StartupActivationError);
  expect(await rows()).toEqual([]);
  await vi.waitFor(async () => {
    expect(
      (
        await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where pid=${pid}`.execute(pool)
      ).rows[0]?.n,
    ).toBe(0);
  });
});
