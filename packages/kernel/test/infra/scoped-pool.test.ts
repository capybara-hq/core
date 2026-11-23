import { startTestPostgres, type TestContainer } from "@capybara-hq/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import {
  asPlatform,
  setUnscopedQueryCheck,
  withOrgScope,
} from "../../src/infra/database/org-scope.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";

// The scoped pool (RLS spec §5.2, phase 2): what each connection carries, with no policies.

let pgc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: the pools have no schema types
const pools: Kysely<any>[] = [];

// biome-ignore lint/suspicious/noExplicitAny: the pools have no schema types
function pool(rls: "off" | "scoped" | "enforce", max = 1): Kysely<any> {
  const p = createDb(pgc.url, max, () => {}, { rls });
  pools.push(p);
  return p;
}

interface Settings {
  org: string | null;
  scope: string | null;
  rls: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: the pools have no schema types
async function settings(db: Kysely<any> | KernelDb): Promise<Settings> {
  if (db instanceof KernelDb) return settings(db.db as Kysely<never>);
  const r = await sql<Settings>`select current_setting('capybara.org_id', true) as org,
    current_setting('capybara.scope', true) as scope,
    current_setting('capybara.rls', true) as rls`.execute(db);
  return r.rows[0] as Settings;
}

const none = (rls: string): Settings => ({ org: "", scope: "", rls });

beforeAll(async () => {
  pgc = await startTestPostgres();
  const setup = createDb(pgc.url, 1);
  await sql`create schema if not exists capybara`.execute(setup);
  await sql`create table if not exists capybara.scoped_probe (id text primary key, org_id text)`.execute(
    setup,
  );
  await sql`create table if not exists capybara.unscoped_probe (id text primary key)`.execute(
    setup,
  );
  await setup.destroy();
});

afterEach(() => setUnscopedQueryCheck(undefined));

afterAll(async () => {
  for (const p of pools) await p.destroy();
  await pgc?.stop();
});

describe("db.rls off", () => {
  it("sends nothing: the connection carries no setting, whatever the scope", async () => {
    const db = pool("off");
    const s = await withOrgScope("org-a", () => settings(db));
    expect(s.scope ?? "").toBe("");
    expect(s.org ?? "").toBe("");
    expect(s.rls ?? "").toBe("");
  });
});

describe("db.rls scoped", () => {
  it("puts the caller's scope on every pool query, empty values when unscoped", async () => {
    const db = pool("scoped");
    expect(await settings(db)).toEqual(none("off"));
    expect(await withOrgScope("org-a", () => settings(db))).toEqual({
      org: "org-a",
      scope: "org",
      rls: "off",
    });
    expect(await asPlatform("test", () => settings(db))).toEqual({
      org: "",
      scope: "platform",
      rls: "off",
    });
  });

  it("enforce sends capybara.rls = enforce", async () => {
    const db = pool("enforce");
    expect(await withOrgScope("org-b", () => settings(db))).toEqual({
      org: "org-b",
      scope: "org",
      rls: "enforce",
    });
  });

  it("never leaks a scope into the next user of a pooled connection", async () => {
    // one connection: every query below reuses the same backend
    const db = pool("scoped", 1);
    const pid = async () =>
      (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db)).rows[0]?.pid;
    const first = await withOrgScope("org-a", pid);
    expect(await settings(db)).toEqual(none("off"));
    expect(await pid()).toBe(first);
    await asPlatform("test", () => settings(db));
    expect(await withOrgScope("org-c", () => settings(db))).toMatchObject({ org: "org-c" });
    expect(await settings(db)).toEqual(none("off"));
  });

  it("sets the scope transaction-local right after BEGIN, and it ends with the transaction", async () => {
    const db = pool("scoped", 1);
    const host = new TransactionHost(db, createLogger("error"));
    const k = new KernelDb(db, host);
    // a session value from an earlier pool query in another org stays outside the transaction
    await withOrgScope("org-x", () => settings(k));
    const inside = await withOrgScope("org-a", () => host.run(() => settings(k)));
    expect(inside).toEqual({ org: "org-a", scope: "org", rls: "off" });
    // the next pool query on the same connection writes its own (unscoped) values first
    expect(await settings(k)).toEqual(none("off"));
  });

  it("a rolled-back transaction leaves no scope behind", async () => {
    const db = pool("scoped", 1);
    const host = new TransactionHost(db, createLogger("error"));
    const k = new KernelDb(db, host);
    await expect(
      withOrgScope("org-a", () =>
        host.run(async () => {
          await settings(k);
          throw new Error("boom");
        }),
      ),
    ).rejects.toThrow("boom");
    expect(await settings(k)).toEqual(none("off"));
  });

  it("a scope entered inside a transaction applies to its queries, then the outer one resumes", async () => {
    const db = pool("scoped", 1);
    const host = new TransactionHost(db, createLogger("error"));
    const k = new KernelDb(db, host);
    const seen = await withOrgScope("org-a", () =>
      host.run(async () => {
        const before = await settings(k);
        const platform = await asPlatform("deployment-wide check", () => settings(k));
        const other = await withOrgScope("org-b", () => settings(k));
        const after = await settings(k);
        return { before, platform, other, after };
      }),
    );
    expect(seen.before.org).toBe("org-a");
    expect(seen.platform.scope).toBe("platform");
    expect(seen.other.org).toBe("org-b");
    expect(seen.after).toEqual({ org: "org-a", scope: "org", rls: "off" });
  });

  it("concurrent queries of one transaction in different scopes each see their own", async () => {
    const db = pool("scoped", 1);
    const host = new TransactionHost(db, createLogger("error"));
    const k = new KernelDb(db, host);
    const results = await withOrgScope("org-a", () =>
      host.run(() =>
        Promise.all([
          settings(k),
          asPlatform("p", () => settings(k)),
          settings(k),
          withOrgScope("org-b", () => settings(k)),
          settings(k),
        ]),
      ),
    );
    expect(results.map((r) => (r.scope === "platform" ? "platform" : r.org))).toEqual([
      "org-a",
      "platform",
      "org-a",
      "org-b",
      "org-a",
    ]);
  });

  it("a requires_new transaction carries its own caller's scope", async () => {
    const db = pool("scoped", 2);
    const host = new TransactionHost(db, createLogger("error"));
    const k = new KernelDb(db, host);
    const inner = await withOrgScope("org-a", () =>
      host.run(() =>
        asPlatform("own transaction", () =>
          host.run(() => settings(k), { propagation: "requires_new" }),
        ),
      ),
    );
    expect(inner.scope).toBe("platform");
  });

  it("the unscoped-query check sees unscoped queries on org-scoped tables only", async () => {
    const db = pool("scoped", 1);
    const hits: string[] = [];
    setUnscopedQueryCheck((table) => hits.push(table));
    await db.withSchema("capybara").selectFrom("scoped_probe").selectAll().execute();
    await db.withSchema("capybara").selectFrom("unscoped_probe").selectAll().execute();
    await withOrgScope("org-a", () =>
      db.withSchema("capybara").selectFrom("scoped_probe").selectAll().execute(),
    );
    await sql`select * from capybara.scoped_probe`.execute(db);
    expect(hits).toEqual(["scoped_probe", "scoped_probe"]);
  });
});
