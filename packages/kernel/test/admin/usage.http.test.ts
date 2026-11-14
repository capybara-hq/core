import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { type Kysely, sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ADMIN_USAGE_TIMINGS, type AdminUsageWeek } from "../../src/admin/usage.service.js";
import { kernelDb } from "../../src/db/kernel-schema.js";
import { createDb } from "../../src/db/pool.js";
import { asUser, cookieJar } from "../helpers/http.js";
import { accountsFor, apiTokensFor, orgsFor, settingsFor } from "../helpers/identity.js";
import { PW, type Req, runConfig, session, startKernel, type TestKernel } from "../helpers/runs.js";
import { seedConversation } from "../helpers/tool-fixtures.js";

/**
 * `GET /api/v1/admin/overview/usage?tz=` (admin overview spec §5.2, §5.5, §11) on two replicas
 * sharing PG and Redis: the shape, a bad zone 400, non-super-admins 403, a timeout 503, and the
 * answer one replica computed served from the shared cache by the other.
 *
 * Two `startKernel` processes rather than `createDualReplicaHarness`: the harness builds kernels
 * through `startTestKernel`, which takes no seams, and the 503 case needs the
 * `ADMIN_USAGE_TIMINGS` statement-timeout seam on one replica.
 */

let pgc: TestContainer;
let rdc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
let raw: Kysely<any>;
let redis: Redis;
/** Default timings. */
let a: TestKernel;
/** A 300 ms statement timeout. */
let b: TestKernel;
let rootA: Req;
let rootB: Req;
let ownerReq: Req;
let serviceToken: string;
let conv: string;
let account: string;

const errCode = (res: { json(): unknown }) =>
  (res.json() as { error: { code: string } }).error.code;

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  const urls = { pg: pgc.url, redis: rdc.url };
  a = await startKernel(runConfig(urls, { roles: ["api"], extensions: [] }));
  b = await startKernel(runConfig(urls, { roles: ["api"], extensions: [] }), {
    overrides: [{ provide: ADMIN_USAGE_TIMINGS, useValue: { statementTimeoutMs: 300 } }],
  });
  raw = createDb(pgc.url, 3);
  redis = new Redis(rdc.url);
  const db = kernelDb(raw);
  const accounts = accountsFor(db);
  await accounts.createLocal({
    login: "root",
    password: PW,
    displayName: "Root",
    superAdmin: true,
  });
  const owner = await accounts.createLocal({ login: "owner", password: PW, displayName: "Owner" });
  const tokens = apiTokensFor(db);
  const org = await orgsFor(db, settingsFor(db), tokens).create({ name: "Owned" }, owner);
  serviceToken = (
    await tokens.createService(org.id, { name: "svc", role: "admin", createdBy: owner.id })
  ).token;
  rootA = await session(a, "root");
  // the same session cookie on the other replica (sessions live in PG / Redis)
  const jar = cookieJar();
  await asUser(
    b.http,
    jar,
  )({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { login: "root", password: PW },
  });
  rootB = asUser(b.http, jar);
  ownerReq = await session(a, "owner");
  const seeded = await seedConversation(raw);
  conv = seeded.conversationId;
  account = seeded.accountId;
  await seedRun();
  const payload = {
    step: 1,
    provider: "fake",
    model: "m1",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload)
    VALUES (${conv}, 1, 'usage', ${JSON.stringify(payload)}::jsonb)`.execute(raw);
});

afterAll(async () => {
  await a?.close();
  await b?.close();
  redis?.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

let runSeq = 0;
async function seedRun(): Promise<void> {
  await sql`INSERT INTO capybara.runs (id, conversation_id, status, agent_version, trigger_account_id)
    VALUES (${`run-${++runSeq}`}, ${conv}, 'completed', 1, ${account})`.execute(raw);
}

const usage = (req: Req, tz: string) =>
  req({ method: "GET", url: `/api/v1/admin/overview/usage?tz=${encodeURIComponent(tz)}` });

describe("GET /admin/overview/usage", () => {
  it("answers seven days, totals per org, served from the shared cache by the other replica", async () => {
    const res = await usage(rootA, "UTC");
    expect(res.statusCode, res.body).toBe(200);
    const week = res.json() as AdminUsageWeek;
    expect(Object.keys(week).sort()).toEqual(
      ["costPartial", "currency", "days", "from", "orgs", "otherOrgs", "to", "tz"].sort(),
    );
    expect(week.tz).toBe("UTC");
    expect(week.currency).toBe("USD");
    expect(week.days).toHaveLength(7);
    const today = week.days[6];
    expect(today).toMatchObject({ runs: 1, tokens: { input: 100, output: 20, embedding: 0 } });
    // no price for fake/m1: tokens without cost
    expect(today?.cost).toBeNull();
    expect(week.costPartial).toBe(true);
    expect(week.orgs).toEqual([
      { orgId: expect.any(String), name: "O", runs: 1, tokens: 120, cost: null },
    ]);
    expect(week.otherOrgs).toEqual({ count: 0, runs: 0, tokens: 0, cost: 0 });

    // a new run after the first read: the other replica answers from the cache, without it
    await seedRun();
    const other = await usage(rootB, "UTC");
    expect(other.statusCode, other.body).toBe(200);
    expect(other.json()).toEqual(week);
    const keys = await redis.keys("cache:admin-usage:UTC:*");
    expect(keys).toHaveLength(1);
  });

  it("refuses a missing or unknown zone with validation_failed", async () => {
    for (const url of [
      "/api/v1/admin/overview/usage",
      "/api/v1/admin/overview/usage?tz=Mars%2FOlympus",
      "/api/v1/admin/overview/usage?tz=",
    ]) {
      const res = await rootA({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(errCode(res)).toBe("validation_failed");
    }
  });

  it("is for super admins only: an org owner and a service token get 403", async () => {
    const res = await usage(ownerReq, "UTC");
    expect(res.statusCode).toBe(403);
    expect(errCode(res)).toBe("forbidden");
    const svc = await a.http.inject({
      method: "GET",
      url: "/api/v1/admin/overview/usage?tz=UTC",
      headers: { authorization: `Bearer ${serviceToken}` },
    });
    expect(svc.statusCode).toBe(403);
  });

  it("answers 503 admin.usage_unavailable when the aggregate runs past its timeout", async () => {
    // another session holds runs exclusively: replica b's runs query waits past its 300 ms
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => {
      locked = r;
    });
    const holder = raw.transaction().execute(async (trx) => {
      await sql`LOCK TABLE capybara.runs IN ACCESS EXCLUSIVE MODE`.execute(trx);
      locked();
      await held;
    });
    await isLocked;
    try {
      const res = await usage(rootB, "Europe/Paris");
      expect(res.statusCode, res.body).toBe(503);
      expect(errCode(res)).toBe("admin.usage_unavailable");
    } finally {
      release();
      await holder;
    }
    expect(await redis.keys("cache:admin-usage:Europe/Paris:*")).toEqual([]);
    expect((await usage(rootA, "Europe/Paris")).statusCode).toBe(200);
  });
});
