import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { SettingsService } from "../identity/settings.js";
import { CacheService } from "../infra/cache/cache.service.js";
import { Cacheable } from "../infra/cache/cacheable.decorator.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { runOutsideTransaction, TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { costOf, PricesService, type PriceTable, priceKey } from "../models/prices.js";

/** Seam token of the kernel's own tests: a shorter statement timeout and a fixed clock. */
export const ADMIN_USAGE_TIMINGS = Symbol("ADMIN_USAGE_TIMINGS");

export interface AdminUsageTimings {
  /** The aggregate's `statement_timeout` in milliseconds (default 10 000). */
  statementTimeoutMs: number;
  /** The clock "today" is read from (default `Date.now`). */
  now: () => number;
}

/** Days in the window: today and the 6 days before. */
export const USAGE_WINDOW_DAYS = 7;
/** Orgs listed by name; the rest are summed in `otherOrgs`. */
export const USAGE_TOP_ORGS = 10;
/** Seconds one computed week stays cached (shared by every replica, Redis). */
export const USAGE_CACHE_TTL = 300;

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
/** SQLSTATE `query_canceled`: what `statement_timeout` raises. */
const QUERY_CANCELED = "57014";
/** SQLSTATE `invalid_parameter_value`: a zone `Intl` knows but PG's tzdata does not. */
const INVALID_PARAMETER_VALUE = "22023";

const sqlState = (err: unknown): unknown => (err as { code?: unknown } | null)?.code;

/** Tokens of one day; the four chat kinds do not overlap (plugin-sdk `ModelUsage`). */
export interface UsageTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Input tokens of `ctx.models.embed` calls (`model_usage`). */
  embedding: number;
}

/** One calendar day in the requested time zone. */
export interface UsageDay {
  /** `YYYY-MM-DD` in the answer's `tz`. */
  date: string;
  /** Runs created that day (every run: sub-agent and eval replay runs included, D6). */
  runs: number;
  tokens: UsageTokens;
  /**
   * Estimated cost in `currency` of the priced tokens; null when the day used tokens and none of
   * them had a price (0 for a day with no tokens).
   */
  cost: number | null;
}

/** One org's week: totals only (never per account, agent or conversation; spec §9). */
export interface UsageOrg {
  orgId: string;
  /** The org's name (its id when the org row is gone). */
  name: string;
  runs: number;
  /** Every token kind summed, embeddings included. */
  tokens: number;
  /** As {@link UsageDay.cost}, over the org's week. */
  cost: number | null;
}

/**
 * `AdminUsageService.week(tz)` (admin overview spec §4.3, §5.2): the platform's runs, tokens and
 * estimated cost per calendar day in `tz` over today and the 6 days before, and the 10 orgs that
 * used the most tokens (the rest summed in `otherOrgs`).
 */
export interface AdminUsageWeek {
  /** Start of the first day in `tz` (ISO 8601, UTC). */
  from: string;
  /** End of today in `tz`, exclusive (ISO 8601, UTC). */
  to: string;
  tz: string;
  /** The deployment setting `priceCurrency`. */
  currency: string;
  /** Exactly 7 days, oldest first, today last; days without usage are zeros. */
  days: UsageDay[];
  /** Some tokens of the week had no price: the costs count only the priced ones. */
  costPartial: boolean;
  /** At most 10, by total tokens descending (then runs, then id). */
  orgs: UsageOrg[];
  /** The orgs with usage outside the top 10, summed; `count` 0 when there are none. */
  otherOrgs: { count: number; runs: number; tokens: number; cost: number | null };
}

/** `YYYY-MM-DD` of `at` in `tz`. */
export function dateIn(tz: string, at: number): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(at));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** The calendar date `days` after `date` (`YYYY-MM-DD`; date arithmetic, no time zone involved). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

interface TokenRow {
  day: string;
  org_id: string;
  provider: string;
  model: string;
  input: string;
  output: string;
  cache_read: string;
  cache_write: string;
}
interface RunRow {
  day: string;
  org_id: string;
  runs: string;
}
interface EmbeddingRow {
  day: string;
  org_id: string;
  provider: string;
  model: string;
  input: string;
}

/** Cost accumulator: `priced` sums the priced groups; `unpriced` marks a group with tokens and no price. */
interface CostAcc {
  priced: number;
  anyPriced: boolean;
  unpriced: boolean;
}
const newCost = (): CostAcc => ({ priced: 0, anyPriced: false, unpriced: false });
const addCost = (acc: CostAcc, cost: number | null, tokens: number) => {
  if (cost !== null) {
    acc.priced += cost;
    acc.anyPriced = true;
  } else if (tokens > 0) {
    acc.unpriced = true;
  }
};
/** Rounded to 1e-6 (float noise); null when tokens were used and none was priced. */
const costValue = (acc: CostAcc): number | null =>
  !acc.anyPriced && acc.unpriced ? null : Math.round(acc.priced * 1e6) / 1e6;

/**
 * The admin overview's usage block (spec §4.3, §5.2, §5.4). Three grouped queries over a bounded
 * window (`conversation_events_usage_idx`, `runs_created_idx`, `model_usage_time_idx`) in one
 * read-only transaction with a statement timeout; priced here with the model price table. The
 * answer is cached in Redis for 300 s per time zone and first day, so every replica serves the
 * same answer and a zone is recomputed at most once per 5 minutes (prices or currency changed in
 * between show after the TTL). Aggregates only: no account, agent or conversation, no content.
 */
@Injectable()
export class AdminUsageService {
  private readonly statementTimeoutMs: number;
  private readonly now: () => number;

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(CacheService) readonly cacheService: CacheService,
    @Inject(PricesService) private readonly prices: Pick<PricesService, "table">,
    @Inject(SettingsService) private readonly settings: Pick<SettingsService, "get">,
    @Optional() @Inject(ADMIN_USAGE_TIMINGS) timings: Partial<AdminUsageTimings> = {},
  ) {
    this.statementTimeoutMs = timings.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
    this.now = timings.now ?? Date.now;
  }

  /**
   * The week ending today in `tz` (an IANA zone the caller validated, `IanaTimeZone`; normalized to
   * its canonical spelling, which the answer echoes and the cache key holds). Throws
   * `admin.usage_unavailable` (503) when the aggregate ran past its statement timeout, and
   * `validation_failed` (400) for a zone PG does not know.
   *
   * Never call it inside a transaction: it leaves the caller's context on purpose (inside one,
   * `@Cacheable` would be bypassed and the read-only transaction would hold a second connection).
   */
  async week(tz: string): Promise<AdminUsageWeek> {
    const zone = new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone;
    const firstDay = addDays(dateIn(zone, this.now()), -(USAGE_WINDOW_DAYS - 1));
    return runOutsideTransaction(() => this.cachedWeek(zone, firstDay));
  }

  /** The cache key holds the zone and the first day: a new day starts a new entry. */
  @Cacheable({ key: "admin-usage:#{0}:#{1}", ttl: USAGE_CACHE_TTL })
  protected async cachedWeek(tz: string, firstDay: string): Promise<AdminUsageWeek> {
    try {
      return await this.aggregate(tz, firstDay);
    } catch (err) {
      if (sqlState(err) === QUERY_CANCELED) {
        throw new ApiError(
          "admin.usage_unavailable",
          "The usage aggregate took too long; try again later",
        );
      }
      if (sqlState(err) === INVALID_PARAMETER_VALUE) {
        throw new ApiError(
          "validation_failed",
          `Unknown time zone ${tz}; pass an IANA time zone name, such as Asia/Shanghai`,
        );
      }
      throw err;
    }
  }

  /** The window's queries, in their own read-only transaction (the timeout must not leak into a caller's). */
  @Transactional({ propagation: "requires_new", accessMode: "read only" })
  protected async aggregate(tz: string, firstDay: string): Promise<AdminUsageWeek> {
    const db = this.db.db;
    // a SET takes no bind parameters; the value is an integer from config or the test seam
    await sql
      .raw(`SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(this.statementTimeoutMs))}`)
      .execute(db);
    const endDay = addDays(firstDay, USAGE_WINDOW_DAYS);
    // the zone's midnights as instants: PG applies the zone's rules, DST days included
    const bounds = await sql<{ from: Date; to: Date }>`
      SELECT (${firstDay}::date)::timestamp AT TIME ZONE ${tz} AS "from",
             (${endDay}::date)::timestamp AT TIME ZONE ${tz} AS "to"
    `.execute(db);
    const { from, to } = bounds.rows[0] as { from: Date; to: Date };
    const q = usageQueries(tz, from, to);
    const tokens = await q.tokens.execute(db);
    const runs = await q.runs.execute(db);
    const embeddings = await q.embeddings.execute(db);

    const [prices, settings] = await Promise.all([this.prices.table(), this.settings.get()]);
    const result = summarize({
      firstDay,
      tokens: tokens.rows,
      runs: runs.rows,
      embeddings: embeddings.rows,
      prices,
    });
    const orgIds = result.top.map((o) => o.orgId);
    const names =
      orgIds.length === 0
        ? []
        : await this.db
            .selectFrom("orgs")
            .select(["id", "name"])
            .where("id", "in", orgIds)
            .execute();
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      tz,
      currency: settings.priceCurrency,
      days: result.days,
      costPartial: result.costPartial,
      orgs: result.top.map((o) => ({ ...o, name: nameOf.get(o.orgId) ?? o.orgId })),
      otherOrgs: result.otherOrgs,
    };
  }
}

/**
 * The three grouped queries over `[from, to)` (spec §5.4), each on its time index:
 * `conversation_events_usage_idx`, `runs_created_idx`, `model_usage_time_idx`. Rows are bounded by
 * days × orgs (× models), not by events. Days are calendar days in `tz` (`YYYY-MM-DD` text, so no
 * driver turns them into local-time dates).
 */
export function usageQueries(tz: string, from: Date, to: Date) {
  // a malformed payload value (a string, null) counts 0 and a fraction is rounded, so one bad
  // event cannot fail the aggregate for its 7 days
  const tokenSum = (field: string) =>
    sql<string>`coalesce(sum(CASE WHEN jsonb_typeof(e.payload->${sql.lit(field)}) = 'number'
      THEN round((e.payload->>${sql.lit(field)})::numeric) END), 0)`;
  const day = (col: string) =>
    sql<string>`to_char((${sql.ref(col)} AT TIME ZONE ${tz})::date, 'YYYY-MM-DD')`;
  return {
    // chat tokens: every `usage` event (steps, compaction, titles, web fetch), by day × org × model
    tokens: sql<TokenRow>`
      SELECT ${day("e.created_at")} AS day, c.org_id,
             coalesce(e.payload->>'provider', '') AS provider,
             coalesce(e.payload->>'model', '') AS model,
             ${tokenSum("inputTokens")} AS input,
             ${tokenSum("outputTokens")} AS output,
             ${tokenSum("cacheReadTokens")} AS cache_read,
             ${tokenSum("cacheWriteTokens")} AS cache_write
      FROM capybara.conversation_events e
      JOIN capybara.conversations c ON c.id = e.conversation_id
      WHERE e.type = 'usage' AND e.created_at >= ${from} AND e.created_at < ${to}
      GROUP BY 1, 2, 3, 4
    `,
    // runs: every run (sub-agent and eval replay runs included, D6), by day × org
    runs: sql<RunRow>`
      SELECT ${day("r.created_at")} AS day, c.org_id, count(*) AS runs
      FROM capybara.runs r
      JOIN capybara.conversations c ON c.id = r.conversation_id
      WHERE r.created_at >= ${from} AND r.created_at < ${to}
      GROUP BY 1, 2
    `,
    // embeddings (`ctx.models.embed`), by day × org × model
    embeddings: sql<EmbeddingRow>`
      SELECT ${day("u.occurred_at")} AS day, u.org_id, u.provider, u.model,
             coalesce(sum(u.input_tokens), 0) AS input
      FROM capybara.model_usage u
      WHERE u.occurred_at >= ${from} AND u.occurred_at < ${to}
      GROUP BY 1, 2, 3, 4
    `,
  };
}

interface OrgAcc {
  orgId: string;
  runs: number;
  tokens: number;
  cost: CostAcc;
}

/** Folds the grouped rows into days and orgs, pricing each (provider, model) group. */
function summarize(input: {
  firstDay: string;
  tokens: TokenRow[];
  runs: RunRow[];
  embeddings: EmbeddingRow[];
  prices: PriceTable;
}): Pick<AdminUsageWeek, "days" | "costPartial" | "otherOrgs"> & {
  top: Omit<UsageOrg, "name">[];
} {
  const days = new Map<string, { day: Omit<UsageDay, "cost">; cost: CostAcc }>();
  for (let i = 0; i < USAGE_WINDOW_DAYS; i++) {
    const date = addDays(input.firstDay, i);
    days.set(date, {
      day: {
        date,
        runs: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, embedding: 0 },
      },
      cost: newCost(),
    });
  }
  const orgs = new Map<string, OrgAcc>();
  const org = (orgId: string): OrgAcc => {
    let o = orgs.get(orgId);
    if (!o) {
      o = { orgId, runs: 0, tokens: 0, cost: newCost() };
      orgs.set(orgId, o);
    }
    return o;
  };
  let costPartial = false;
  const price = (provider: string, model: string) => input.prices.get(priceKey(provider, model));

  for (const r of input.tokens) {
    const d = days.get(r.day);
    if (!d) continue; // outside the window (cannot happen: bounded by the same midnights)
    const usage = {
      inputTokens: Number(r.input),
      outputTokens: Number(r.output),
      cacheReadTokens: Number(r.cache_read),
      cacheWriteTokens: Number(r.cache_write),
    };
    const total =
      usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    const cost = costOf(usage, price(r.provider, r.model));
    if (cost === null && total > 0) costPartial = true;
    d.day.tokens.input += usage.inputTokens;
    d.day.tokens.output += usage.outputTokens;
    d.day.tokens.cacheRead += usage.cacheReadTokens;
    d.day.tokens.cacheWrite += usage.cacheWriteTokens;
    addCost(d.cost, cost, total);
    const o = org(r.org_id);
    o.tokens += total;
    addCost(o.cost, cost, total);
  }
  for (const r of input.embeddings) {
    const d = days.get(r.day);
    if (!d) continue;
    const n = Number(r.input);
    const cost = costOf(
      { inputTokens: n, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      price(r.provider, r.model),
    );
    if (cost === null && n > 0) costPartial = true;
    d.day.tokens.embedding += n;
    addCost(d.cost, cost, n);
    const o = org(r.org_id);
    o.tokens += n;
    addCost(o.cost, cost, n);
  }
  for (const r of input.runs) {
    const d = days.get(r.day);
    if (!d) continue;
    const n = Number(r.runs);
    d.day.runs += n;
    org(r.org_id).runs += n;
  }

  const ranked = [...orgs.values()].sort(
    (a, b) =>
      b.tokens - a.tokens ||
      b.runs - a.runs ||
      (a.orgId < b.orgId ? -1 : a.orgId > b.orgId ? 1 : 0),
  );
  const rest = ranked.slice(USAGE_TOP_ORGS);
  const restCost = newCost();
  for (const o of rest) {
    restCost.priced += o.cost.priced;
    restCost.anyPriced ||= o.cost.anyPriced;
    restCost.unpriced ||= o.cost.unpriced;
  }
  return {
    days: [...days.values()].map((d) => ({ ...d.day, cost: costValue(d.cost) })),
    costPartial,
    top: ranked.slice(0, USAGE_TOP_ORGS).map((o) => ({
      orgId: o.orgId,
      runs: o.runs,
      tokens: o.tokens,
      cost: costValue(o.cost),
    })),
    otherOrgs: {
      count: rest.length,
      runs: rest.reduce((s, o) => s + o.runs, 0),
      tokens: rest.reduce((s, o) => s + o.tokens, 0),
      cost: costValue(restCost),
    },
  };
}
