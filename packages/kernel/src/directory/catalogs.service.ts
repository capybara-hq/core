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
import { CATALOG_MAX_MIRRORS, type KernelConfig } from "../config/schema.js";
import { createSecrets, type Keyring } from "../ctx/secrets.js";
import type { KernelDatabase, KernelDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { audit } from "../identity/audit.js";
import { lockEnterpriseAdminsAndAuthorize } from "../identity/enterprise-admin.js";
import { DEPLOYMENT_SECRETS_ORG } from "../plugins/deployment-config.js";
import { KERNEL_VERSION } from "../version.js";
import {
  CatalogFetchError,
  CatalogInvalidError,
  catalogUrlProblem,
  fetchCatalogIndex,
} from "./catalog-fetch.js";

type Trx = Transaction<KernelDatabase>;

/** 官方清单来源的 id。 */
export const OFFICIAL_CATALOG_ID = "official";
const OFFICIAL_CATALOG_NAME = "Capybara official catalog";
/** 企业清单的可选令牌：secrets 的 namespace `kernel`、org `_deployment`、键 `catalog-token:<id>`（preflight #65）。 */
const SECRETS_NAMESPACE = "kernel";
const tokenKey = (id: string) => `catalog-token:${id}`;

/** 拉取一份清单的超时。 */
export const CATALOG_FETCH_TIMEOUT_MS = 30_000;
/** 定期刷新全部来源的总时限（每个地址另有 {@link CATALOG_FETCH_TIMEOUT_MS} 超时）。 */
export const CATALOGS_REFRESH_DEADLINE_MS = 600_000;
/** `entries()` 一次最多返回的条目数。 */
export const CATALOG_ENTRIES_MAX = 5000;
const INSERT_BATCH = 500;
const MAX_ERROR_CHARS = 1000;
const MAX_TOKEN_CHARS = 4096;

/** 一个清单来源（后台列表）。令牌不回显，只给 `hasToken`。 */
export interface CatalogSourceView {
  id: string;
  name: string;
  url: string;
  mirrors: string[];
  builtin: boolean;
  /** 生效的启用状态（official 还要配置 `catalogs.official.enabled` 为 true）。 */
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
export interface CatalogEntryView {
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

export interface CatalogsServiceDeps {
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

/** `catalog_sources` 的一行（selectAll 的结果）。 */
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

const notFound = () => new ApiError("catalog.not_found", "Catalog source not found");
const builtinErr = (what: string) =>
  new ApiError(
    "catalog.builtin",
    `The official catalog is configured in catalogs.official.*; it cannot be ${what} here (only enabled or disabled)`,
  );

/** 宿主版本（清单条目的 minKernel / minSdk 按它判断兼容）。 */
export const HOST_VERSIONS = { kernel: KERNEL_VERSION, sdk: SDK_VERSION } as const;

/** 来源是否生效：本身启用，official 还要配置没关。 */
export const sourceEffective = (
  row: { builtin: boolean; enabled: boolean },
  config: KernelConfig,
): boolean => row.enabled && (!row.builtin || config.catalogs.official.enabled);

/**
 * 读引入用的清单条目：来源不存在 → `catalog.not_found`；来源停用（含 official 离线）或条目不存在 →
 * `catalog.entry_not_found`。
 */
export async function loadCatalogEntry(
  db: KernelDb,
  config: KernelConfig,
  sourceId: string,
  kind: PackageKind,
  name: string,
): Promise<{ sourceName: string; entry: CatalogEntry }> {
  const src = await db
    .selectFrom("catalog_sources")
    .select(["name", "builtin", "enabled"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!src) throw notFound();
  const row = sourceEffective(src, config)
    ? await db
        .selectFrom("catalog_entries")
        .select("entry")
        .where("source_id", "=", sourceId)
        .where("kind", "=", kind)
        .where("name", "=", name)
        .executeTakeFirst()
    : undefined;
  if (!row) {
    throw new ApiError("catalog.entry_not_found", `Catalog entry ${kind} ${name} not found`);
  }
  return { sourceName: src.name, entry: row.entry as CatalogEntry };
}

/**
 * 目录来源（D16 / C25 / C26，`/api/v1/admin/catalogs/*`，仅企业管理员）：官方清单（配置 `catalogs.official.*`，
 * 启动时同步成 id `official` 的来源）与企业清单（PG，可选令牌存 secrets）。刷新（维护任务 `catalogs-refresh`
 * 每 `catalogs.refreshIntervalMinutes` 分钟一次，或手动）依次尝试主地址与镜像，带 If-None-Match；成功就整体替换
 * 该来源的条目缓存，全部失败（含清单不合法）保留上一份、状态 `error`。状态变化时审计 `catalog.refreshed` 并打一次日志。
 * 本身无状态，多副本共用。
 */
export class CatalogsService {
  constructor(private readonly d: CatalogsServiceDeps) {}

  /** 按配置建 / 更新 official 来源（名字、地址、镜像；不动后台的启停）。每个副本启动时调用，幂等。 */
  async syncOfficialFromConfig(): Promise<void> {
    const o = this.d.config().catalogs.official;
    const mirrors = JSON.stringify(o.mirrors);
    await this.d.db
      .insertInto("catalog_sources")
      .values({
        id: OFFICIAL_CATALOG_ID,
        name: OFFICIAL_CATALOG_NAME,
        url: o.url,
        mirrors,
        builtin: true,
        enabled: true,
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          name: OFFICIAL_CATALOG_NAME,
          url: o.url,
          mirrors,
          builtin: true,
          // 地址变了，旧 ETag 不再适用（条目保留到下次刷新）
          etag: sql<
            string | null
          >`CASE WHEN catalog_sources.url = excluded.url THEN catalog_sources.etag ELSE NULL END`,
        }),
      )
      .execute();
  }

  /** 全部来源（official 在前，其余按创建时间）。 */
  async list(): Promise<CatalogSourceView[]> {
    const rows = (await this.d.db
      .selectFrom("catalog_sources")
      .selectAll()
      .orderBy("builtin", "desc")
      .orderBy("created_at")
      .orderBy("id")
      .execute()) as unknown as SourceRow[];
    return this.views(rows);
  }

  async get(id: string): Promise<CatalogSourceView> {
    const row = (await this.d.db
      .selectFrom("catalog_sources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) as unknown as SourceRow | undefined;
    if (!row) throw notFound();
    return (await this.views([row]))[0] as CatalogSourceView;
  }

  /** 加一个企业清单（审计 `catalog.added`）。地址与镜像只认 https，不能带用户信息。 */
  async add(
    actor: string,
    input: { name: string; url: string; mirrors?: string[]; token?: string },
    opts: ActorOpts = {},
  ): Promise<CatalogSourceView> {
    const name = this.checkName(input.name);
    this.checkUrls(input.url, input.mirrors ?? []);
    if (input.token !== undefined) this.checkToken(input.token);
    const id = randomUUID();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await trx
        .insertInto("catalog_sources")
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
        action: "catalog.added",
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
   * 改企业清单（审计 `catalog.updated`，列出改了的字段，令牌不记值；没变不写）。`token: null` 清除令牌。
   * official 只能改 `enabled`，其余字段 → `catalog.builtin`。改地址会清掉 ETag。
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
  ): Promise<CatalogSourceView> {
    const name = patch.name !== undefined ? this.checkName(patch.name) : undefined;
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = (await trx
        .selectFrom("catalog_sources")
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
        await trx.updateTable("catalog_sources").set(set).where("id", "=", id).execute();
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
        action: "catalog.updated",
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
   * 删除企业清单（审计 `catalog.removed`）：条目缓存随之删除、令牌删除；已引入的目录条目保留（来源置空）。
   * official 只能停用 → `catalog.builtin`。
   */
  async remove(actor: string, id: string, opts: ActorOpts = {}): Promise<void> {
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      const row = await trx
        .selectFrom("catalog_sources")
        .select(["builtin", "name", "url"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!row) throw notFound();
      if (row.builtin) throw builtinErr("deleted");
      await trx.deleteFrom("catalog_sources").where("id", "=", id).execute();
      await this.secrets(trx).delete(DEPLOYMENT_SECRETS_ORG, tokenKey(id));
      await audit(trx, {
        actorAccountId: actor,
        ...(opts.actorTokenId !== undefined && { actorTokenId: opts.actorTokenId }),
        action: "catalog.removed",
        target: id,
        detail: { name: row.name, url: row.url },
      });
    });
  }

  /**
   * 刷新一个来源：主地址 → 镜像依次尝试（带 If-None-Match，≤ `catalogs.maxIndexBytes`）；304 保持条目，
   * 200 且合法就整体替换；全部失败保留旧条目、状态 `error`。停用的来源 → 409 `conflict`。
   * 状态变化时审计 `catalog.refreshed {from, to}`（定期刷新没有操作人）并打一次日志。
   * `throwOnError`（手动刷新）：状态记好之后，失败时抛 502——有地址返回了不合法的清单为 `catalog.invalid`，
   * 否则 `catalog.fetch_failed`（消息为各地址的失败原因）。
   */
  async refresh(
    id: string,
    signal: AbortSignal,
    actor?: string,
    opts: ActorOpts & { throwOnError?: boolean } = {},
  ): Promise<CatalogSourceView> {
    const config = this.d.config();
    const row = (await this.d.db
      .selectFrom("catalog_sources")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) as unknown as SourceRow | undefined;
    if (!row) throw notFound();
    if (!sourceEffective(row, config)) {
      throw new ApiError(
        "conflict",
        row.builtin && !config.catalogs.official.enabled
          ? "The official catalog is disabled by catalogs.official.enabled (offline mode)"
          : "This catalog source is disabled; enable it before refreshing",
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
        const r = await fetchCatalogIndex(url, {
          etag: row.etag,
          ...(token !== undefined && { token, tokenOrigin }),
          maxBytes: config.catalogs.maxIndexBytes,
          timeoutMs: this.d.fetchTimeoutMs ?? CATALOG_FETCH_TIMEOUT_MS,
          allowInsecureLoopback: config.catalogs.allowInsecureLoopback,
          signal,
        });
        outcome = r.status === "not_modified" ? "not_modified" : r;
        break;
      } catch (e) {
        if (!(e instanceof CatalogFetchError || e instanceof CatalogInvalidError)) throw e;
        if (e instanceof CatalogInvalidError) sawInvalid = true;
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
        .selectFrom("catalog_sources")
        .select("last_status")
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw notFound();
      if (outcome !== undefined && outcome !== "not_modified") {
        await this.replaceEntries(trx, id, outcome.index.entries);
      }
      await trx
        .updateTable("catalog_sources")
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
          action: "catalog.refreshed",
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
    if (from !== status) {
      if (status === "error") {
        this.d.log.warn("catalog refresh failed", { catalog: id, error: lastError });
      } else {
        this.d.log.info("catalog refreshed", { catalog: id });
      }
    }
    if (status === "error" && opts.throwOnError) {
      throw new ApiError(
        sawInvalid ? "catalog.invalid" : "catalog.fetch_failed",
        `Catalog refresh failed; the previous entries are kept. ${lastError ?? ""}`.trim(),
      );
    }
    return this.get(id);
  }

  /** 刷新全部生效的来源（维护任务 `catalogs-refresh`）：逐个刷新，某个失败不影响其他。 */
  async refreshAll(signal: AbortSignal): Promise<void> {
    const config = this.d.config();
    const rows = await this.d.db
      .selectFrom("catalog_sources")
      .select(["id", "builtin", "enabled"])
      .orderBy("id")
      .execute();
    for (const r of rows) {
      if (signal.aborted) return;
      if (!sourceEffective(r, config)) continue;
      try {
        await this.refresh(r.id, signal);
      } catch (err) {
        this.d.log.error("catalog refresh crashed", { catalog: r.id, err });
      }
    }
  }

  /**
   * 浏览条目（只含生效的来源）：按来源、种类过滤，`q` 按名字 / npm 包名 / 简介做子串匹配（不区分大小写）。
   * 按种类、名字、来源排序，最多 {@link CATALOG_ENTRIES_MAX} 条；`truncated` 表示还有更多（界面提示缩小范围）。
   */
  async entries(
    q: { sourceId?: string; kind?: PackageKind; q?: string } = {},
  ): Promise<{ items: CatalogEntryView[]; truncated: boolean }> {
    const config = this.d.config();
    let query = this.d.db
      .selectFrom("catalog_entries as e")
      .innerJoin("catalog_sources as s", "s.id", "e.source_id")
      .select(["e.source_id", "e.kind", "e.name", "e.npm", "e.entry", "s.name as source_name"])
      .where("s.enabled", "=", true)
      .orderBy("e.kind")
      .orderBy("e.name")
      .orderBy("e.source_id")
      .limit(CATALOG_ENTRIES_MAX + 1);
    if (!config.catalogs.official.enabled) query = query.where("s.builtin", "=", false);
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
    const truncated = fetched.length > CATALOG_ENTRIES_MAX;
    const rows = truncated ? fetched.slice(0, CATALOG_ENTRIES_MAX) : fetched;
    if (rows.length === 0) return { items: [], truncated: false };
    const items = await this.d.db
      .selectFrom("directory_items as i")
      .leftJoin("directory_item_versions as v", "v.item_id", "i.id")
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
    const views = rows.map((r): CatalogEntryView => {
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
    await trx.deleteFrom("catalog_entries").where("source_id", "=", id).execute();
    for (let i = 0; i < entries.length; i += INSERT_BATCH) {
      await trx
        .insertInto("catalog_entries")
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

  private async views(rows: SourceRow[]): Promise<CatalogSourceView[]> {
    if (rows.length === 0) return [];
    const config = this.d.config();
    const ids = rows.map((r) => r.id);
    const counts = await this.d.db
      .selectFrom("catalog_entries")
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
      disabledByConfig: r.builtin && !config.catalogs.official.enabled,
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
    const allow = this.d.config().catalogs.allowInsecureLoopback;
    if (mirrors.length > CATALOG_MAX_MIRRORS) {
      throw new ApiError("validation_failed", `at most ${CATALOG_MAX_MIRRORS} mirrors`);
    }
    for (const [label, u] of [["url", url], ...mirrors.map((m, i) => [`mirrors.${i}`, m])] as [
      string,
      string,
    ][]) {
      const p = catalogUrlProblem(u, allow);
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
