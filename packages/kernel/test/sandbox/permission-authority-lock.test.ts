import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  TransactionHost,
  withTransactionFence,
  withTransactionFencePrelude,
} from "../../src/infra/database/transaction-host.js";
import { XactLock } from "../../src/infra/database/xact-lock.js";
import { createLogger } from "../../src/log.js";
import { PermissionAuthorityEpochStore } from "../../src/sandbox/permission-authority-epochs.js";
import {
  PermissionAuthorityLock,
  PermissionLockOrderError,
} from "../../src/sandbox/permission-authority-lock.js";

let pg: TestContainer;
let pool: ReturnType<typeof createDb>;
let host: TransactionHost;
let lock: PermissionAuthorityLock;
let epochs: PermissionAuthorityEpochStore;
beforeAll(async () => {
  pg = await startTestPostgres();
  pool = createDb(pg.url, 8);
  await sql`create schema capybara`.execute(pool);
  await sql`create table capybara.orgs(id text primary key)`.execute(pool);
  await sql`insert into capybara.orgs values ('org')`.execute(pool);
  await sql`create table capybara.conversations(id text primary key,org_id text,device_id text)`.execute(
    pool,
  );
  await sql`insert into capybara.conversations values ('root','org',null),('other','org',null)`.execute(
    pool,
  );
  await sql`create table capybara.permission_authority_epochs(kind text,id text,revision integer default 0,primary key(kind,id))`.execute(
    pool,
  );
  host = new TransactionHost(pool, createLogger("error"));
  const db = new KernelDb(pool, host);
  lock = new PermissionAuthorityLock(db, host, new XactLock(db, host));
  epochs = new PermissionAuthorityEpochStore(db, host, lock);
});
afterAll(async () => {
  await pool?.destroy();
  await pg?.stop();
});
const subject = { orgId: "org", rootConversationId: "root" };
it("shared admissions coexist, root writer excludes its readers and unrelated roots progress", async () => {
  const held = deferred<void>();
  const release = deferred<void>();
  const reader = host.run(async () => {
    await lock.acquire(subject, { kind: "admit" });
    held.resolve();
    await release.promise;
  });
  await held.promise;
  await host.run(() => lock.acquire(subject, { kind: "admit" }));
  let acquired = false;
  const writer = host.run(async () => {
    await lock.acquire(subject, { kind: "write", level: "root" });
    acquired = true;
  });
  await expect
    .poll(async () =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*) n from pg_locks where locktype='advisory' and not granted`.execute(
            pool,
          )
        ).rows[0]?.n,
      ),
    )
    .toBe(1);
  await host.run(() =>
    lock.acquire({ ...subject, rootConversationId: "other" }, { kind: "admit" }),
  );
  expect(acquired).toBe(false);
  release.resolve();
  await Promise.all([reader, writer]);
  expect(acquired).toBe(true);
});
it("forbids upgrades and CAS without the matching writer; rollback restores epoch", async () => {
  await host.run(async () => {
    await lock.acquire(subject, { kind: "admit" });
    expect(await epochs.readLocked(subject)).toEqual({
      platform: 0,
      org: 0,
      device: null,
      root: 0,
    });
    await expect(lock.acquire(subject, { kind: "write", level: "root" })).rejects.toThrow();
    await expect(epochs.bumpLocked("root", "root", 0)).rejects.toThrow();
  });
  await expect(
    host.run(async () => {
      await lock.acquire(subject, { kind: "write", level: "root" });
      expect(await epochs.bumpLocked("root", "root", 0)).toBe(1);
      throw new Error("rollback");
    }),
  ).rejects.toThrow("rollback");
  await host.run(async () => {
    await lock.acquire(subject, { kind: "write", level: "root" });
    expect((await epochs.readLocked(subject)).root).toBe(0);
    await epochs.bumpLocked("root", "root", 0);
    await expect(epochs.bumpLocked("root", "root", 0)).rejects.toThrow();
  });
});
it("an ancestor ceiling writer excludes admissions while platform writes need no fabricated org", async () => {
  const held = deferred<void>(),
    release = deferred<void>();
  const writer = host.run(async () => {
    await lock.acquire({ orgId: "org" }, { kind: "write", level: "org" });
    held.resolve();
    await release.promise;
  });
  await held.promise;
  const reader = host.run(() => lock.acquire(subject, { kind: "admit" }));
  await expect
    .poll(async () =>
      Number(
        (
          await sql<{
            n: string;
          }>`select count(*) n from pg_locks where locktype='advisory' and not granted`.execute(
            pool,
          )
        ).rows[0]?.n,
      ),
    )
    .toBe(1);
  release.resolve();
  await Promise.all([reader, writer]);
  await host.run(async () => {
    await lock.acquire({}, { kind: "write", level: "platform" });
    expect(await epochs.bumpLocked("platform", "platform", 0)).toBe(1);
  });
  await expect(host.run(() => lock.acquire({}, { kind: "admit" }))).rejects.toThrow();
});
it("ordinary reads take shared locks only, require fixed-order whole-subject acquisition, and reject cross-org roots", async () => {
  await host.run(async () => {
    await lock.acquire(subject, { kind: "admit" });
    const modes = (
      await sql<{
        mode: string;
      }>`select mode from pg_locks where pid=pg_backend_pid() and locktype='advisory'`.execute(
        host.current() ?? pool,
      )
    ).rows.map((r) => r.mode);
    expect(modes).toEqual(["ShareLock", "ShareLock", "ShareLock"]);
    await expect(
      lock.acquire({ ...subject, rootConversationId: "other" }, { kind: "admit" }),
    ).rejects.toThrow("fixed order");
  });
  await sql`insert into capybara.orgs values ('another')`.execute(pool);
  await expect(
    host.run(() =>
      lock.acquire({ orgId: "another", rootConversationId: "root" }, { kind: "admit" }),
    ),
  ).rejects.toThrow("Conversation not found");
  await expect(epochs.readLocked(subject)).rejects.toThrow("mandatory");
});

it("inside a fenced transaction authority locks are taken only in the ordered prelude", async () => {
  // a fence that admitted the transaction (its conversation rows are held): no new authority lock
  await expect(
    withTransactionFence(
      async () => "exclusive",
      () => host.run(() => lock.acquire(subject, { kind: "admit" })),
    ),
  ).rejects.toThrow("only in its ordered prelude");
  // the prelude takes them inside the fence; the body may name the same, already held, subject
  await withTransactionFence(
    async ({ prelude }) => {
      await prelude?.();
      return "exclusive";
    },
    () =>
      withTransactionFencePrelude(
        () => lock.acquire(subject, { kind: "admit" }),
        () => host.run(() => lock.acquire(subject, { kind: "admit" })),
      ),
  );
  // an unfenced transaction keeps its ordinary acquisition
  await host.run(() => lock.acquire(subject, { kind: "admit" }));
  // a ceiling writer is held to the same order: its write lock after the fence's rows is refused
  // with the typed internal error naming the missing locks
  const err = await withTransactionFence(
    async () => "exclusive",
    () => host.run(() => lock.acquire(subject, { kind: "write", level: "root" })),
  ).then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PermissionLockOrderError);
  expect((err as PermissionLockOrderError).keys).toEqual([
    "permission-authority-platform-platform",
    "permission-authority-org-org",
    "permission-authority-root-root",
  ]);
  // and in its prelude it commits
  await withTransactionFence(
    async ({ prelude }) => {
      await prelude?.();
      return "exclusive";
    },
    () =>
      withTransactionFencePrelude(
        () => lock.acquire(subject, { kind: "write", level: "root" }),
        () => host.run(() => lock.acquire(subject, { kind: "write", level: "root" })),
      ),
  );
});

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
