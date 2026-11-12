import { fileURLToPath } from "node:url";
import { startTestPostgres, startTestRedis, type TestContainer } from "@capybara-hq/testing";
import { Redis } from "ioredis";
import { CompiledQuery, type Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AdminUsageService,
  type AdminUsageTimings,
  type AdminUsageWeek,
  usageQueries,
} from "../../src/admin/usage.service.js";
import { migrate } from "../../src/db/migrator.js";
import { createDb } from "../../src/db/pool.js";
import { ApiError } from "../../src/errors.js";
import { CacheService } from "../../src/infra/cache/cache.service.js";
import { createLogger } from "../../src/log.js";
import { PricesService } from "../../src/models/prices.js";
import { truncateTables } from "../helpers/db.js";
import { handlesFor, settingsFor } from "../helpers/identity.js";

/**
 * `AdminUsageService.week(tz)` (admin overview spec §4.3, §5.2, §5.4, §9, §11; D6): runs, tokens and
 * cost per calendar day in the reader's zone over 7 days, top 10 orgs + the rest, priced with the
 * price table, cached in Redis for every replica, on the three time indexes, bounded by a statement
 * timeout. Real PG + Redis.
 */

let pgc: TestContainer;
let rdc: TestContainer;
// biome-ignore lint/suspicious/noExplicitAny: test databases have no schema types
let raw: Kysely<any>;
const redisClients: Redis[] = [];
const quiet = createLogger("error", { write: () => {} });

/** The fixed "now": 2026-11-11 12:00 UTC (20:00 in Shanghai): today is 11-11 in both zones. */
const NOW = Date.parse("2026-11-11T12:00:00Z");

beforeAll(async () => {
  [pgc, rdc] = await Promise.all([startTestPostgres(), startTestRedis()]);
  await migrate(pgc.url, {
    schema: "capybara",
    dir: fileURLToPath(new URL("../../src/migrations", import.meta.url)),
  });
  raw = createDb(pgc.url, 5);
}, 180_000);

afterAll(async () => {
  for (const r of redisClients) r.disconnect();
  await raw?.destroy();
  await Promise.all([pgc?.stop(), rdc?.stop()]);
});

beforeEach(async () => {
  seq = 0;
  await truncateTables(
    raw,
    "capybara.accounts, capybara.orgs, capybara.model_prices, capybara.deployment_settings",
  );
  const r = new Redis(rdc.url);
  await r.flushall();
  r.disconnect();
});

/** One service as one replica builds it: its own Redis connection, the shared PG. */
function replica(timings: Partial<AdminUsageTimings> = {}): AdminUsageService {
  const h = handlesFor(raw);
  const redis = new Redis(rdc.url);
  redisClients.push(redis);
  return new AdminUsageService(
    h.db,
    h.txHost,
    new CacheService(redis, quiet),
    new PricesService(h.db, h.txHost, h.adminLock),
    settingsFor(raw, quiet),
    { now: () => NOW, ...timings },
  );
}

let seq = 0;
const ids = { account: "acc-1" };

async function seedOrg(id: string, name: string): Promise<{ conv: string; agent: string }> {
  await sql`INSERT INTO capybara.accounts (id, display_name) VALUES (${ids.account}, 'U')
    ON CONFLICT DO NOTHING`.execute(raw);
  await sql`INSERT INTO capybara.orgs (id, slug, name, created_by)
    VALUES (${id}, ${`s-${id}`}, ${name}, ${ids.account})`.execute(raw);
  const agent = `agent-${id}`;
  await sql`INSERT INTO capybara.agents (id, org_id, owner_account_id, visibility, current_version)
    VALUES (${agent}, ${id}, ${ids.account}, 'org', 1)`.execute(raw);
  const conv = await seedConversation(id, agent, "chat");
  return { conv, agent };
}

async function seedConversation(
  orgId: string,
  agentId: string,
  kind: "chat" | "eval" | "subagent",
  parent?: string,
): Promise<string> {
  const id = `conv-${orgId}-${++seq}`;
  await sql`INSERT INTO capybara.conversations
      (id, org_id, agent_id, account_id, kind, parent_conversation_id)
    VALUES (${id}, ${orgId}, ${agentId}, ${ids.account}, ${kind}, ${parent ?? null})`.execute(raw);
  return id;
}

async function seedRun(conv: string, at: string): Promise<void> {
  await sql`INSERT INTO capybara.runs
      (id, conversation_id, status, agent_version, trigger_account_id, created_at)
    VALUES (${`run-${++seq}`}, ${conv}, 'completed', 1, ${ids.account}, ${at})`.execute(raw);
}

async function seedUsage(
  conv: string,
  at: string,
  u: { model?: string; input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): Promise<void> {
  const payload = {
    step: 1,
    provider: "fake",
    model: u.model ?? "m1",
    inputTokens: u.input ?? 0,
    outputTokens: u.output ?? 0,
    cacheReadTokens: u.cacheRead ?? 0,
    cacheWriteTokens: u.cacheWrite ?? 0,
  };
  await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload, created_at)
    VALUES (${conv}, ${++seq}, 'usage', ${JSON.stringify(payload)}::jsonb, ${at})`.execute(raw);
}

async function seedEmbedding(orgId: string, at: string, tokens: number, model = "e1") {
  await sql`INSERT INTO capybara.model_usage
      (org_id, extension, purpose, provider, model, input_tokens, occurred_at)
    VALUES (${orgId}, 'memory', 'embedding', 'fake', ${model}, ${tokens}, ${at})`.execute(raw);
}

async function seedPrice(model: string, input: number, output: number): Promise<void> {
  await sql`INSERT INTO capybara.model_prices
      (provider, model, input_per_mtok, output_per_mtok, cache_read_per_mtok, cache_write_per_mtok)
    VALUES ('fake', ${model}, ${input}, ${output}, ${input / 10}, ${input * 2})`.execute(raw);
}

/**
 * Two orgs across 8 days (2026-11-04 .. 11-11 UTC). Alpha: a chat run + usage on 11-05, a sub-agent
 * and an eval replay run on 11-06, the day-edge event at 11-08 23:30 UTC, an embedding on 11-10, and
 * rows outside the window on both sides. Beta: one run + usage on 11-11.
 */
async function seedTwoOrgs(): Promise<void> {
  const a = await seedOrg("org-a", "Alpha");
  const b = await seedOrg("org-b", "Beta");
  // 11-04 12:00 UTC: outside both windows (Shanghai's starts 11-04 16:00 UTC)
  await seedRun(a.conv, "2026-11-04T12:00:00Z");
  await seedUsage(a.conv, "2026-11-04T12:00:00Z", { input: 999_000 });
  // 11-04 20:00 UTC: outside the UTC window, 11-05 04:00 in Shanghai (inside)
  await seedUsage(a.conv, "2026-11-04T20:00:00Z", { input: 7 });
  // 11-05
  await seedRun(a.conv, "2026-11-05T10:00:00Z");
  await seedUsage(a.conv, "2026-11-05T10:00:00Z", {
    input: 1000,
    output: 200,
    cacheRead: 300,
    cacheWrite: 40,
  });
  // 11-06: a sub-agent run and an eval replay run, each with its usage (D6)
  const sub = await seedConversation("org-a", a.agent, "subagent", a.conv);
  const evalConv = await seedConversation("org-a", a.agent, "eval");
  await seedRun(sub, "2026-11-06T09:00:00Z");
  await seedUsage(sub, "2026-11-06T09:00:00Z", { input: 100, output: 10 });
  await seedRun(evalConv, "2026-11-06T09:30:00Z");
  await seedUsage(evalConv, "2026-11-06T09:30:00Z", { input: 50, output: 5 });
  // 11-08 23:30 UTC = 11-09 07:30 in Shanghai: a run and an unpriced model's usage
  await seedRun(a.conv, "2026-11-08T23:30:00Z");
  await seedUsage(a.conv, "2026-11-08T23:30:00Z", { model: "m2", input: 500, output: 500 });
  // 11-10: an embedding call
  await seedEmbedding("org-a", "2026-11-10T08:00:00Z", 4000);
  // 11-11 18:00 UTC: today in UTC, tomorrow (11-12 02:00) in Shanghai
  await seedRun(a.conv, "2026-11-11T18:00:00Z");
  await seedUsage(a.conv, "2026-11-11T18:00:00Z", { input: 3 });
  // Beta, 11-11 10:00 UTC (18:00 in Shanghai)
  await seedRun(b.conv, "2026-11-11T10:00:00Z");
  await seedUsage(b.conv, "2026-11-11T10:00:00Z", { input: 20, output: 2 });
}

const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, embedding: 0 };
const tok = (t: Partial<typeof zero>) => ({ ...zero, ...t });

describe("AdminUsageService.week", () => {
  it("UTC: seven calendar days, zero-filled, every run kind and token source, no prices", async () => {
    await seedTwoOrgs();
    const week = await replica().week("UTC");
    expect(week).toEqual({
      from: "2026-11-05T00:00:00.000Z",
      to: "2026-11-12T00:00:00.000Z",
      tz: "UTC",
      currency: "USD",
      days: [
        {
          date: "2026-11-05",
          runs: 1,
          tokens: tok({ input: 1000, output: 200, cacheRead: 300, cacheWrite: 40 }),
          cost: null,
        },
        // the sub-agent run and the eval replay run both count (D6)
        { date: "2026-11-06", runs: 2, tokens: tok({ input: 150, output: 15 }), cost: null },
        { date: "2026-11-07", runs: 0, tokens: zero, cost: 0 },
        { date: "2026-11-08", runs: 1, tokens: tok({ input: 500, output: 500 }), cost: null },
        { date: "2026-11-09", runs: 0, tokens: zero, cost: 0 },
        { date: "2026-11-10", runs: 0, tokens: tok({ embedding: 4000 }), cost: null },
        { date: "2026-11-11", runs: 2, tokens: tok({ input: 23, output: 2 }), cost: null },
      ],
      costPartial: true,
      orgs: [
        {
          orgId: "org-a",
          name: "Alpha",
          runs: 5,
          tokens: 1540 + 165 + 1000 + 4000 + 3,
          cost: null,
        },
        { orgId: "org-b", name: "Beta", runs: 1, tokens: 22, cost: null },
      ],
      otherOrgs: { count: 0, runs: 0, tokens: 0, cost: 0 },
    });
  });

  it("Asia/Shanghai: the zone's midnights bound the window and an event at 23:30 UTC is the next day", async () => {
    await seedTwoOrgs();
    const week = await replica().week("Asia/Shanghai");
    expect(week.from).toBe("2026-11-04T16:00:00.000Z");
    expect(week.to).toBe("2026-11-11T16:00:00.000Z");
    expect(week.tz).toBe("Asia/Shanghai");
    expect(week.days.map((d) => [d.date, d.runs, d.tokens.input])).toEqual([
      // 11-04 20:00 UTC is 11-05 04:00 here
      ["2026-11-05", 1, 1007],
      ["2026-11-06", 2, 150],
      ["2026-11-07", 0, 0],
      ["2026-11-08", 0, 0],
      // 11-08 23:30 UTC is 11-09 07:30 here
      ["2026-11-09", 1, 500],
      ["2026-11-10", 0, 0],
      // 11-11 18:00 UTC is already 11-12 here: outside; Beta's 10:00 UTC is 18:00 today
      ["2026-11-11", 1, 20],
    ]);
  });

  it("prices each model group; an unpriced group adds tokens but no cost and marks costPartial", async () => {
    await seedTwoOrgs();
    // m1 priced (input 2 / output 10 per MTok, cache read 0.2, cache write 4), e1 priced; m2 not
    await seedPrice("m1", 2, 10);
    await seedPrice("e1", 0.5, 0);
    await sql`INSERT INTO capybara.deployment_settings (key, value) VALUES ('priceCurrency', '"CNY"')`.execute(
      raw,
    );
    const week = await replica().week("UTC");
    expect(week.currency).toBe("CNY");
    expect(week.costPartial).toBe(true);
    const cost = Object.fromEntries(week.days.map((d) => [d.date, d.cost]));
    expect(cost["2026-11-05"]).toBeCloseTo((1000 * 2 + 200 * 10 + 300 * 0.2 + 40 * 4) / 1e6, 9);
    expect(cost["2026-11-06"]).toBeCloseTo((150 * 2 + 15 * 10) / 1e6, 9);
    // only m2 that day: tokens without any price → null, not 0
    expect(cost["2026-11-08"]).toBeNull();
    expect(cost["2026-11-10"]).toBeCloseTo((4000 * 0.5) / 1e6, 9);
    expect(cost["2026-11-09"]).toBe(0);
    // Alpha's week: priced groups summed, m2 left out (partial)
    const alpha = week.orgs.find((o) => o.orgId === "org-a");
    expect(alpha?.cost).toBeCloseTo(
      (1000 * 2 + 200 * 10 + 300 * 0.2 + 40 * 4 + 150 * 2 + 15 * 10 + 3 * 2 + 4000 * 0.5) / 1e6,
      9,
    );

    // with m2 priced too nothing is partial
    await seedPrice("m2", 1, 1);
    const all = await replica().week("Europe/London");
    expect(all.costPartial).toBe(false);
    expect(all.days.every((d) => d.cost !== null)).toBe(true);
  });

  it("lists the 10 orgs with the most tokens and sums the rest", async () => {
    for (let i = 1; i <= 12; i++) {
      const id = `org-${String(i).padStart(2, "0")}`;
      const { conv } = await seedOrg(id, `Org ${i}`);
      await seedRun(conv, "2026-11-10T10:00:00Z");
      await seedUsage(conv, "2026-11-10T10:00:00Z", { input: i * 100 });
    }
    const week = await replica().week("UTC");
    expect(week.orgs.map((o) => o.orgId)).toEqual(
      [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map((i) => `org-${String(i).padStart(2, "0")}`),
    );
    expect(week.orgs[0]).toEqual({
      orgId: "org-12",
      name: "Org 12",
      runs: 1,
      tokens: 1200,
      cost: null,
    });
    expect(week.otherOrgs).toEqual({ count: 2, runs: 2, tokens: 300, cost: null });
    // no per-account, per-agent or per-conversation numbers (spec §9)
    expect(Object.keys(week).sort()).toEqual(
      ["costPartial", "currency", "days", "from", "orgs", "otherOrgs", "to", "tz"].sort(),
    );
    for (const o of week.orgs)
      expect(Object.keys(o).sort()).toEqual(["cost", "name", "orgId", "runs", "tokens"]);
  });

  it("serves a second call from the Redis cache, on this replica and on another", async () => {
    await seedTwoOrgs();
    const r1 = replica();
    const r2 = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q1 = vi.spyOn(r1 as any, "aggregate");
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q2 = vi.spyOn(r2 as any, "aggregate");
    const first = await r1.week("Asia/Shanghai");
    // new rows inside the window: a cached answer does not see them
    await seedRun("conv-org-a-1", "2026-11-10T10:00:00Z");
    const again = await r1.week("Asia/Shanghai");
    const other = await r2.week("Asia/Shanghai");
    expect(again).toEqual(first);
    expect(other).toEqual(first);
    expect(q1).toHaveBeenCalledTimes(1);
    expect(q2).not.toHaveBeenCalled();
    const ttl = await new Redis(rdc.url).ttl("cache:admin-usage:Asia/Shanghai:2026-11-05");
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
    // another zone is its own entry
    await r2.week("UTC");
    expect(q2).toHaveBeenCalledTimes(1);
  });

  it("each query reads its time index (EXPLAIN)", async () => {
    await seedTwoOrgs();
    const from = new Date("2026-11-04T16:00:00Z");
    const to = new Date("2026-11-11T16:00:00Z");
    const q = usageQueries("Asia/Shanghai", from, to);
    const plan = async (query: (typeof q)[keyof typeof q]) => {
      const compiled = query.compile(raw);
      // the seeded tables are tiny: the planner would rather scan them, so seq scans are switched
      // off for the EXPLAIN only (the question is whether the index can serve the bounded filter)
      return await raw.connection().execute(async (conn) => {
        await sql`SET enable_seqscan = off`.execute(conn);
        try {
          const res = await conn.executeQuery(
            CompiledQuery.raw(`EXPLAIN ${compiled.sql}`, [...compiled.parameters]),
          );
          return (res.rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
        } finally {
          await sql`RESET enable_seqscan`.execute(conn);
        }
      });
    };
    expect(await plan(q.tokens)).toContain("conversation_events_usage_idx");
    expect(await plan(q.runs)).toContain("runs_created_idx");
    expect(await plan(q.embeddings)).toContain("model_usage_time_idx");
  });

  it("a statement timeout is admin.usage_unavailable (503), not cached", async () => {
    await seedTwoOrgs();
    const svc = replica({ statementTimeoutMs: 300 });
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q = vi.spyOn(svc as any, "aggregate");
    // another session holds runs exclusively: the runs query waits past the statement timeout
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
      const err = await svc.week("UTC").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).code).toBe("admin.usage_unavailable");
      expect((err as ApiError).status).toBe(503);
    } finally {
      release();
      await holder;
    }
    // nothing was cached: another replica sharing the Redis computes the answer itself
    const other = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q2 = vi.spyOn(other as any, "aggregate");
    const week: AdminUsageWeek = await other.week("UTC");
    expect(week.days).toHaveLength(7);
    expect(q).toHaveBeenCalledTimes(1);
    expect(q2).toHaveBeenCalledTimes(1);
  });

  it("a zone PG does not know is validation_failed (400)", async () => {
    const svc = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    vi.spyOn(svc as any, "aggregate").mockRejectedValueOnce(
      Object.assign(new Error('time zone "X" not recognized'), { code: "22023" }),
    );
    const err = await svc.week("UTC").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("validation_failed");
    expect((err as ApiError).status).toBe(400);
  });

  it("normalizes the zone's spelling for the answer and the cache key", async () => {
    await seedTwoOrgs();
    const svc = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q = vi.spyOn(svc as any, "aggregate");
    const week = await svc.week("asia/shanghai");
    expect(week.tz).toBe("Asia/Shanghai");
    await svc.week("Asia/Shanghai");
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("counts malformed token values as 0 and rounds fractions instead of failing", async () => {
    const { conv } = await seedOrg("org-a", "Alpha");
    for (const inputTokens of [1.5, "x", null, "12"]) {
      const payload = { step: 1, provider: "fake", model: "m1", inputTokens, outputTokens: 1 };
      await sql`INSERT INTO capybara.conversation_events (conversation_id, seq, type, payload, created_at)
        VALUES (${conv}, ${++seq}, 'usage', ${JSON.stringify(payload)}::jsonb,
          '2026-11-10T10:00:00Z')`.execute(raw);
    }
    const week = await replica().week("UTC");
    const day = week.days.find((d) => d.date === "2026-11-10");
    // 1.5 rounds to 2; the string, the null and the numeric string count 0
    expect(day?.tokens).toEqual(tok({ input: 2, output: 4 }));
  });

  it("leaves a caller's transaction: still served from the cache, on its own connection", async () => {
    await seedTwoOrgs();
    const svc = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    const q = vi.spyOn(svc as any, "aggregate");
    const first = await svc.week("UTC");
    const inside = await handlesFor(raw).txHost.run(() => svc.week("UTC"));
    expect(inside).toEqual(first);
    expect(q).toHaveBeenCalledTimes(1);
  });

  it("other database errors propagate unchanged", async () => {
    const svc = replica();
    // biome-ignore lint/suspicious/noExplicitAny: spying on the protected inner query
    vi.spyOn(svc as any, "aggregate").mockRejectedValueOnce(
      Object.assign(new Error("boom"), { code: "XX000" }),
    );
    await expect(svc.week("UTC")).rejects.toThrow("boom");
  });
});
