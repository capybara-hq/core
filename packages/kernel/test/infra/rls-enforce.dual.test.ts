import {
  createDualReplicaHarness,
  type Harness,
  replicaOf,
  startTestPostgres,
  type TestContainer,
} from "@capybara-hq/testing";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { rlsBypassReason } from "../../src/infra/database/rls-role.js";
import { accountsFor } from "../helpers/identity.js";
import { PW } from "../helpers/runs.js";

// RLS phase 3 across replicas (spec §5.2): two kernel processes with `db.rls: enforce`, connected
// as a role that is neither superuser nor BYPASSRLS (RLS never applies to those), serve two orgs'
// people at once. Every replica's pool carries one org's scope and then another's on the same
// connections; no response ever shows the other org's rows, whichever replica served it.

const ORG_A = "rls-dual-a";
const ORG_B = "rls-dual-b";

describe("RLS enforced on two replicas", () => {
  let pgc: TestContainer;
  let h: Harness;
  // biome-ignore lint/suspicious/noExplicitAny: raw pool without schema types
  let raw: Kysely<any>;
  let alice: string;
  let bob: string;
  const jars = new Map<string, Map<string, string>>();

  async function at(i: number, who: string, method: string, path: string, body?: unknown) {
    const jar = jars.get(who) ?? new Map<string, string>();
    jars.set(who, jar);
    const res = await fetch(`http://127.0.0.1:${h.replicas[i]?.port}${path}`, {
      method,
      headers: {
        "x-capybara-csrf": "1",
        cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    expect(replicaOf(res)).toBe(i);
    for (const c of res.headers.getSetCookie()) {
      const [pair = ""] = c.split(";");
      const eq = pair.indexOf("=");
      jar.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return { status: res.status, text: await res.text() };
  }

  beforeAll(async () => {
    pgc = await startTestPostgres();
    // a role that may create the harness's database (and so owns it) but bypasses nothing
    const admin = createDb(pgc.url, 1);
    const role = `rls_dual_${process.pid}`;
    await sql
      .raw(`create role ${role} login password 'rls' createdb nosuperuser nobypassrls`)
      .execute(admin);
    await admin.destroy();
    const u = new URL(pgc.url);
    u.username = role;
    u.password = "rls";
    h = await createDualReplicaHarness({
      extensions: [],
      pgUrl: u.toString(),
      config: { db: { rls: "enforce" } },
    });
    raw = createDb(h.dbUrl, 2);
    const accounts = accountsFor(kernelDb(raw));
    alice = (await accounts.createLocal({ login: "alice", password: PW, displayName: "Alice" })).id;
    bob = (await accounts.createLocal({ login: "bob", password: PW, displayName: "Bob" })).id;
    await sql`insert into capybara.orgs (id, slug, name) values
      (${ORG_A}, 'rls-dual-a', 'A'), (${ORG_B}, 'rls-dual-b', 'B')`.execute(raw);
    await sql`insert into capybara.memberships (org_id, account_id, role) values
      (${ORG_A}, ${alice}, 'owner'), (${ORG_B}, ${bob}, 'owner')`.execute(raw);
    for (const [who, i] of [
      ["alice", 0],
      ["bob", 1],
    ] as const) {
      const r = await at(i, who, "POST", "/api/v1/auth/login", { login: who, password: PW });
      expect(r.status, r.text).toBe(200);
    }
  });

  afterAll(async () => {
    await raw?.destroy();
    await h?.stop();
    await pgc?.stop();
  });

  it("the replicas' role is subject to the policies, which fail closed unscoped", async () => {
    // a superuser would pass every case below with no policy at all
    expect(await rlsBypassReason(raw)).toBeUndefined();
    const probe = createDb(h.dbUrl, 1, () => {}, { rls: "enforce" });
    try {
      const rows = await probe
        .withSchema("capybara")
        .selectFrom("memberships")
        .selectAll()
        .execute();
      expect(rows).toEqual([]);
    } finally {
      await probe.destroy();
    }
  });

  it("each org's people see only their org's rows, on both replicas, interleaved", async () => {
    // under enforce an unscoped membership check finds nothing (404): a 200 shows the replica put
    // the org scope on its connection, and the body that no other org's row came with it
    const calls = Array.from({ length: 24 }, (_, n) => {
      const who = n % 2 === 0 ? "alice" : "bob";
      const org = who === "alice" ? ORG_A : ORG_B;
      return at(Math.floor(n / 2) % 2, who, "GET", `/api/v1/orgs/${org}/members`).then((r) => ({
        who,
        ...r,
      }));
    });
    for (const r of await Promise.all(calls)) {
      expect(r.status, r.text).toBe(200);
      expect(r.text).toContain(r.who === "alice" ? alice : bob);
      expect(r.text).not.toContain(r.who === "alice" ? bob : alice);
    }
  });

  it("another org's route stays closed on either replica", async () => {
    for (const i of [0, 1]) {
      expect((await at(i, "alice", "GET", `/api/v1/orgs/${ORG_B}/members`)).status).toBe(404);
      expect((await at(i, "bob", "GET", `/api/v1/orgs/${ORG_A}/members`)).status).toBe(404);
    }
  });
});
