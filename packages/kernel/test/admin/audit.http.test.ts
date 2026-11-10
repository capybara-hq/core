import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { audit } from "../../src/identity/audit.js";
import { accountsFor, apiTokensFor, orgsFor, settingsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * `GET /api/v1/admin/audit` (admin overview spec §5.2, §9, decision D2): the platform-level audit
 * log for super admins, keyset paged by id, never an org event, never `detail`.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let root: Req;
let owner: Req;
let serviceToken: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(runConfig({ pg: pgc.url, redis: rd.url }, { extensions: [] }));
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  const accounts = accountsFor(db);
  const rootAccount = await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    superAdmin: true,
  });
  const ownerAccount = await accounts.createLocal({
    login: "owner",
    password: PW,
    displayName: "Owner",
  });
  const tokens = apiTokensFor(db);
  const org = await orgsFor(db, settingsFor(db), tokens).create({ name: "Acme" }, ownerAccount);
  serviceToken = (
    await tokens.createService(org.id, { name: "svc", role: "admin", createdBy: ownerAccount.id })
  ).token;
  root = await session(k, "root");
  owner = await session(k, "owner");
  await db.deleteFrom("audit_events").execute();
  for (let i = 0; i < 25; i++) {
    await audit(db, {
      actorAccountId: rootAccount.id,
      action: "deployment.settings.updated",
      target: `t-${i}`,
      detail: { secretField: "never-shown" },
    });
  }
  await audit(db, { actorAccountId: rootAccount.id, orgId: org.id, action: "org.renamed" });
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

interface Page {
  events: { id: string; target: string; action: string; [k: string]: unknown }[];
  next: string | null;
}

describe("GET /api/v1/admin/audit", () => {
  it("pages platform events newest first: 20 by default, then after=next", async () => {
    const r = await root({ method: "GET", url: "/api/v1/admin/audit" });
    expect(r.statusCode, r.body).toBe(200);
    const first = r.json() as Page;
    expect(first.events).toHaveLength(20);
    expect(first.events[0]?.target).toBe("t-24");
    expect(first.next).toBe(first.events[19]?.id);
    const r2 = await root({
      method: "GET",
      url: `/api/v1/admin/audit?after=${first.next}&limit=100`,
    });
    const second = r2.json() as Page;
    expect(second.events.map((e) => e.target)).toEqual(["t-4", "t-3", "t-2", "t-1", "t-0"]);
    expect(second.next).toBeNull();
    // no org event, no detail
    expect([...first.events, ...second.events].some((e) => e.action === "org.renamed")).toBe(false);
    expect(r.body + r2.body).not.toContain("never-shown");
    expect(Object.keys(first.events[0] ?? {}).sort()).toEqual([
      "action",
      "actor",
      "at",
      "id",
      "target",
      "viaAgent",
      "viaToken",
    ]);
  });

  it("refuses bad limit and after values", async () => {
    for (const q of [
      "limit=0",
      "limit=101",
      "after=abc",
      "after=-1",
      "after=99999999999999999999",
    ]) {
      const r = await root({ method: "GET", url: `/api/v1/admin/audit?${q}` });
      expect(r.statusCode, q).toBe(400);
      expect((r.json() as { error: { code: string } }).error.code, q).toBe("validation_failed");
    }
  });

  it("is for super admins only: an org owner and a service token get 403", async () => {
    expect((await owner({ method: "GET", url: "/api/v1/admin/audit" })).statusCode).toBe(403);
    const svc = await k.http.inject({
      method: "GET",
      url: "/api/v1/admin/audit",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(svc.statusCode).toBe(403);
  });
});
