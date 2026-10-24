import { randomUUID } from "node:crypto";
import {
  type CatalogEntry,
  type CatalogIndex,
  type CatalogVersion,
  compatibleVersions,
  type Logger,
  type PackageKind,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { sql, type Transaction } from "kysely";
import semver from "semver";
import { type KernelConfig, MARKETPLACE_MAX_MIRRORS } from "../config/schema.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { DEPLOYMENT_SECRETS_ORG } from "../extensions/deployment-config.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { KERNEL_VERSION } from "../version.js";
import {
  fetchMarketplaceIndex,
  MarketplaceFetchError,
  MarketplaceInvalidError,
  marketplaceUrlProblem,
} from "./marketplace-fetch.js";

type Trx = Transaction<KernelDatabase>;

/** 官方清单来源的 id。 */
export const OFFICIAL_MARKETPLACE_ID = "official";
const OFFICIAL_MARKETPLACE_NAME = "Capybara official marketplace";
/** 企业清单的可选令牌：secrets 的 namespace `kernel`、org `_deployment`、键 `catalog-token:<id>`（preflight #65）。 */
const SECRETS_NAMESPACE = "kernel";
const tokenKey = (id: string) => `catalog-token:${id}`;

/** 拉取一份清单的超时。 */
export const MARKETPLACE_FETCH_TIMEOUT_MS = 30_000;
/**
 * Overall deadline of the periodic refresh of every marketplace (each URL also has its own
 * {@link MARKETPLACE_FETCH_TIMEOUT_MS}).
 */
export const MARKETPLACES_REFRESH_DEADLINE_MS = 600_000;
/** `entries()` 一次最多返回的条目数。 */
export const MARKETPLACE_ENTRIES_MAX = 5000;
const INSERT_BATCH = 500;
const MAX_ERROR_CHARS = 1000;
const MAX_TOKEN_CHARS = 4096;

/** 一个清单来源（后台列表）。令牌不回显，只给 `hasToken`。 */
export interface MarketplaceView {
  id: string;
  name: string;
  url: string;
  mirrors: string[];
  builtin: boolean;
  /** 生效的启用状态（official 还要配置 `marketplaces.official.enabled` 为 true）。 */
  enabled: boolean;
  /** official 被配置关闭（离线模式）；企业清单恒为 false。 */
  disabledByConfig: boolean;
  hasToken: boolean;
  etag: string | null;
  lastRefreshedAt: string | null;
  lastStatus: "ok" | "error" | "never";
  lastError: string | null;
  entryCount: number;
  createdAt: string;
}

/** 一个清单条目（后台浏览）。 */
export interface MarketplaceEntryView {
  sourceId: string;
  sourceName: string;
  kind: PackageKind;
  name: string;
  npm: string;
  publisher: string;
  summary: { en: string; zh?: string };
  permissions: { keys: string[]; sensitive: string[] } | null;
  versions: (CatalogVersion & { compatible: boolean })[];
  /** 已引入为目录条目（同 kind、同名、同一 npm 包的未删除条目）及其已有版本。 */
  adopted: { itemId: string; versions: string[] } | null;
  /** 已引入，且清单里有比已引入的最高版本更高的兼容版本（不自动引入）。 */
  newerAvailable: boolean;
}

export interface MarketplacesServiceDeps {
  db: KernelDb;
  config: () => KernelConfig;
  keyring: Keyring;
  log: Pick<Logger, "info" | "warn" | "error">;
  /** 测试可调短。 */
  fetchTimeoutMs?: number;
}

export interface ActorOpts {
  actorTokenId?: string;
}

/** A row of `marketplaces` (the result of selectAll). */
interface SourceRow {
  id: string;
  name: string;
  url: string;
  mirrors: string[];
  builtin: boolean;
  enabled: boolean;
  etag: string | null;
  last_refreshed_at: Date | null;
  last_status: "ok" | "error" | "never";
  last_error: string | null;
  created_at: Date;
}

const notFound = () => new ApiError("marketplace.not_found", "Marketplace not found");
const builtinErr = (what: string) =>
  new ApiError(
    "marketplace.builtin",
    `The official marketplace is configured in marketplaces.official.*; it cannot be ${what} here (only enabled or disabled)`,
  );

/** 宿主版本（清单条目的 minKernel / minSdk 按它判断兼容）。 */
export const HOST_VERSIONS = { kernel: KERNEL_VERSION, sdk: SDK_VERSION } as const;

/** 来源是否生效：本身启用，official 还要配置没关。 */
export const sourceEffective = (
  row: { builtin: boolean; enabled: boolean },
  config: KernelConfig,
): boolean => row.enabled && (!row.builtin || config.marketplaces.official.enabled);

/**
 * Reads a marketplace entry for import: marketplace missing -> `marketplace.not_found`;
 * marketplace disabled (official offline included) or entry missing -> `marketplace.entry_not_found`.
 */
export async function loadMarketplaceEntry(
  db: KernelDb,
  config: KernelConfig,
  sourceId: string,
  kind: PackageKind,
  name: string,
): Promise<{ sourceName: string; entry: CatalogEntry }> {
  const src = await db
    .selectFrom("marketplaces")
    .select(["name", "builtin", "enabled"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!src) throw notFound();
  const row = sourceEffective(src, config)
    ? await db
        .selectFrom("marketplace_entries")
        .select("entry")
        .where("source_id", "=", sourceId)
        .where("kind", "=", kind)
        .where("name", "=", name)
        .executeTakeFirst()
    : undefined;
  if (!row) {
    throw new ApiError(
      "marketplace.entry_not_found",
      `Marketplace entry ${kind} ${name} not found`,
    );
  }
  return { sourceName: src.name, entry: row.entry as CatalogEntry };
}

/**
 * Marketplaces (D16 / C25 / C26, `/api/v1/admin/marketplaces/*`, enterprise admins only): the official
 * marketplace (config `marketplaces.official.*`, synced at startup into the marketplace with id
 * `official`) and enterprise marketplaces (PG, optional token in secrets). A refresh (maintenance
 * job `catalogs-refresh` every `marketplaces.refreshIntervalMinutes` minutes, or manual) tries the main
 * URL and then the mirrors with If-None-Match; on success it replaces that marketplace's cached
 * entries as a whole, when all fail (an invalid index included) it keeps the previous ones with
 * status `error`. A status change audits `marketplace.refreshed` and logs once. Stateless, shared
 * by every replica.
 */
export class MarketplacesService {
  constructor(private readonly d: MarketplacesServiceDeps) {}

  /** 按配置建 / 更新 official 来源（名字、地址、镜像；不动后台的启停）。每个副本启动时调用，幂等。 */
  async syncOfficialFromConfig(): Promise<void> {
    const o = this.d.config().marketplaces.official;
    const mirrors = JSON.stringify(o.mirrors);
    await this.d.db
      .insertInto("marketplaces")
      .values({
        id: OFFICIAL_MARKETPLACE_ID,
        name: OFFICIAL_MARKETPLACE_NAME,
        url: o.url,
        mirrors,
        builtin: true,
        enabled: true,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: OFFICIAL_MARKETPLACE_NAME,
          url: o.url,
          mirrors,
          builtin: true,
          // 地址变了，旧 ETag 不再适用（条目保留到下次刷新）
          etag: sql<
            string | null
          >`CASE WHEN marketplaces.url = excluded.url THEN marketplaces.etag ELSE NULL END`,
        }),
      )
      .execute();
  }

  /** 全部来源（official 在前，其余按创建时间）。 */
  async list(): Promise<MarketplaceView[]> {
    const rows = (await this.d.db
      .selectFrom("marketplaces")
      .selectAll()
      .orderBy("builtin", "desc")
      .orderBy("created_at")
      .orderBy("id")
      .execute()) as unknown as SourceRow[];
    return this.views(rows);
  }

  async get(id: string): Promise<MarketplaceView> {
    const row = (await this.d.db
      .selectFrom("marketplaces")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) as unknown as SourceRow | undefined;
    if (!row) throw notFound();
    return (await this.views([row]))[0] as MarketplaceView;
  }

  /**
   * Adds an enterprise marketplace (audit `marketplace.added`). URL and mirrors must be https,
   * without user info.
   */
  async add(
    actor: string,
    input: { name: string; url: string; mirrors?: string[]; token?: string },
    opts: ActorOpts = {},
  ): Promise<MarketplaceView> {
    const name = this.checkName(input.name);
    this.checkUrls(input.url, input.mirrors ?? []);
    if (input.token !== undefined) this.checkToken(input.token);
    const id = randomUUID();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await trx
        .insertInto("marketplaces")
        .values({
          id,
          name,
          url: input.url,
          mirrors: JSON.stringify(input.mirrors ?? []),
          builtin: false,
          enabled: true,
          created_by: actor,
        })
        .execute();
      if (input.token !== undefined) {
        await this.secrets(trx).set(DEPLOYMENT_SECRETS_ORG, tokenKey(id), input.token);
      }
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "marketplace.added",
        target: id,
        detail: {
          name,
          url: input.url,
          mirrors: input.mirrors ?? [],
          hasToken: input.token !== undefined,
        },
      });
    });
    return this.get(id);
  }

  /**
   * Updates an enterprise marketplace (audit `marketplace.updated`, listing the changed fields, the
   * token's value never recorded; not written when unchanged). `token: null` clears the token.
   * Official only takes `enabled`, any other field -> `marketplace.builtin`. Changing the URL clears
   * the ETag.
   */
  async update(
    actor: string,
    id: string,
    patch: {
      name?: string;
      url?: string;
      mirrors?: string[];
      enabled?: boolean;
      token?: string | null;
    },
    opts: ActorOpts = {},
  ): Promise<MarketplaceView> {
    const name = patch.name !== undefined ? this.checkName(patch.name) : undefined;
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = (await trx
        .selectFrom("marketplaces")
        .selectAll()
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst()) as unknown as SourceRow | undefined;
      if (!row) throw notFound();
      if (
        row.builtin &&
        (name !== undefined ||
          patch.url !== undefined ||
          patch.mirrors !== undefined ||
          patch.token !== undefined)
      ) {
        throw builtinErr("changed");
      }
      this.checkUrls(patch.url ?? row.url, patch.mirrors ?? row.mirrors);
      if (typeof patch.token === "string") this.checkToken(patch.token);
      const changed: string[] = [];
      const set: Record<string, unknown> = {};
      if (name !== undefined && name !== row.name) {
        set.name = name;
        changed.push("name");
      }
      if (patch.url !== undefined && patch.url !== row.url) {
        set.url = patch.url;
        set.etag = null;
        changed.push("url");
      }
      if (
        patch.mirrors !== undefined &&
        JSON.stringify(patch.mirrors) !== JSON.stringify(row.mirrors)
      ) {
        set.mirrors = JSON.stringify(patch.mirrors);
        changed.push("mirrors");
      }
      if (patch.enabled !== undefined && patch.enabled !== row.enabled) {
        set.enabled = patch.enabled;
        changed.push("enabled");
      }
      if (Object.keys(set).length > 0) {
        await trx.updateTable("marketplaces").set(set).where("id", "=", id).execute();
      }
      if (patch.token !== undefined) {
        const secrets = this.secrets(trx);
        const had = (await secrets.get(DEPLOYMENT_SECRETS_ORG, tokenKey(id))) !== null;
        if (patch.token === null) {
          if (had) {
            await secrets.delete(DEPLOYMENT_SECRETS_ORG, tokenKey(id));
            changed.push("token");
          }
        } else {
          await secrets.set(DEPLOYMENT_SECRETS_ORG, tokenKey(id), patch.token);
          changed.push("token");
        }
      }
      if (changed.length === 0) return;
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "marketplace.updated",
        target: id,
        detail: {
          changed,
          ...(set.enabled !== undefined && { enabled: set.enabled }),
          ...(set.url !== undefined && { url: set.url }),
        },
      });
    });
    return this.get(id);
  }

  /**
   * Deletes an enterprise marketplace (audit `marketplace.removed`): its cached entries and token
   * are deleted; imported catalog items are kept (their marketplace becomes null). Official can
   * only be disabled -> `marketplace.builtin`.
   */
  async remove(actor: string, id: string, opts: ActorOpts = {}): Promise<void> {
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .selectFrom("marketplaces")
        .select(["builtin", "name", "url"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.builtin) throw builtinErr("deleted");
      await trx.deleteFrom("marketplaces").where("id", "=", id).execute();
      await this.secrets(trx).delete(DEPLOYMENT_SECRETS_ORG, tokenKey(id));
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "marketplace.removed",
        target: id,
        detail: { name: row.name, url: row.url },
      });
    });
  }

  /**
   * Refreshes one marketplace: the main URL, then the mirrors (with If-None-Match, at most
   * `marketplaces.maxIndexBytes`); 304 keeps the entries, a valid 200 replaces them as a whole; when all
   * fail the old entries are kept with status `error`. A disabled marketplace -> 409 `conflict`.
   * A status change audits `marketplace.refreshed {from, to}` (a periodic refresh has no actor) and
   * logs once. If the URL / mirrors changed during the fetch: the result is discarded and nothing is
   * written (M-1).
   * `throwOnError` (manual refresh): after recording the status, a failure throws 502 —
   * `marketplace.invalid` when some URL returned an invalid index, else `marketplace.fetch_failed`
   * (the message gives each URL's failure).
   */
  async refresh(
    id: string,
    signal: AbortSignal,
    actor?: string,
    opts: ActorOpts & { throwOnError?: boolean } = {},
  ): Promise<MarketplaceView> {
    const config = this.d.config();
    const row = (await this.d.db
      .selectFrom("marketplaces")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) as unknown as SourceRow | undefined;
    if (!row) throw notFound();
    if (!sourceEffective(row, config)) {
      throw new ApiError(
        "conflict",
        row.builtin && !config.marketplaces.official.enabled
          ? "The official marketplace is disabled by marketplaces.official.enabled (offline mode)"
          : "This marketplace is disabled; enable it before refreshing",
      );
    }
    const token = row.builtin
      ? undefined
      : ((await this.secrets(this.d.db).get(DEPLOYMENT_SECRETS_ORG, tokenKey(id))) ?? undefined);
    const tokenOrigin = new URL(row.url).origin;
    const errors: string[] = [];
    let sawInvalid = false;
    let outcome: { index: CatalogIndex; etag: string | null } | "not_modified" | undefined;
    for (const url of [row.url, ...row.mirrors]) {
      if (signal.aborted) break;
      try {
        const r = await fetchMarketplaceIndex(url, {
          etag: row.etag,
          ...(token !== undefined && { token, tokenOrigin }),
          maxBytes: config.marketplaces.maxIndexBytes,
          timeoutMs: this.d.fetchTimeoutMs ?? MARKETPLACE_FETCH_TIMEOUT_MS,
          allowInsecureLoopback: config.marketplaces.allowInsecureLoopback,
          signal,
        });
        outcome = r.status === "not_modified" ? "not_modified" : r;
        break;
      } catch (e) {
        if (!(e instanceof MarketplaceFetchError || e instanceof MarketplaceInvalidError)) throw e;
        if (e instanceof MarketplaceInvalidError) sawInvalid = true;
        errors.push(`${url}: ${e.message}`);
      }
    }
    if (outcome === undefined && errors.length === 0) errors.push("refresh aborted");
    const status: "ok" | "error" = outcome === undefined ? "error" : "ok";
    const lastError = status === "error" ? errors.join("\n").slice(0, MAX_ERROR_CHARS) : null;

    const from = await this.d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.catalog-source:${id}`}))`.execute(
        trx,
      );
      const cur = await trx
        .selectFrom("marketplaces")
        .select(["last_status", "url", "mirrors"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw notFound();
      // 拉取期间管理员改了地址 / 镜像：拉到的是旧地址的内容，不写条目、ETag 与状态（下一次刷新按新地址来）
      if (cur.url !== row.url || JSON.stringify(cur.mirrors) !== JSON.stringify(row.mirrors)) {
        return "stale" as const;
      }
      if (outcome !== undefined && outcome !== "not_modified") {
        await this.replaceEntries(trx, id, outcome.index.entries);
      }
      await trx
        .updateTable("marketplaces")
        .set({
          last_status: status,
          last_error: lastError,
          last_refreshed_at: sql<Date>`now()` as unknown as Date,
          ...(outcome !== undefined && outcome !== "not_modified" && { etag: outcome.etag }),
        })
        .where("id", "=", id)
        .execute();
      if (cur.last_status !== status) {
        await audit(trx, {
          ...(actor !== undefined && { actorAccountId: actor }),
          ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
          action: "marketplace.refreshed",
          target: id,
          detail: {
            from: cur.last_status,
            to: status,
            ...(lastError !== null && { error: lastError }),
          },
        });
      }
      return cur.last_status;
    });
    if (from === "stale") {
      this.d.log.info("marketplace changed during refresh; result discarded", { marketplace: id });
      return this.get(id);
    }
    if (from !== status) {
      if (status === "error") {
        this.d.log.warn("marketplace refresh failed", { marketplace: id, error: lastError });
      } else {
        this.d.log.info("marketplace refreshed", { marketplace: id });
      }
    }
    if (status === "error" && opts.throwOnError) {
      throw new ApiError(
        sawInvalid ? "marketplace.invalid" : "marketplace.fetch_failed",
        `Marketplace refresh failed; the previous entries are kept. ${lastError ?? ""}`.trim(),
      );
    }
    return this.get(id);
  }

  /** 刷新全部生效的来源（维护任务 `catalogs-refresh`）：逐个刷新，某个失败不影响其他。 */
  async refreshAll(signal: AbortSignal): Promise<void> {
    const config = this.d.config();
    const rows = await this.d.db
      .selectFrom("marketplaces")
      .select(["id", "builtin", "enabled"])
      .orderBy("id")
      .execute();
    for (const r of rows) {
      if (signal.aborted) return;
      if (!sourceEffective(r, config)) continue;
      try {
        await this.refresh(r.id, signal);
      } catch (err) {
        this.d.log.error("marketplace refresh crashed", { marketplace: r.id, err });
      }
    }
  }

  /**
   * Browses entries (enabled marketplaces only): filtered by marketplace and kind, `q` matches a
   * substring of the name / npm package name / summary (case-insensitive). Ordered by kind, name,
   * marketplace, at most {@link MARKETPLACE_ENTRIES_MAX}; `truncated` means there are more (the UI
   * suggests narrowing the filter).
   */
  async entries(
    q: { sourceId?: string; kind?: PackageKind; q?: string } = {},
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    const config = this.d.config();
    let query = this.d.db
      .selectFrom("marketplace_entries as e")
      .innerJoin("marketplaces as s", "s.id", "e.source_id")
      .select(["e.source_id", "e.kind", "e.name", "e.npm", "e.entry", "s.name as source_name"])
      .where("s.enabled", "=", true)
      .orderBy("e.kind")
      .orderBy("e.name")
      .orderBy("e.source_id")
      .limit(MARKETPLACE_ENTRIES_MAX + 1);
    if (!config.marketplaces.official.enabled) query = query.where("s.builtin", "=", false);
    if (q.sourceId !== undefined) query = query.where("e.source_id", "=", q.sourceId);
    if (q.kind !== undefined) query = query.where("e.kind", "=", q.kind);
    if (q.q !== undefined && q.q !== "") {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) =>
        eb.or([
          eb("e.name", "ilike", like),
          eb("e.npm", "ilike", like),
          eb(sql<string>`e.entry->'summary'->>'en'`, "ilike", like),
          eb(sql<string>`coalesce(e.entry->'summary'->>'zh', '')`, "ilike", like),
        ]),
      );
    }
    const fetched = await query.execute();
    const truncated = fetched.length > MARKETPLACE_ENTRIES_MAX;
    const rows = truncated ? fetched.slice(0, MARKETPLACE_ENTRIES_MAX) : fetched;
    if (rows.length === 0) return { items: [], truncated: false };
    const items = await this.d.db
      .selectFrom("catalog_items as i")
      .leftJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .select(["i.id", "i.kind", "i.name", "i.package_name", "v.version"])
      .where("i.deleted_at", "is", null)
      .where("i.name", "in", [...new Set(rows.map((r) => r.name))])
      .execute();
    const adoptedBy = new Map<string, { itemId: string; versions: string[] }>();
    for (const i of items) {
      const key = `${i.kind} ${i.name} ${i.package_name}`;
      const a = adoptedBy.get(key) ?? { itemId: i.id, versions: [] };
      if (i.version !== null) a.versions.push(i.version);
      adoptedBy.set(key, a);
    }
    const views = rows.map((r): MarketplaceEntryView => {
      const e = r.entry as CatalogEntry;
      const compatible = new Set(compatibleVersions(e, HOST_VERSIONS).map((v) => v.version));
      const adopted = adoptedBy.get(`${r.kind} ${r.name} ${r.npm}`) ?? null;
      if (adopted) adopted.versions.sort((a, b) => semver.rcompare(a, b));
      const top = adopted?.versions[0];
      return {
        sourceId: r.source_id,
        sourceName: r.source_name,
        kind: r.kind,
        name: r.name,
        npm: r.npm,
        publisher: e.publisher,
        summary: e.summary,
        permissions: e.permissions ?? null,
        versions: [...e.versions]
          .sort((a, b) => semver.rcompare(a.version, b.version))
          .map((v) => ({ ...v, compatible: compatible.has(v.version) })),
        adopted: adopted ? { itemId: adopted.itemId, versions: [...adopted.versions] } : null,
        newerAvailable: top !== undefined && [...compatible].some((v) => semver.gt(v, top)),
      };
    });
    return { items: views, truncated };
  }

  private async replaceEntries(trx: Trx, id: string, entries: CatalogEntry[]): Promise<void> {
    await trx.deleteFrom("marketplace_entries").where("source_id", "=", id).execute();
    for (let i = 0; i < entries.length; i += INSERT_BATCH) {
      await trx
        .insertInto("marketplace_entries")
        .values(
          entries.slice(i, i + INSERT_BATCH).map((e) => ({
            source_id: id,
            kind: e.kind,
            name: e.name,
            npm: e.npm,
            entry: JSON.stringify(e),
          })),
        )
        .execute();
    }
  }

  private async views(rows: SourceRow[]): Promise<MarketplaceView[]> {
    if (rows.length === 0) return [];
    const config = this.d.config();
    const ids = rows.map((r) => r.id);
    const counts = await this.d.db
      .selectFrom("marketplace_entries")
      .select(["source_id", (eb) => eb.fn.countAll<string>().as("n")])
      .where("source_id", "in", ids)
      .groupBy("source_id")
      .execute();
    const tokens = await this.d.db
      .selectFrom("secrets")
      .select("key")
      .where("namespace", "=", SECRETS_NAMESPACE)
      .where("org_id", "=", DEPLOYMENT_SECRETS_ORG)
      .where(
        "key",
        "in",
        ids.map((id) => tokenKey(id)),
      )
      .execute();
    const hasToken = new Set(tokens.map((t) => t.key));
    const count = new Map(counts.map((c) => [c.source_id, Number(c.n)]));
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      url: r.url,
      mirrors: r.mirrors,
      builtin: r.builtin,
      enabled: sourceEffective(r, config),
      disabledByConfig: r.builtin && !config.marketplaces.official.enabled,
      hasToken: hasToken.has(tokenKey(r.id)),
      etag: r.etag,
      lastRefreshedAt: r.last_refreshed_at?.toISOString() ?? null,
      lastStatus: r.last_status,
      lastError: r.last_error,
      entryCount: count.get(r.id) ?? 0,
      createdAt: r.created_at.toISOString(),
    }));
  }

  private secrets(db: KernelDb | Trx) {
    return createSecrets(db, this.d.keyring, SECRETS_NAMESPACE);
  }

  private checkName(name: string): string {
    const n = name.trim();
    if (n.length < 1 || [...n].length > 100) {
      throw new ApiError("validation_failed", "name must be 1–100 characters");
    }
    return n;
  }

  private checkUrls(url: string, mirrors: string[]): void {
    const allow = this.d.config().marketplaces.allowInsecureLoopback;
    if (mirrors.length > MARKETPLACE_MAX_MIRRORS) {
      throw new ApiError("validation_failed", `at most ${MARKETPLACE_MAX_MIRRORS} mirrors`);
    }
    for (const [label, u] of [["url", url], ...mirrors.map((m, i) => [`mirrors.${i}`, m])] as [
      string,
      string,
    ][]) {
      const p = marketplaceUrlProblem(u, allow);
      if (p !== null) throw new ApiError("validation_failed", `${label}: ${p}`);
    }
  }

  private checkToken(token: string): void {
    if (token.length < 1 || token.length > MAX_TOKEN_CHARS || /[\r\n]/.test(token)) {
      throw new ApiError(
        "validation_failed",
        `token must be 1–${MAX_TOKEN_CHARS} characters without line breaks`,
      );
    }
  }
}
