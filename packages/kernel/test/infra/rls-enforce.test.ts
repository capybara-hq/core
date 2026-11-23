import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KernelDb } from "../../src/infra/database/kernel-db.js";
import { asPlatform, withOrgScope } from "../../src/infra/database/org-scope.js";
import { rlsBypassReason } from "../../src/infra/database/rls-role.js";
import { TransactionHost } from "../../src/infra/database/transaction-host.js";
import { createLogger } from "../../src/log.js";
import { accountsFor } from "../helpers/identity.js";
import { PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

// RLS phase 3 (spec §4, §7): the policies of migration 0181, enforced. A kernel with
// `db.rls: enforce` migrates the database and serves HTTP; the database-level cases use pools of
// their own in each mode. Rows are seeded through a pool that sets nothing (admitted: the
// policies are off unless a connection enforces them). Everything connects as a role that is not
// a superuser and owns the database: Postgres never applies RLS to a superuser (spec §10).

let pgc: TestContainer;
/** The database URL as the non-superuser owner role. */
let url: string;
let rd: TestContainer;
let k: TestKernel;
// biome-ignore lint/suspicious/noExplicitAny: raw pools carry no schema types
let raw: Kysely<any>;
// biome-ignore lint/suspicious/noExplicitAny: raw pools carry no schema types
const pools: Kysely<any>[] = [];
const ORG_A = "rls-org-a";
const ORG_B = "rls-org-b";
let alice: string;
let bob: string;
let root: Req;
let aliceReq: Req;

// biome-ignore lint/suspicious/noExplicitAny: raw pools carry no schema types
function pool(rls: "off" | "scoped" | "enforce", max = 2): Kysely<any> {
  const p = createDb(url, max, () => {}, { rls });
  pools.push(p);
  return p;
}

const orgsOf = (rows: { org_id: string | null }[]) =>
  [...new Set(rows.map((r) => r.org_id))].sort();

// biome-ignore lint/suspicious/noExplicitAny: raw pools carry no schema types
const members = (db: Kysely<any>) =>
  db.withSchema("capybara").selectFrom("memberships").select("org_id").execute();

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const admin = createDb(pgc.url, 1);
  const role = `rls_kernel_${process.pid}`;
  await sql.raw(`create role ${role} login password 'rls' nosuperuser nobypassrls`).execute(admin);
  const dbName = new URL(pgc.url).pathname.slice(1);
  await sql.raw(`alter database "${dbName}" owner to ${role}`).execute(admin);
  await admin.destroy();
  const u = new URL(pgc.url);
  u.username = role;
  u.password = "rls";
  url = u.toString();
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url, poolMax: 5, rls: "enforce" },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(url, 2);
  const accounts = accountsFor(kernelDb(raw));
  alice = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
  bob = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
  const rootId = (await accounts.createLocal({ login: "root", password: PW, displayName: "Root" }))
    .id;
  await sql`update capybara.accounts set is_super_admin = true where id = ${rootId}`.execute(raw);
  await sql`insert into capybara.orgs (id, slug, name) values
    (${ORG_A}, 'rls-a', 'A'), (${ORG_B}, 'rls-b', 'B')`.execute(raw);
  await sql`insert into capybara.memberships (org_id, account_id, role) values
    (${ORG_A}, ${alice}, 'owner'), (${ORG_B}, ${bob}, 'owner')`.execute(raw);
  await sql`insert into capybara.audit_events (org_id, action) values
    (${ORG_A}, 'rls.a'), (${ORG_B}, 'rls.b'), (null, 'rls.platform')`.execute(raw);
  await sql`insert into capybara.model_disabled (org_id, provider, model) values
    (${ORG_A}, 'p', 'a-only'), (${ORG_B}, 'p', 'b-only'), (null, 'p', 'platform-default')`.execute(
    raw,
  );
  root = await session(k, "root");
  aliceReq = await session(k, "alice");
});

afterAll(async () => {
  for (const p of pools) await p.destroy();
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("RLS policies, dark", () => {
  it("cover every kernel table with an org_id column: enabled, forced, one policy", async () => {
    const r = await sql<{ table: string; enabled: boolean; forced: boolean; policies: number }>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
      from information_schema.columns col
      join pg_class c on c.relname = col.table_name
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = col.table_schema
      where col.table_schema = 'capybara' and col.column_name = 'org_id' and c.relkind = 'r'
      order by 1`.execute(raw);
    expect(r.rows.length).toBeGreaterThanOrEqual(59);
    expect(r.rows.filter((t) => !t.enabled || !t.forced || t.policies !== 1)).toEqual([]);
  });

  it("are bypassed by a superuser, which the kernel reports when enforcing", async () => {
    const admin = createDb(pgc.url, 1);
    try {
      expect(await rlsBypassReason(admin)).toBe("the database role is a superuser");
      // even an enforcing, unscoped superuser connection sees every row
      await sql`select set_config('capybara.rls', 'enforce', false)`.execute(admin);
      const n = await sql<{
        n: number;
      }>`select count(*)::int as n from capybara.memberships`.execute(admin);
      expect(n.rows[0]?.n).toBe(2);
    } finally {
      await admin.destroy();
    }
    expect(await rlsBypassReason(raw)).toBeUndefined();
  });

  it("admit every row while db.rls is off or scoped, and on connections that set nothing", async () => {
    expect(orgsOf(await members(raw))).toEqual([ORG_A, ORG_B]);
    expect(orgsOf(await members(pool("off")))).toEqual([ORG_A, ORG_B]);
    const scoped = pool("scoped");
    expect(orgsOf(await members(scoped))).toEqual([ORG_A, ORG_B]);
    expect(orgsOf(await withOrgScope(ORG_A, () => members(scoped)))).toEqual([ORG_A, ORG_B]);
  });
});

describe("RLS policies, enforced", () => {
  it("an unscoped connection sees no org row (fail closed)", async () => {
    const db = pool("enforce");
    expect(await members(db)).toEqual([]);
    const audit = await db
      .withSchema("capybara")
      .selectFrom("audit_events")
      .select("org_id")
      .execute();
    expect(audit).toEqual([]);
  });

  it("an org scope reads only its org's rows, and platform defaults where the table admits them", async () => {
    const db = pool("enforce");
    expect(orgsOf(await withOrgScope(ORG_A, () => members(db)))).toEqual([ORG_A]);
    const audit = await withOrgScope(ORG_A, () =>
      db.withSchema("capybara").selectFrom("audit_events").select("org_id").execute(),
    );
    // platform audit events are platform-only
    expect(orgsOf(audit)).toEqual([ORG_A]);
    const disabled = await withOrgScope(ORG_A, () =>
      db.withSchema("capybara").selectFrom("model_disabled").select(["org_id", "model"]).execute(),
    );
    // platform defaults (org_id null) are read by every org
    expect(disabled.map((d) => d.model).sort()).toEqual(["a-only", "platform-default"]);
  });

  it("an org scope cannot change, delete or write another org's rows", async () => {
    const db = pool("enforce");
    await withOrgScope(ORG_A, async () => {
      const upd = await db
        .withSchema("capybara")
        .updateTable("memberships")
        .set({ role: "guest" })
        .where("org_id", "=", ORG_B)
        .executeTakeFirst();
      expect(upd.numUpdatedRows).toBe(0n);
      const del = await db
        .withSchema("capybara")
        .deleteFrom("audit_events")
        .where("org_id", "=", ORG_B)
        .executeTakeFirst();
      expect(del.numDeletedRows).toBe(0n);
      await expect(
        db
          .withSchema("capybara")
          .insertInto("audit_events")
          .values({ org_id: ORG_B, action: "rls.cross" })
          .execute(),
      ).rejects.toThrow(/row-level security/);
      // moving an own row into another org fails the WITH CHECK too
      await expect(
        db
          .withSchema("capybara")
          .updateTable("audit_events")
          .set({ org_id: ORG_B })
          .where("action", "=", "rls.a")
          .execute(),
      ).rejects.toThrow(/row-level security/);
      // a platform default needs the platform scope to be written
      await expect(
        db
          .withSchema("capybara")
          .insertInto("model_disabled")
          .values({ org_id: null, provider: "p", model: "org-wrote-default" })
          .execute(),
      ).rejects.toThrow(/row-level security/);
    });
    const roles = await sql<{ role: string }>`select role from capybara.memberships
      where org_id = ${ORG_B}`.execute(raw);
    expect(roles.rows).toEqual([{ role: "owner" }]);
  });

  it("the platform scope reads and writes across orgs", async () => {
    const db = pool("enforce");
    await asPlatform("rls test", async () => {
      expect(orgsOf(await members(db))).toEqual([ORG_A, ORG_B]);
      await db
        .withSchema("capybara")
        .insertInto("model_disabled")
        .values({ org_id: null, provider: "p", model: "platform-wrote" })
        .execute();
    });
    const n = await sql<{ n: number }>`select count(*)::int as n from capybara.model_disabled
      where model = 'platform-wrote'`.execute(raw);
    expect(n.rows[0]?.n).toBe(1);
  });

  it("no scope leaks across one pooled connection: each checkout sees only its own", async () => {
    const db = pool("enforce", 1);
    for (let i = 0; i < 3; i++) {
      expect(orgsOf(await withOrgScope(ORG_A, () => members(db)))).toEqual([ORG_A]);
      expect(await members(db)).toEqual([]);
      expect(orgsOf(await asPlatform("p", () => members(db)))).toEqual([ORG_A, ORG_B]);
      expect(await members(db)).toEqual([]);
      expect(orgsOf(await withOrgScope(ORG_B, () => members(db)))).toEqual([ORG_B]);
    }
  });

  it("concurrent org scopes on a shared pool never see each other's rows", async () => {
    const db = pool("enforce", 3);
    const runs = Array.from({ length: 40 }, (_, i) => {
      const org = i % 2 === 0 ? ORG_A : ORG_B;
      return withOrgScope(org, async () => ({ org, seen: orgsOf(await members(db)) }));
    });
    for (const r of await Promise.all(runs)) expect(r.seen).toEqual([r.org]);
  });

  it("transactions carry their scope, and a nested scope applies to its queries only", async () => {
    const db = pool("enforce", 1);
    const host = new TransactionHost(db, createLogger("error"));
    const kdb = new KernelDb(db, host);
    const seen = await withOrgScope(ORG_A, () =>
      host.run(async () => {
        const own = orgsOf(await kdb.selectFrom("memberships").select("org_id").execute());
        const all = await asPlatform("deployment-wide existence check", async () =>
          orgsOf(await kdb.selectFrom("memberships").select("org_id").execute()),
        );
        const after = orgsOf(await kdb.selectFrom("memberships").select("org_id").execute());
        return { own, all, after };
      }),
    );
    expect(seen).toEqual({ own: [ORG_A], all: [ORG_A, ORG_B], after: [ORG_A] });
    expect(await members(db)).toEqual([]);
  });
});

describe("a kernel with db.rls enforce", () => {
  it("serves an org route from its org's rows", async () => {
    const res = await aliceReq({ method: "GET", url: `/api/v1/orgs/${ORG_A}/members` });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { members: { accountId?: string; account?: { id: string } }[] })
      .members;
    expect(JSON.stringify(ids)).toContain(alice);
    expect(JSON.stringify(ids)).not.toContain(bob);
  });

  it("refuses another org's route (no membership is visible there)", async () => {
    const res = await aliceReq({ method: "GET", url: `/api/v1/orgs/${ORG_B}/members` });
    expect(res.statusCode).toBe(404);
  });

  it("serves a super admin route across orgs through the platform scope", async () => {
    const platform = await root({ method: "GET", url: "/api/v1/admin/audit?limit=100" });
    expect(platform.statusCode).toBe(200);
    expect(JSON.stringify(platform.json())).toContain("rls.platform");
    // a super admin reads any org's events through the platform route
    for (const [org, action] of [
      [ORG_A, "rls.a"],
      [ORG_B, "rls.b"],
    ] as const) {
      const res = await root({ method: "GET", url: `/api/v1/admin/audit?orgId=${org}&limit=100` });
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).toContain(action);
    }
  });
});
