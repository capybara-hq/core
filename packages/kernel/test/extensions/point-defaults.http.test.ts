import {
  fakeExtensionEntry,
  startTestPostgres,
  startTestRedis,
  type TestContainer,
} from "@capybara-hq/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type KernelSchemaDb, kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { truncateTables } from "../helpers/db.js";
import { accountsFor } from "../helpers/identity.js";
import { testMembers } from "../helpers/members.js";
import {
  createOrg,
  PW,
  type Req,
  runConfig,
  session,
  startKernel,
  type TestKernel,
} from "../helpers/runs.js";

/** Web tools spec §6: the org default provider routes. */

let pgc: TestContainer;
let rd: TestContainer;
let raw: ReturnType<typeof createDb>;
let db: KernelSchemaDb;
let k: TestKernel;

beforeAll(async () => {
  [pgc, rd] = await Promise.all([startTestPostgres(), startTestRedis()]);
  raw = createDb(pgc.url, 3);
  db = kernelDb(raw);
  k = await startKernel(
    runConfig(
      { pg: pgc.url, redis: rd.url },
      {
        roles: ["api"],
        extensions: [fakeExtensionEntry("fake-web"), fakeExtensionEntry("fake-web-2")],
      },
    ),
  );
}, 180_000);
afterAll(async () => {
  await k?.close();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rd?.stop()]);
});

let owner: Req;
let member: Req;
let orgId: string;

const errCode = (r: { json(): unknown }) => (r.json() as { error?: { code?: string } }).error?.code;

beforeEach(async () => {
  await truncateTables(raw, "capybara.accounts, capybara.orgs, capybara.audit_events");
  const accounts = accountsFor(db);
  const ownerId = (await accounts.createLocal({ login: "owner", password: PW, displayName: "O" }))
    .id;
  const memberId = (await accounts.createLocal({ login: "mem", password: PW, displayName: "M" }))
    .id;
  owner = await session(k, "owner");
  orgId = await createOrg(owner);
  await testMembers(db).add(orgId, memberId, "member", ownerId);
  member = await session(k, "mem");
});

async function enable(plugin: string, token: string): Promise<void> {
  const r = await owner({
    method: "PUT",
    url: `/api/v1/orgs/${orgId}/extensions/${plugin}`,
    payload: { enabled: true, config: { token } },
  });
  expect(r.statusCode, r.body).toBe(200);
}

describe("org extension point defaults over HTTP", () => {
  it("GET lists both points; PUT sets a default (204); GET shows it effective", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    const before = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect(before.statusCode, before.body).toBe(200);
    expect(before.json()).toEqual({
      points: [
        {
          point: "web-search",
          candidates: ["fake-web", "fake-web-2"],
          default: null,
          effective: null,
        },
        {
          point: "web-fetch",
          candidates: ["fake-web", "fake-web-2"],
          default: null,
          effective: null,
        },
      ],
    });

    const put = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web-2" },
    });
    expect(put.statusCode, put.body).toBe(204);

    const after = await owner({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect((after.json() as { points: unknown[] }).points[0]).toEqual({
      point: "web-search",
      candidates: ["fake-web", "fake-web-2"],
      default: "fake-web-2",
      effective: "fake-web-2",
    });
  });

  it("PUT: 400 validation_failed for an extension that is not enabled or a bad body", async () => {
    const notEnabled = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web" },
    });
    expect(notEnabled.statusCode).toBe(400);
    expect(errCode(notEnabled)).toBe("validation_failed");
    const badBody = await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "" },
    });
    expect(badBody.statusCode).toBe(400);
    expect(errCode(badBody)).toBe("validation_failed");
  });

  it("a member: 403 on GET and PUT, 200 on /available without extension names", async () => {
    await enable("fake-web", "a");
    await enable("fake-web-2", "b");
    await owner({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-fetch/default`,
      payload: { extension: "fake-web" },
    });
    const put = await member({
      method: "PUT",
      url: `/api/v1/orgs/${orgId}/extension-points/web-search/default`,
      payload: { extension: "fake-web" },
    });
    expect(put.statusCode).toBe(403);
    const list = await member({ method: "GET", url: `/api/v1/orgs/${orgId}/extension-points` });
    expect(list.statusCode).toBe(403);

    const available = await member({
      method: "GET",
      url: `/api/v1/orgs/${orgId}/extension-points/available`,
    });
    expect(available.statusCode, available.body).toBe(200);
    expect(available.json()).toEqual({
      points: [
        { point: "web-search", available: false },
        { point: "web-fetch", available: true },
      ],
    });
    expect(available.body).not.toContain("fake-web");
  });
});
