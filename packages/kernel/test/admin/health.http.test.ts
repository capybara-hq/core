import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KERNEL_QUEUE_NAMES } from "../../src/admin/health.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { KERNEL_VERSION } from "../../src/version.js";
import { accountsFor, apiTokensFor, orgsFor, settingsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";

/**
 * `GET /api/v1/admin/overview/health` (admin overview spec §5.2, §11 health.http.test): the
 * answer's shape for a super admin; an org owner and a service token get 403; reading it is not
 * audited. The numbers themselves are pinned by health.test.ts.
 */

let pgc: TestContainer;
let rd: TestContainer;
let k: TestKernel;
let raw: ReturnType<typeof createDb>;
let root: Req;
let owner: Req;
let serviceToken: string;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  k = await startKernel(
    runConfig({ pg: pgc.url, redis: rd.url }, { roles: ["api", "worker"], extensions: [] }),
  );
  raw = createDb(pgc.url, 3);
  const db = kernelDb(raw);
  const accounts = accountsFor(db);
  await accounts.createLocal({
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
}, 180_000);

afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

describe("GET /api/v1/admin/overview/health", () => {
  it("answers the health of the platform to a super admin, unaudited", async () => {
    const db = kernelDb(raw);
    const before = await db.selectFrom("audit_events").select("id").execute();
    const res = await root({ method: "GET", url: "/api/v1/admin/overview/health" });
    expect(res.statusCode).toBe(200);
    const h = res.json() as Record<string, unknown>;
    expect(Object.keys(h).sort()).toEqual([
      "channels",
      "devices",
      "kernel",
      "queues",
      "replicas",
      "roles",
      "sandboxes",
      "unavailable",
    ]);
    expect(h).toMatchObject({
      kernel: { version: KERNEL_VERSION },
      roles: { api: 1, worker: 1, gateway: 0 },
      channels: { online: 0, offline: 0, webhook: 0, disabled: 0, error: 0 },
      devices: { online: 0, local: 0 },
      sandboxes: { running: 0, suspended: 0, byProvider: [] },
      unavailable: [],
    });
    expect(h.replicas).toEqual([
      {
        id: expect.any(String),
        roles: ["api", "worker"],
        version: KERNEL_VERSION,
        startedAt: expect.any(String),
        httpReplicaId: null,
      },
    ]);
    const queues = h.queues as Record<string, unknown>[];
    expect(queues.map((q) => q.name)).toEqual([...KERNEL_QUEUE_NAMES]);
    for (const q of queues) {
      expect(Object.keys(q).sort()).toEqual([
        "active",
        "delayed",
        "failed",
        "failedLastDay",
        "name",
        "waiting",
      ]);
    }
    // reads of aggregates are not audited (decision D5)
    expect(await db.selectFrom("audit_events").select("id").execute()).toEqual(before);
  });

  it("is for super admins only: an org owner and a service token get 403", async () => {
    const url = "/api/v1/admin/overview/health";
    expect((await owner({ method: "GET", url })).statusCode).toBe(403);
    const svc = await k.http.inject({
      method: "GET",
      url,
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(svc.statusCode).toBe(403);
  });
});
