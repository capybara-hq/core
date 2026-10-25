import { randomUUID } from "node:crypto";
import {
  type Logger,
  type MarketplaceEntry,
  type MarketplaceManifest,
  type MarketplaceSource,
  marketplaceEntryVersion,
  PLUGIN_MANIFEST_FILE,
  parseMarketplaceManifest,
  parsePluginManifest,
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
  expandGitUrl,
  type GitOptions,
  GitSourceError,
  gitLocationIdentity,
  gitUrlIdentity,
  normalGitPath,
  readGitTreeAndOids,
  resolveGitCommit,
} from "./git-source.js";
import {
  fetchMarketplaceManifest,
  MarketplaceFetchError,
  MarketplaceInvalidError,
  type MarketplaceNetCode,
  marketplaceNetPolicy,
  marketplaceUrlProblem,
} from "./marketplace-fetch.js";
import { compareVersions, newestFirst, sameRelease } from "./versions.js";

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
/** The longest entry summary (SDK `MARKETPLACE_LIMITS.summaryChars`). */
const SUMMARY_MAX = 280;
/** `entries()` 一次最多返回的条目数。 */
export const MARKETPLACE_ENTRIES_MAX = 5000;
const INSERT_BATCH = 500;
const MAX_ERROR_CHARS = 1000;
const MAX_TOKEN_CHARS = 4096;
/**
 * At most this many branch heads are resolved per refresh (entries that follow a git branch and
 * are already imported; spec §5.3 "content changed at the same version").
 */
export const MARKETPLACE_HEADS_MAX = 50;
const HEADS_CONCURRENCY = 4;

/** A marketplace's form: `http` (a marketplace.json URL) or `git` (a repository, spec §5.1). */
export type MarketplaceForm = "http" | "git";

/** 一个清单来源（后台列表）。令牌不回显，只给 `hasToken`。 */
export interface MarketplaceView {
  id: string;
  name: string;
  url: string;
  form: MarketplaceForm;
  /** The ref a git marketplace follows (null: the remote HEAD; always null for http). */
  ref: string | null;
  /** The commit of a git marketplace's last successful refresh (null for http or before one). */
  lastCommit: string | null;
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

/**
 * Why a marketplace entry cannot be imported: `host_not_allowed` when its git / archive source is
 * on a host outside `marketplaces.allowedHosts`; `path_needs_git_marketplace` for a `path` source
 * of a marketplace fetched over http (a path is read from the marketplace's own repository).
 */
export type MarketplaceEntryUnimportable = "host_not_allowed" | "path_needs_git_marketplace";

/** A marketplace entry (admin browsing). One entry is one version of a plugin. */
export interface MarketplaceEntryView {
  sourceId: string;
  sourceName: string;
  name: string;
  /** The entry's version (`version`, else the npm source's); null when it has none (the plugin's own). */
  version: string | null;
  summary: { en: string; zh?: string };
  minKernel: string | null;
  homepage: string | null;
  permissions: { keys: string[]; sensitive: string[] } | null;
  source: MarketplaceSource;
  /** `minKernel` is satisfied by this deployment. */
  compatible: boolean;
  /** The kernel can import this entry's source now. */
  importable: boolean;
  reason?: MarketplaceEntryUnimportable;
  /** Imported as a catalog item (a non-deleted item with the same name) and its versions. */
  adopted: { itemId: string; versions: string[] } | null;
  /** Adopted, and this compatible entry is newer than the newest imported version (never automatic). */
  newerAvailable: boolean;
  /**
   * "Content changed at the same version" (spec §5.3): a version of this entry's release is
   * imported (for an entry without a version: a version from the same git location), but none of
   * them has the commit or integrity the entry points at now (a branch-following git entry: the
   * branch head of the last refresh; a path entry: the marketplace's last commit). Importing it
   * again records `<version>+git.<sha12>` / `+sha256.<12>`.
   */
  contentChanged: boolean;
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
  form: MarketplaceForm;
  ref: string | null;
  last_commit: string | null;
  owner_name: string | null;
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

/** A plugin name from a repo URL or path segment (lower case, invalid characters as `-`). */
export function pluginNameFrom(segment: string): string {
  const name = segment
    .replace(/\.git$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return name === "" ? "plugin" : name;
}
const builtinErr = (what: string) =>
  new ApiError(
    "marketplace.builtin",
    `The official marketplace is configured in marketplaces.official.*; it cannot be ${what} here (only enabled or disabled)`,
  );

/** Entry versions newest first; `''` (no version) last. */
const bySemverDescOrNone = (a: string, b: string): number =>
  a === b ? 0 : a === "" ? 1 : b === "" ? -1 : compareVersions(b, a);

/** Where an entry's plugin is now (columns of the entry row and its marketplace). */
export interface EntryAt {
  /** The marketplace listing the entry. */
  marketplaceId: string;
  /** The branch head of a branch-following git entry (the last refresh's; null: unknown). */
  headCommit: string | null;
  /**
   * The git tree oid of the entry's plugin directory (a path entry: at the marketplace's last
   * commit; a git entry with a path: at its head); null: unknown.
   */
  treeOid: string | null;
  /** The marketplace URL and last commit (path entries read the marketplace's repository). */
  url: string;
  lastCommit: string | null;
}

/** A catalog version as an entry is compared with (columns of `catalog_item_versions`). */
export interface ImportedAs {
  version: string;
  source: string;
  source_ref: string;
  integrity: string | null;
  source_detail: unknown;
}

type GitDetail = { host: string; repo: string; path: string; commit: string; tree?: string };
const gitDetailOf = (v: ImportedAs): GitDetail | null => {
  const d = v.source_detail as Partial<Record<keyof GitDetail, unknown>> | null;
  return typeof d?.host === "string" &&
    typeof d.repo === "string" &&
    typeof d.path === "string" &&
    typeof d.commit === "string"
    ? {
        host: d.host,
        repo: d.repo,
        path: d.path,
        commit: d.commit,
        ...(typeof d.tree === "string" && { tree: d.tree }),
      }
    : null;
};

const gitCommitOf = (detail: unknown): string | null => {
  const c = (detail as { commit?: unknown } | null)?.commit;
  return typeof c === "string" ? c : null;
};

/**
 * Whether the content of an entry changed at a version already imported from the same source (see
 * {@link MarketplaceEntryView.contentChanged}). Only versions imported from what the entry points
 * at count: a git / path entry -> the same git location (host, repo, path); an archive -> an
 * archive from the same URL or listed by this marketplace; npm -> the same package version, from this marketplace or straight from npm, with an
 * integrity. Of those, the entry's release (all of them for an entry without a version). Changed
 * when none of them matches what the entry points at now: npm / archive by integrity; git / path
 * by tree oid when both sides know it (a monorepo commit elsewhere changes nothing), else by
 * commit. Unknown (no head or last commit) -> false.
 */
export function entryContentChanged(
  e: MarketplaceEntry,
  at: EntryAt,
  versions: readonly ImportedAs[],
): boolean {
  const src = e.source;
  const version = marketplaceEntryVersion(e);
  let fromSource: (v: ImportedAs) => boolean;
  let same: (v: ImportedAs) => boolean;
  if ("npm" in src) {
    const ref = `${src.npm.package}@${src.npm.version}`;
    fromSource = (v) =>
      v.integrity !== null &&
      ((v.source === "marketplace" && v.source_ref === `${at.marketplaceId}:${ref}`) ||
        (v.source === "npm" && v.source_ref === ref));
    same = (v) => v.integrity === src.npm.integrity;
  } else if ("archive" in src) {
    const u = new URL(src.archive.url);
    const url = `${u.origin}${u.pathname}`;
    // the same URL, or an archive this marketplace listed before (archive URLs often carry the
    // version, so a re-hosted archive of the same release is still this entry's)
    fromSource = (v) =>
      v.integrity !== null &&
      v.source === "marketplace" &&
      ((v.source_detail as { url?: unknown } | null)?.url === url ||
        (v.source_ref.startsWith(`${at.marketplaceId}:`) &&
          typeof (v.source_detail as { url?: unknown } | null)?.url === "string"));
    same = (v) => v.integrity === src.archive.integrity;
  } else {
    const where =
      "git" in src ? gitUrlIdentity(src.git.url, src.git.path) : gitUrlIdentity(at.url, src.path);
    const commit = "git" in src ? (src.git.commit?.toLowerCase() ?? at.headCommit) : at.lastCommit;
    if (commit === null) return false;
    fromSource = (v) => {
      const d = gitDetailOf(v);
      return d !== null && gitLocationIdentity(d) === where;
    };
    same = (v) => {
      const d = gitDetailOf(v) as GitDetail;
      return (
        d.commit === commit ||
        (at.treeOid !== null && d.tree !== undefined && d.tree === at.treeOid)
      );
    };
  }
  const candidates = versions.filter(
    (v) => fromSource(v) && (version === null || sameRelease(v.version, version)),
  );
  return candidates.length > 0 && !candidates.some(same);
}

/**
 * The directories of the path entries of a git marketplace's manifest (read leniently: the
 * manifest is validated afterwards), or the root when there is none (a single-plugin repo).
 */
function pathEntryDirs(raw: Uint8Array | undefined, maxBytes: number): string[] {
  if (raw === undefined) return ["."];
  if (raw.byteLength > maxBytes) return [];
  try {
    const plugins = (JSON.parse(new TextDecoder().decode(raw)) as { plugins?: unknown }).plugins;
    if (!Array.isArray(plugins)) return [];
    const dirs = new Set<string>();
    for (const p of plugins) {
      const path = (p as { source?: { path?: unknown } } | null)?.source?.path;
      if (typeof path === "string") dirs.add(normalGitPath(path));
    }
    return [...dirs];
  } catch {
    return [];
  }
}

/** A branch-following git entry whose head a refresh resolves. */
type FollowingEntry = MarketplaceEntry & {
  source: { git: { url: string; ref?: string; path?: string } };
};

/**
 * Which entries a refresh resolves the branch head of: git entries without a pinned commit, on a
 * host `marketplaces.allowedHosts` lets through, with a version imported from the same git
 * location (of the entry's release; any, for an entry without a version), at most `max`, by name.
 */
export function headsToResolve(
  entries: readonly MarketplaceEntry[],
  imported: readonly (ImportedAs & { name: string })[],
  config: KernelConfig,
  max: number,
): FollowingEntry[] {
  return entries
    .filter((e): e is FollowingEntry => "git" in e.source && e.source.git.commit === undefined)
    .filter((e) => {
      const host = entrySourceHost(e);
      if (host === undefined || !hostAllowed(host, config)) return false;
      const where = gitUrlIdentity(e.source.git.url, e.source.git.path);
      const version = marketplaceEntryVersion(e);
      return imported.some((v) => {
        const d = gitDetailOf(v);
        return (
          v.name === e.name &&
          d !== null &&
          gitLocationIdentity(d) === where &&
          (version === null || sameRelease(v.version, version))
        );
      });
    })
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, max);
}

/** The host versions (an entry's `minKernel` is judged against them). */
export const HOST_VERSIONS = { kernel: KERNEL_VERSION, sdk: SDK_VERSION } as const;

/** Whether this deployment satisfies the entry's `minKernel`. */
export const entryCompatible = (e: Pick<MarketplaceEntry, "minKernel">): boolean =>
  e.minKernel === undefined || semver.gte(HOST_VERSIONS.kernel, e.minKernel);

/**
 * The form of a marketplace address (spec §5.1): `owner/repo` (expanded to GitHub), an https URL
 * whose path ends in `.git`, or any URL with `form: "git"` is a git repository; anything else
 * (a `.json` URL included) is an http marketplace.json URL. `form` given wins.
 */
export function marketplaceForm(
  url: string,
  form?: MarketplaceForm,
): { form: MarketplaceForm; url: string } {
  if (form === "http") return { form, url };
  const expanded = expandGitUrl(url);
  if (form === "git" || expanded !== url) return { form: "git", url: expanded };
  try {
    if (/\.git\/?$/.test(new URL(url).pathname)) return { form: "git", url };
  } catch {
    // not a URL: checked (and refused) by the caller
  }
  return { form: "http", url };
}

/** The host a git / archive entry downloads from (lower case), undefined for npm / path. */
export function entrySourceHost(e: Pick<MarketplaceEntry, "source">): string | undefined {
  const url =
    "git" in e.source ? e.source.git.url : "archive" in e.source ? e.source.archive.url : undefined;
  if (url === undefined) return undefined;
  try {
    // IPv6 hostnames come bracketed from URL; allowedHosts entries are written without brackets
    return new URL(url).hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  } catch {
    return undefined;
  }
}

/** Whether `marketplaces.allowedHosts` lets an entry download from `host` (empty: any host). */
export function hostAllowed(host: string, config: KernelConfig): boolean {
  const allowed = config.marketplaces.allowedHosts;
  return allowed.length === 0 || allowed.includes(host.toLowerCase());
}

/** Why an entry is not importable from a marketplace of `form`, or undefined when it is. */
function unimportable(
  e: MarketplaceEntry,
  form: MarketplaceForm,
  config: KernelConfig,
): MarketplaceEntryUnimportable | undefined {
  if ("path" in e.source && form !== "git") return "path_needs_git_marketplace";
  const host = entrySourceHost(e);
  if (host !== undefined && !hostAllowed(host, config)) return "host_not_allowed";
  return undefined;
}

/** What an import needs to know about the marketplace of an entry. */
export interface MarketplaceOfEntry {
  url: string;
  form: MarketplaceForm;
  ref: string | null;
  lastCommit: string | null;
  ownerName: string | null;
  builtin: boolean;
}

/** 来源是否生效：本身启用，official 还要配置没关。 */
export const sourceEffective = (
  row: { builtin: boolean; enabled: boolean },
  config: KernelConfig,
): boolean => row.enabled && (!row.builtin || config.marketplaces.official.enabled);

/**
 * Reads a marketplace entry for import: `version` given -> the entry listing that version; omitted
 * -> the newest compatible versioned entry, else the entry without a version, else the newest
 * versioned one (refused later as incompatible). Marketplace missing -> `marketplace.not_found`;
 * marketplace disabled (official offline included), entry or version missing ->
 * `marketplace.entry_not_found`.
 */
export async function loadMarketplaceEntry(
  db: KernelDb,
  config: KernelConfig,
  sourceId: string,
  name: string,
  version?: string,
): Promise<{ entry: MarketplaceEntry; marketplace: MarketplaceOfEntry }> {
  const src = await db
    .selectFrom("marketplaces")
    .select(["name", "builtin", "enabled", "url", "form", "ref", "last_commit", "owner_name"])
    .where("id", "=", sourceId)
    .executeTakeFirst();
  if (!src) throw notFound();
  const rows = sourceEffective(src, config)
    ? await db
        .selectFrom("marketplace_entries")
        .select(["version", "entry"])
        .where("source_id", "=", sourceId)
        .where("name", "=", name)
        .execute()
    : [];
  const entries = rows.map((r) => ({ version: r.version, entry: r.entry as MarketplaceEntry }));
  let picked: MarketplaceEntry | undefined;
  if (version !== undefined) {
    picked = entries.find((e) => e.version === version)?.entry;
  } else {
    const versioned = entries
      .filter((e) => e.version !== "")
      .sort((a, b) => newestFirst(a.version, b.version));
    picked =
      versioned.find((e) => entryCompatible(e.entry))?.entry ??
      entries.find((e) => e.version === "")?.entry ??
      versioned[0]?.entry;
  }
  if (!picked) {
    throw new ApiError(
      "marketplace.entry_not_found",
      version !== undefined
        ? `Version ${version} of marketplace entry ${name} not found`
        : `Marketplace entry ${name} not found`,
    );
  }
  return {
    entry: picked,
    marketplace: {
      url: src.url,
      form: src.form,
      ref: src.ref,
      lastCommit: src.last_commit,
      ownerName: src.owner_name,
      builtin: src.builtin,
    },
  };
}

/**
 * Marketplaces (D16 / C25 / C26, `/api/v1/admin/marketplaces/*`, enterprise admins only): the official
 * marketplace (config `marketplaces.official.*`, synced at startup into the marketplace with id
 * `official`) and enterprise marketplaces (PG, optional token in secrets). A refresh (maintenance
 * job `catalogs-refresh` every `marketplaces.refreshIntervalMinutes` minutes, or manual) tries the main
 * URL and then the mirrors with If-None-Match; on success it replaces that marketplace's cached
 * entries as a whole, when all fail (an invalid manifest included) it keeps the previous ones with
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
   * without user info. The form follows {@link marketplaceForm}; a git marketplace may name a `ref`
   * (branch or tag, default the remote HEAD) and has no mirrors.
   */
  async add(
    actor: string,
    input: {
      name: string;
      url: string;
      form?: MarketplaceForm;
      ref?: string;
      mirrors?: string[];
      token?: string;
    },
    opts: ActorOpts = {},
  ): Promise<MarketplaceView> {
    const name = this.checkName(input.name);
    const { form, url } = marketplaceForm(input.url, input.form);
    this.checkUrls(url, input.mirrors ?? []);
    this.checkGitFields(form, input.ref ?? null, input.mirrors ?? []);
    if (input.token !== undefined) this.checkToken(input.token);
    const id = randomUUID();
    await this.d.db.transaction().execute(async (trx) => {
      await lockEnterpriseAdminsAndAuthorize(trx, actor);
      await trx
        .insertInto("marketplaces")
        .values({
          id,
          name,
          url,
          form,
          ref: input.ref ?? null,
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
          url,
          form,
          ...(input.ref !== undefined && { ref: input.ref }),
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
   * Official only takes `enabled`, any other field -> `marketplace.builtin`. Changing the URL, form
   * or ref clears the ETag and the last commit (the next refresh reads everything again); a new URL
   * gets its form from {@link marketplaceForm} unless `form` is given. `ref: null` follows the
   * remote HEAD. Switching the form clears the other form's field (the ref when becoming http,
   * the mirrors when becoming git) unless the patch sets it.
   */
  async update(
    actor: string,
    id: string,
    patch: {
      name?: string;
      url?: string;
      form?: MarketplaceForm;
      ref?: string | null;
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
          patch.form !== undefined ||
          patch.ref !== undefined ||
          patch.mirrors !== undefined ||
          patch.token !== undefined)
      ) {
        throw builtinErr("changed");
      }
      const target =
        patch.url !== undefined || patch.form !== undefined
          ? marketplaceForm(patch.url ?? row.url, patch.form)
          : { form: row.form, url: row.url };
      // Switching form clears the other form's fields unless the patch sets them: the ref when
      // becoming http, the mirrors when becoming git
      const switched = target.form !== row.form;
      const ref =
        patch.ref !== undefined ? patch.ref : switched && target.form === "http" ? null : row.ref;
      const mirrors = patch.mirrors ?? (switched && target.form === "git" ? [] : row.mirrors);
      this.checkUrls(target.url, mirrors);
      this.checkGitFields(target.form, ref, mirrors);
      if (typeof patch.token === "string") this.checkToken(patch.token);
      const changed: string[] = [];
      const set: Record<string, unknown> = {};
      if (name !== undefined && name !== row.name) {
        set.name = name;
        changed.push("name");
      }
      if (target.url !== row.url) {
        set.url = target.url;
        changed.push("url");
      }
      if (target.form !== row.form) {
        set.form = target.form;
        changed.push("form");
      }
      if (ref !== row.ref) {
        set.ref = ref;
        changed.push("ref");
      }
      if (set.url !== undefined || set.form !== undefined || set.ref !== undefined) {
        set.etag = null;
        set.last_commit = null;
      }
      if (JSON.stringify(mirrors) !== JSON.stringify(row.mirrors)) {
        set.mirrors = JSON.stringify(mirrors);
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
          ...(set.form !== undefined && { form: set.form }),
          ...(set.ref !== undefined && { ref: set.ref }),
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
   * `marketplace.invalid` when some URL returned an invalid manifest, else `marketplace.fetch_failed`
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
    // the API code of each failed URL (undefined: an ordinary fetch failure)
    const netCodes = new Set<MarketplaceNetCode | GitSourceError["code"] | undefined>();
    let sawInvalid = false;
    let outcome:
      | {
          manifest: MarketplaceManifest;
          etag: string | null;
          commit?: string;
          trees?: Map<string, string>;
        }
      | "not_modified"
      | undefined;
    if (row.form === "git") {
      try {
        outcome = await this.fetchGit(row, token, signal);
      } catch (e) {
        if (!(e instanceof GitSourceError || e instanceof MarketplaceInvalidError)) throw e;
        if (e instanceof MarketplaceInvalidError) sawInvalid = true;
        else netCodes.add(e.netCode ?? e.code);
        errors.push(`${row.url}: ${e.message}`);
      }
    }
    for (const url of row.form === "git" ? [] : [row.url, ...row.mirrors]) {
      if (signal.aborted) break;
      try {
        const r = await fetchMarketplaceManifest(url, {
          etag: row.etag,
          ...(token !== undefined && { token, tokenOrigin }),
          maxBytes: config.marketplaces.maxIndexBytes,
          timeoutMs: this.d.fetchTimeoutMs ?? MARKETPLACE_FETCH_TIMEOUT_MS,
          net: marketplaceNetPolicy(config),
          signal,
        });
        outcome = r.status === "not_modified" ? "not_modified" : r;
        break;
      } catch (e) {
        if (!(e instanceof MarketplaceFetchError || e instanceof MarketplaceInvalidError)) throw e;
        if (e instanceof MarketplaceInvalidError) sawInvalid = true;
        else netCodes.add(e.code);
        errors.push(`${url}: ${e.message}`);
      }
    }
    if (outcome === undefined && errors.length === 0) errors.push("refresh aborted");
    const status: "ok" | "error" = outcome === undefined ? "error" : "ok";
    // the branch heads of imported branch-following git entries (outside the transaction)
    const heads =
      outcome === undefined
        ? new Map<string, { commit: string; tree: string | null }>()
        : await this.resolveHeads(
            id,
            outcome === "not_modified" ? undefined : outcome.manifest.plugins,
            { url: row.url, token },
            signal,
          );
    const lastError = status === "error" ? errors.join("\n").slice(0, MAX_ERROR_CHARS) : null;

    const from = await this.d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.catalog-source:${id}`}))`.execute(
        trx,
      );
      const cur = await trx
        .selectFrom("marketplaces")
        .select(["last_status", "url", "mirrors", "form", "ref", "last_commit"])
        .where("id", "=", id)
        .forUpdate()
        .executeTakeFirst();
      if (!cur) throw notFound();
      // 拉取期间管理员改了地址 / 镜像：拉到的是旧地址的内容，不写条目、ETag 与状态（下一次刷新按新地址来）
      if (
        cur.url !== row.url ||
        cur.form !== row.form ||
        cur.ref !== row.ref ||
        // another refresh wrote a commit meanwhile: ours may be older, never move it back
        cur.last_commit !== row.last_commit ||
        JSON.stringify(cur.mirrors) !== JSON.stringify(row.mirrors)
      ) {
        return "stale" as const;
      }
      if (outcome !== undefined && outcome !== "not_modified") {
        await this.replaceEntries(trx, id, outcome.manifest.plugins, outcome.trees);
      }
      if (outcome !== undefined) {
        // heads not resolved this time are unknown again (never a stale head)
        await trx
          .updateTable("marketplace_entries")
          .set({ head_commit: null, tree_oid: null })
          .where("source_id", "=", id)
          .where("head_commit", "is not", null)
          .execute();
      }
      for (const [key, head] of heads) {
        const [name, version] = key.split("\0") as [string, string];
        await trx
          .updateTable("marketplace_entries")
          .set({ head_commit: head.commit, tree_oid: head.tree })
          .where("source_id", "=", id)
          .where("name", "=", name)
          .where("version", "=", version)
          .execute();
      }
      await trx
        .updateTable("marketplaces")
        .set({
          last_status: status,
          last_error: lastError,
          last_refreshed_at: sql<Date>`now()` as unknown as Date,
          ...(outcome !== undefined &&
            outcome !== "not_modified" && {
              etag: outcome.etag,
              last_commit: outcome.commit ?? null,
              owner_name: outcome.manifest.owner?.name ?? null,
            }),
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
      // every URL refused by the same network rule (or the git reader's own code) -> that code,
      // else 502
      const [only] = netCodes;
      const netCode = !sawInvalid && netCodes.size === 1 ? only : undefined;
      throw new ApiError(
        sawInvalid ? "marketplace.invalid" : (netCode ?? "marketplace.fetch_failed"),
        `Marketplace refresh failed; the previous entries are kept. ${lastError ?? ""}`.trim(),
      );
    }
    return this.get(id);
  }

  /**
   * Reads a git marketplace (spec §5.1): resolves `ref` (default the remote HEAD); the same commit
   * as the last refresh -> `not_modified` (nothing else is fetched). Otherwise only what the root
   * needs is read: `.capybara-plugin/marketplace.json` (at most `marketplaces.maxIndexBytes`,
   * validated like an http manifest), else a single-plugin repo (the root has
   * `.capybara-plugin/plugin.json` or `skills/`) becomes one entry with source path `.`, named by
   * plugin.json or, for a skills-only repo, by the repo name (Decision 3). Throws
   * {@link GitSourceError} or {@link MarketplaceInvalidError}.
   */
  private async fetchGit(
    row: SourceRow,
    token: string | undefined,
    signal: AbortSignal,
  ): Promise<
    | { manifest: MarketplaceManifest; etag: null; commit: string; trees: Map<string, string> }
    | "not_modified"
  > {
    const config = this.d.config();
    const options: GitOptions = {
      net: marketplaceNetPolicy(config),
      maxBytes: config.packages.maxBytes,
      signal,
      ...(token !== undefined && { token, tokenOrigin: new URL(row.url).origin }),
    };
    const loc = { url: row.url, ...(row.ref !== null && { ref: row.ref }) };
    const commit = await resolveGitCommit(loc, options);
    if (commit === row.last_commit) return "not_modified";
    const MANIFEST = ".capybara-plugin/marketplace.json";
    let hasSkills = false;
    const dec = (b: Uint8Array) => new TextDecoder().decode(b);
    const { files, trees } = await readGitTreeAndOids(
      { url: row.url, commit },
      {
        ...options,
        include: (path, type) => {
          if (path === "skills" && type === "tree") hasSkills = true;
          return path === ".capybara-plugin" || path === MANIFEST || path === PLUGIN_MANIFEST_FILE;
        },
        // the directory of every path entry (the root for a single-plugin repo)
        trees: (read) => pathEntryDirs(read.get(MANIFEST), config.marketplaces.maxIndexBytes),
      },
    );
    const raw = files.get(MANIFEST);
    let manifest: MarketplaceManifest;
    if (raw !== undefined) {
      if (raw.byteLength > config.marketplaces.maxIndexBytes) {
        throw new MarketplaceInvalidError(
          `${MANIFEST} is larger than ${config.marketplaces.maxIndexBytes} bytes`,
          [],
        );
      }
      let json: unknown;
      try {
        json = JSON.parse(dec(raw));
      } catch {
        throw new MarketplaceInvalidError(`${MANIFEST} is not valid JSON`, []);
      }
      const parsed = parseMarketplaceManifest(json, {
        allowInsecureLoopback: config.marketplaces.allowInsecureLoopback,
      });
      if ("errors" in parsed) {
        throw new MarketplaceInvalidError(
          `${MANIFEST} is not a valid marketplace.json: ${parsed.errors.slice(0, 5).join("; ")}`,
          parsed.errors,
        );
      }
      manifest = parsed;
    } else {
      const pj = files.get(PLUGIN_MANIFEST_FILE);
      let entry: MarketplaceEntry;
      if (pj !== undefined) {
        const m = parsePluginManifest(dec(pj));
        if ("errors" in m) {
          throw new MarketplaceInvalidError(
            `the repository is a single plugin, but its ${PLUGIN_MANIFEST_FILE} is invalid: ${m.errors.slice(0, 5).join("; ")}`,
            m.errors,
          );
        }
        entry = {
          name: m.name,
          summary: { en: m.description.slice(0, SUMMARY_MAX) },
          version: m.version,
          source: { path: "." },
        };
      } else if (hasSkills) {
        const name = pluginNameFrom(
          new URL(row.url).pathname
            .split("/")
            .filter((p) => p !== "")
            .pop() ?? "plugin",
        );
        entry = { name, summary: { en: `Skills of ${name}` }, source: { path: "." } };
      } else {
        throw new MarketplaceInvalidError(
          `the repository has no ${MANIFEST} and is not a plugin (no ${PLUGIN_MANIFEST_FILE} or skills/ at the root)`,
          [],
        );
      }
      manifest = { schemaVersion: 1, name: row.name, plugins: [entry] };
    }
    return { manifest, etag: null, commit, trees };
  }

  /**
   * Resolves the branch heads of the entries {@link headsToResolve} picks (at most
   * {@link MARKETPLACE_HEADS_MAX} per refresh), each through the network rules with the fetch
   * timeout; the token goes only to the marketplace URL's origin. For an entry with a path whose
   * head is not a commit already imported from it, the head is fetched too, for the tree oid of
   * that directory (equal oids: unchanged although the repo moved). A failed lookup leaves the
   * entry unknown (never fails the refresh). Returns `name\0version` -> head.
   */
  private async resolveHeads(
    id: string,
    fresh: MarketplaceEntry[] | undefined,
    m: { url: string; token: string | undefined },
    signal: AbortSignal,
  ): Promise<Map<string, { commit: string; tree: string | null }>> {
    const config = this.d.config();
    const listed =
      fresh ??
      (
        await this.d.db
          .selectFrom("marketplace_entries")
          .select("entry")
          .where("source_id", "=", id)
          .execute()
      ).map((r) => r.entry as MarketplaceEntry);
    const out = new Map<string, { commit: string; tree: string | null }>();
    const names = [...new Set(listed.filter((e) => "git" in e.source).map((e) => e.name))];
    if (names.length === 0) return out;
    const imported = await this.d.db
      .selectFrom("catalog_items as i")
      .innerJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .select(["i.name", "v.version", "v.source", "v.source_ref", "v.integrity", "v.source_detail"])
      .where("i.deleted_at", "is", null)
      .where("i.name", "in", names)
      .execute();
    const todo = headsToResolve(listed, imported, config, MARKETPLACE_HEADS_MAX);
    const timeoutMs = this.d.fetchTimeoutMs ?? MARKETPLACE_FETCH_TIMEOUT_MS;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: Math.min(HEADS_CONCURRENCY, queue.length) }, async () => {
        for (let e = queue.shift(); e !== undefined; e = queue.shift()) {
          if (signal.aborted) return;
          const git = e.source.git;
          const options: GitOptions = {
            net: marketplaceNetPolicy(config),
            maxBytes: config.packages.maxBytes,
            signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            ...(m.token !== undefined && { token: m.token, tokenOrigin: new URL(m.url).origin }),
          };
          try {
            const commit = await resolveGitCommit(
              { url: git.url, ...(git.ref !== undefined && { ref: git.ref }) },
              options,
            );
            const dir = normalGitPath(git.path);
            const known = imported.some(
              (v) => v.name === e.name && gitCommitOf(v.source_detail) === commit,
            );
            let tree: string | null = null;
            if (dir !== "." && !known) {
              const read = await readGitTreeAndOids(
                { url: git.url, commit },
                { ...options, include: () => false, trees: () => [dir] },
              );
              tree = read.trees.get(dir) ?? null;
            }
            out.set(`${e.name}\0${marketplaceEntryVersion(e) ?? ""}`, { commit, tree });
          } catch (err) {
            // a head lookup never fails the refresh: that entry stays unknown
            this.d.log.warn("cannot resolve the branch head of a marketplace entry", {
              marketplace: id,
              entry: e.name,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }),
    );
    return out;
  }

  /** The token of an enterprise marketplace (undefined without one; official never has one). */
  async token(id: string): Promise<string | undefined> {
    return (await this.secrets(this.d.db).get(DEPLOYMENT_SECRETS_ORG, tokenKey(id))) ?? undefined;
  }

  /** Refreshes every effective marketplace (maintenance job `catalogs-refresh`), one failing not stopping the rest. */
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
   * Browses entries (enabled marketplaces only): filtered by marketplace, `q` matches a substring of
   * the name / npm package name / summary (case-insensitive). Ordered by name, version (newest
   * first), marketplace, at most {@link MARKETPLACE_ENTRIES_MAX}; `truncated` means there are more
   * (the UI suggests narrowing the filter).
   */
  async entries(
    q: { marketplaceId?: string; q?: string } = {},
  ): Promise<{ items: MarketplaceEntryView[]; truncated: boolean }> {
    const config = this.d.config();
    let query = this.d.db
      .selectFrom("marketplace_entries as e")
      .innerJoin("marketplaces as s", "s.id", "e.source_id")
      .select([
        "e.source_id",
        "e.name",
        "e.version",
        "e.entry",
        "e.head_commit",
        "e.tree_oid",
        "s.name as source_name",
        "s.form",
        "s.url",
        "s.last_commit",
      ])
      .where("s.enabled", "=", true)
      .orderBy("e.name")
      .orderBy("e.version", "desc")
      .orderBy("e.source_id")
      .limit(MARKETPLACE_ENTRIES_MAX + 1);
    if (!config.marketplaces.official.enabled) query = query.where("s.builtin", "=", false);
    if (q.marketplaceId !== undefined) query = query.where("e.source_id", "=", q.marketplaceId);
    if (q.q !== undefined && q.q !== "") {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      query = query.where((eb) =>
        eb.or([
          eb("e.name", "ilike", like),
          eb(sql<string>`coalesce(e.npm, '')`, "ilike", like),
          eb(sql<string>`e.entry->'summary'->>'en'`, "ilike", like),
          eb(sql<string>`coalesce(e.entry->'summary'->>'zh', '')`, "ilike", like),
        ]),
      );
    }
    const fetched = await query.execute();
    const truncated = fetched.length > MARKETPLACE_ENTRIES_MAX;
    const rows = (truncated ? fetched.slice(0, MARKETPLACE_ENTRIES_MAX) : fetched).sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        bySemverDescOrNone(a.version, b.version) ||
        a.source_id.localeCompare(b.source_id),
    );
    if (rows.length === 0) return { items: [], truncated: false };
    const items = await this.d.db
      .selectFrom("catalog_items as i")
      .leftJoin("catalog_item_versions as v", "v.item_id", "i.id")
      .select([
        "i.id",
        "i.name",
        "v.version",
        "v.source",
        "v.source_ref",
        "v.integrity",
        "v.source_detail",
        "v.imported_at",
      ])
      .where("i.deleted_at", "is", null)
      .where("i.name", "in", [...new Set(rows.map((r) => r.name))])
      .execute();
    const adoptedBy = new Map<
      string,
      { itemId: string; imported: (ImportedAs & { importedAt: Date })[]; versions: string[] }
    >();
    for (const i of items) {
      const a = adoptedBy.get(i.name) ?? { itemId: i.id, imported: [], versions: [] };
      if (i.version !== null) {
        a.imported.push({
          version: i.version,
          source: i.source as string,
          source_ref: i.source_ref as string,
          integrity: i.integrity,
          source_detail: i.source_detail,
          importedAt: i.imported_at as Date,
        });
      }
      adoptedBy.set(i.name, a);
    }
    for (const a of adoptedBy.values()) {
      a.imported.sort(newestFirst);
      a.versions = a.imported.map((v) => v.version);
    }
    const views = rows.map((r): MarketplaceEntryView => {
      const e = r.entry as MarketplaceEntry;
      const version = marketplaceEntryVersion(e);
      const compatible = entryCompatible(e);
      const reason = unimportable(e, r.form, config);
      const importable = reason === undefined;
      const adopted = adoptedBy.get(r.name) ?? null;
      const top = adopted?.versions[0];
      return {
        sourceId: r.source_id,
        sourceName: r.source_name,
        name: r.name,
        version,
        summary: e.summary,
        minKernel: e.minKernel ?? null,
        homepage: e.homepage ?? null,
        permissions: e.permissions ?? null,
        source: e.source,
        compatible,
        importable,
        ...(reason !== undefined && { reason }),
        adopted: adopted ? { itemId: adopted.itemId, versions: [...adopted.versions] } : null,
        newerAvailable:
          compatible && version !== null && top !== undefined && compareVersions(version, top) > 0,
        contentChanged:
          adopted !== null &&
          entryContentChanged(
            e,
            {
              marketplaceId: r.source_id,
              headCommit: r.head_commit,
              treeOid: r.tree_oid,
              url: r.url,
              lastCommit: r.last_commit,
            },
            adopted.imported,
          ),
      };
    });
    return { items: views, truncated };
  }

  /**
   * Replaces the entries of a marketplace; `trees` (a git marketplace) gives each path entry the
   * tree oid of its directory.
   */
  private async replaceEntries(
    trx: Trx,
    id: string,
    entries: MarketplaceEntry[],
    trees?: Map<string, string>,
  ): Promise<void> {
    await trx.deleteFrom("marketplace_entries").where("source_id", "=", id).execute();
    for (let i = 0; i < entries.length; i += INSERT_BATCH) {
      await trx
        .insertInto("marketplace_entries")
        .values(
          entries.slice(i, i + INSERT_BATCH).map((e) => ({
            source_id: id,
            name: e.name,
            version: marketplaceEntryVersion(e) ?? "",
            npm: "npm" in e.source ? e.source.npm.package : null,
            entry: JSON.stringify(e),
            tree_oid:
              "path" in e.source ? (trees?.get(normalGitPath(e.source.path)) ?? null) : null,
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
      form: r.form,
      ref: r.ref,
      lastCommit: r.last_commit,
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

  /** A git marketplace has no mirrors; only a git marketplace has a ref. */
  private checkGitFields(form: MarketplaceForm, ref: string | null, mirrors: string[]): void {
    if (form === "git" && mirrors.length > 0) {
      throw new ApiError(
        "validation_failed",
        "mirrors: a git marketplace has no mirrors (point it at a mirror repository instead)",
      );
    }
    if (form === "http" && ref !== null) {
      throw new ApiError("validation_failed", "ref: only a git marketplace follows a ref");
    }
    if (ref !== null && (ref.length < 1 || ref.length > 256 || /[\s\0]/.test(ref))) {
      throw new ApiError("validation_failed", "ref must be 1–256 characters without spaces");
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
