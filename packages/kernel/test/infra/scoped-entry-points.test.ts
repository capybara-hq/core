import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { KernelConfigSchema } from "../../src/config/schema.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { setUnscopedQueryCheck } from "../../src/infra/database/org-scope.js";
import { createLogger } from "../../src/log.js";
import { accountsFor } from "../helpers/identity.js";
import { createOrg, PW, type Req, session, startKernel, type TestKernel } from "../helpers/runs.js";

// RLS phase 2 (spec §5.1): with `db.rls: scoped`, the entry points put a scope on the queries a
// request runs, so none of them reaches an org-scoped table unscoped.

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let owner: Req;
let orgId: string;

/** Org-scoped tables queried with no scope while `fn` ran. */
async function unscopedDuring(fn: () => Promise<unknown>): Promise<string[]> {
  const hits: string[] = [];
  setUnscopedQueryCheck((table) => hits.push(table));
  try {
    await fn();
  } finally {
    setUnscopedQueryCheck(undefined);
  }
  return hits;
}

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    KernelConfigSchema.parse({
      db: { url: pgc.url, poolMax: 5, rls: "scoped" },
      redis: { url: rd.url },
      masterKey: Buffer.alloc(32, 7).toString("base64"),
      marketplaces: { official: { enabled: false } },
      http: { port: 0 },
    }),
    { env: {}, logger: createLogger("error", { write: () => {} }) },
  );
  raw = createDb(pgc.url, 2);
  const accounts = accountsFor(kernelDb(raw));
  const { id } = await accounts.createLocal({ login: "root", password: PW, displayName: "Root" });
  await sql`update capybara.accounts set is_super_admin = true where id = ${id}`.execute(raw);
  owner = await session(k, "root");
  orgId = await createOrg(owner, "Scoped");
});

afterEach(() => setUnscopedQueryCheck(undefined));

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("entry points under db.rls scoped", () => {
  it("an org route runs its queries in the guarded org", async () => {
    const hits = await unscopedDuring(async () => {
      for (const url of [
        `/api/v1/orgs/${orgId}/agents`,
        `/api/v1/orgs/${orgId}/members`,
        `/api/v1/orgs/${orgId}/audit`,
      ]) {
        const res = await owner({ method: "GET", url });
        expect(res.statusCode, url).toBe(200);
      }
    });
    expect(hits.filter((t) => ["agents", "memberships", "audit_events"].includes(t))).toEqual([]);
  });

  it("a super admin route runs in the platform scope", async () => {
    const hits = await unscopedDuring(async () => {
      const res = await owner({ method: "GET", url: "/api/v1/admin/audit" });
      expect(res.statusCode).toBe(200);
    });
    expect(hits.filter((t) => t === "audit_events")).toEqual([]);
  });

  it("an API token is looked up in the platform scope before any org is known", async () => {
    const created = await owner({
      method: "POST",
      url: `/api/v1/orgs/${orgId}/service-tokens`,
      payload: { name: "ci", role: "member" },
    });
    expect([200, 201]).toContain(created.statusCode);
    const token = (created.json() as { token: string }).token;
    const hits = await unscopedDuring(async () => {
      const res = await k.http.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/agents`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
    expect(hits.filter((t) => t === "api_tokens" || t === "agents")).toEqual([]);
  });

  it("a personal access token reaches an org route in that org", async () => {
    const created = await owner({
      method: "POST",
      url: "/api/v1/me/tokens",
      payload: { name: "pat" },
    });
    expect([200, 201]).toContain(created.statusCode);
    const token = (created.json() as { token: string }).token;
    const hits = await unscopedDuring(async () => {
      const res = await k.http.inject({
        method: "GET",
        url: `/api/v1/orgs/${orgId}/members`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
    });
    expect(hits.filter((t) => t === "api_tokens" || t === "memberships")).toEqual([]);
  });

  it("a refused org route (not a member) still checks the membership inside that org's scope", async () => {
    const hits = await unscopedDuring(async () => {
      const res = await owner({ method: "GET", url: "/api/v1/orgs/no-such-org/agents" });
      expect(res.statusCode).toBe(404);
    });
    expect(hits.filter((t) => t === "memberships")).toEqual([]);
  });

  it("a public route runs unscoped and reads no org-scoped table", async () => {
    const hits = await unscopedDuring(async () => {
      const res = await k.http.inject({ method: "GET", url: "/api/v1/meta" });
      expect(res.statusCode).toBe(200);
    });
    expect(hits).toEqual([]);
  });
});
