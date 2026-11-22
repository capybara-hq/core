import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapExtraMarketplace,
  type BootstrapManifest,
  type Logger,
  PLUGIN_MANIFEST_FILE,
  parseBootstrapManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import semver from "semver";
import { marketplaceGitSource, repoOwner } from "../catalog/catalog.service.js";
import { GitSourceError, normalGitPath, readGitTreeAndOids } from "../catalog/git-source.js";
import { marketplaceNetPolicy, marketplaceUrlProblem } from "../catalog/marketplace-fetch.js";
import { CONFIG_MARKETPLACE_PREFIX, marketplaceForm } from "../catalog/marketplaces.service.js";
import { otherNameOwner } from "../catalog/ownership.js";
import {
  catalogPackageError,
  type PluginImport,
  type PluginImportSource,
} from "../catalog/plugin-import.js";
import {
  PluginPackageError,
  readPluginFiles,
  readPluginPackage,
} from "../catalog/plugin-package.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import {
  fetchNpmPackage,
  IntegrityMismatchError,
  NpmFetchError,
  PackageTooLargeError,
} from "../packages/npm.js";
import { PackageTgzError, packPackageTgz, unpackPackageTgz } from "../packages/tgz.js";
import { ExtensionAdminOps } from "./admin-ops.js";
import { writeSnapshot } from "./approvals.js";
import {
  BootstrapExtraMismatchError,
  type BootstrapGitRunEntry,
  type ExtraManifestTraces,
  hasExtraManifestTraces,
  type MergedBootstrapEntry,
  type MergedBootstrapManifest,
} from "./bootstrap-extra.js";
import { ExtensionInstalls } from "./installs.js";
import { PluginApproveLock } from "./locks.js";
import { ExtensionPackageError, permissionSetOfPackage, readExtensionPackage } from "./package.js";
import { diffPermissions, type PermissionSet } from "./permission-set.js";
import { ExtensionRegistry } from "./registry.js";
import type { SingleProviderNote } from "./single-provider.js";

/**
 * The bootstrap step (package ecosystem spec §7, startup bootstrap spec): installs the plugins
 * pinned by the bootstrap manifest (`packages/kernel/bootstrap.json`). It replaced the builtin
 * extensions.
 *
 * - When the run is already done for the manifest nothing is read: no directory, no network, so a
 *   restart of an installed deployment never needs npm.
 * - Otherwise, inside the lock and before anything is written, every entry's tgz is obtained
 *   ({@link resolveBootstrapPackages}): a `*.tgz` file of the optional offline directory whose
 *   sha512 equals the entry's `integrity` (the file name does not matter), else the npm download
 *   of a `source: "npm"` entry (`packages.npmRegistry` / `npmToken` / `maxBytes`, verified against
 *   the pin only), or the git read of a `source: "git"` entry of the extra manifest (its tree at the
 *   pinned commit, packed with `packPackageTgz` and verified against the pin before anything reads
 *   it; see {@link resolveBootstrapPackages}). A workspace entry without a matching file is
 *   `bootstrap.missing_file`, a failed download `bootstrap.download_failed` (a failed git read
 *   `bootstrap.git_read_failed`), a package that differs from the pin
 *   `bootstrap.integrity_mismatch` (all name the plugin), and then nothing is written. Downloading
 *   inside the lock means a fleet starting together downloads once.
 * - The whole run holds the Redis lock `lock:bootstrap` (`LockService`, decision R5 of the Nest
 *   kernel spec: TTL {@link BOOTSTRAP_LOCK_TTL_MS}, renewed every third of it, so a run longer than the TTL keeps
 *   it and a crashed holder's lock expires within it), taken by an unbounded wait that observes
 *   the signal: when several replicas (or `capybara bootstrap` and a starting kernel) run it
 *   together only one runs it; the others wait, then find it done. A lost lock (renewal failed
 *   until expiry) aborts the run at its next step. "Done" is a `bootstrap_runs` row for the
 *   manifest's sha256 (written with the audit `bootstrap.completed` only when every entry
 *   succeeded; otherwise the next start runs it again, which is idempotent).
 * - Two passes per start: the first runs before the extensions load (no object store yet), the
 *   second after them. A `builtin` entry (not required, but builtin in the catalog) is deferred by
 *   the first pass (`deferBuiltin`: skipped, not a failure; the run is then not recorded and the
 *   start runs the second pass), so it may ship skills and templates. A required entry is imported
 *   by the first pass and must succeed; a builtin one that fails is logged like an optional one.
 * - An optional preinstall (neither required nor builtin) may carry `scope: "all"`: its catalog
 *   item is created with that scope (on in every org, switchable) instead of `optional`. The
 *   scope is read only when the item is first imported (a new version of a live item keeps the
 *   item's scope), so a later change of `scope` in the manifest never rewrites it: the super
 *   admin owns the scope after import.
 * - Only entries new to the manifest are installed (Ruling 5): an optional entry that the last
 *   completed run already handled and that is not installed now (a super admin uninstalled
 *   it) stays uninstalled -> `kept`. A required or builtin entry is always installed (a
 *   declarative one imported again when its catalog item is gone).
 * - Per entry, by the installed state of its extension:
 *   - not installed (and new, or required): imported into the catalog (source `bootstrap`, ref
 *     `bootstrap:<name>@<version>`, like a marketplace import; a git entry is recorded as the
 *     managed marketplace `config:<marketplace>` it names, with the git location an admin import of
 *     that marketplace's `path` entry records, so later imports from it are the same source),
 *     installed, approved (snapshot
 *     source `bootstrap`, audited `extension.permissions_approved` with `source: "bootstrap"`)
 *     and enabled -> `installed`;
 *   - installed from `bootstrap` at a lower version: upgraded the same way (core's release vouched
 *     for the version, so new permissions are pre-approved and audited), keeping the desired state
 *     a super admin chose (a disabled optional plugin stays disabled) -> `upgraded`;
 *   - installed at a higher version, or from another source (a super admin upgraded it), or
 *     the name is config-declared (`declared`: config wins, no install record is created):
 *     untouched, never downgraded -> `kept`;
 *   - a declarative plugin (no extension): imported into the catalog only -> `imported` (`kept`
 *     when that version is already there, or when the entry is not new).
 *   Every extension entry gets `extension_installs.required` from the manifest, and a required one
 *   is enabled on the deployment.
 * - Package bytes are content-addressed: when the very same tgz was ingested before with another
 *   source (e.g. imported from a marketplace), its `extension_packages` row keeps that source and
 *   so does the install record, which is then not a bootstrap install and never upgraded by a
 *   later manifest (`kept`, like a plugin the admin installed).
 * - An install record still `required` whose entry left the manifest is not uninstalled; it only
 *   loses `required` -> `required_cleared`.
 * A failed entry does not stop the others; the run then throws {@link BootstrapFailedError} naming
 * them. The packages are kept in PG (`blob_store = 'pg'`), so installing an extension never needs
 * the object store (object-store-s3 is itself a bootstrap plugin) and the directory and npm are
 * never needed again. A plugin's icons and setup guide files are kept in PG too (`catalog_files`),
 * so they never need it either; its skills, connector templates and agent templates do (an entry
 * shipping them fails while no object store runs; an optional one is retried after the extensions
 * loaded, and a plugin that must be builtin and ships them is a `builtin` entry, which only the
 * pass after the extensions load imports).
 */

/** The bootstrap manifest that ships with the kernel package. */
export const BOOTSTRAP_MANIFEST_FILE = fileURLToPath(
  new URL("../../bootstrap.json", import.meta.url),
);

/** What the bootstrap step did with one entry (or one install record that left the manifest). */
export interface BootstrapEntryResult {
  name: string;
  action: "installed" | "upgraded" | "kept" | "imported" | "required_cleared";
  /** The version installed / imported now, or the version kept. */
  version: string;
  /**
   * An optional entry installed (or upgraded) but left disabled: another enabled extension holds
   * a single-provider extension point it provides. (A required entry fails instead.)
   */
  leftDisabled?: SingleProviderNote;
  /**
   * The entry came from the extra manifest (absent otherwise, and in rows written before this
   * flag): a later process without an extra manifest that finds it in the last run refuses to run
   * (ruling R17).
   */
  extra?: true;
}

export interface BootstrapResult {
  /** sha256 (hex) of the manifest ({@link bootstrapManifestSha256}). */
  manifestSha256: string;
  results: BootstrapEntryResult[];
}

/** One entry the bootstrap step could not complete. */
export interface BootstrapFailure {
  name: string;
  required: boolean;
  code: string;
  message: string;
}

/**
 * Some entries failed or were deferred (the others were done); the run is not recorded as done.
 */
export class BootstrapFailedError extends Error {
  /**
   * @param results what the entries that did not fail did (pass them as `carry` to a later run in
   * the same start, so its record keeps `installed` instead of `kept`).
   * @param deferred the builtin entries a first pass skipped (`deferBuiltin`): not failures, the
   * later pass of the same start imports them.
   * @param packages the packages this run obtained, by entry name (pass them as `packages` to the
   * later pass of the same start, so nothing is downloaded twice).
   */
  constructor(
    readonly failures: BootstrapFailure[],
    readonly results: BootstrapEntryResult[] = [],
    readonly deferred: string[] = [],
    readonly packages: ReadonlyMap<string, Uint8Array> = new Map(),
  ) {
    super(
      failures.length > 0
        ? `bootstrap failed for ${failures.map((f) => `${f.name}${f.required ? " (required)" : ""}: ${f.message}`).join("; ")}`
        : `bootstrap deferred the builtin plugins ${deferred.join(", ")} to the pass after the extensions load`,
    );
    this.name = "BootstrapFailedError";
  }

  /** A required entry failed: the kernel must not serve without it. */
  get requiredFailed(): boolean {
    return this.failures.some((f) => f.required);
  }
}

/** sha256 (hex) of a manifest: of its JSON text as parsed (key order kept). */
export function bootstrapManifestSha256(
  manifest: Omit<BootstrapManifest, "plugins"> & { plugins: readonly object[] },
): string {
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

/** Reads and parses a bootstrap manifest file; an invalid one throws with its problems. */
export async function readBootstrapManifest(
  file: string = BOOTSTRAP_MANIFEST_FILE,
): Promise<BootstrapManifest> {
  const parsed = parseBootstrapManifest(JSON.parse(await readFile(file, "utf8")));
  if ("errors" in parsed) {
    throw new Error(`invalid bootstrap manifest ${file}: ${parsed.errors.join("; ")}`);
  }
  return parsed;
}

const integrityOf = (bytes: Uint8Array) =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** What {@link resolveBootstrapPackages} needs from the kernel config. */
export interface BootstrapResolveOptions {
  /**
   * The offline directory: every `*.tgz` directly in it is matched to the entries by sha512.
   * Omitted or missing: no offline packages.
   */
  dir?: string;
  config: Pick<KernelConfig, "packages" | "marketplaces" | "net">;
  signal?: AbortSignal;
  log?: Pick<Logger, "warn">;
  /** The npm download (default {@link fetchNpmPackage}; tests replace it). */
  fetch?: typeof fetchNpmPackage;
  /**
   * Entries whose package failing to be obtained is that entry's failure only: the error goes into
   * `failed` (by entry name) and the other entries are still obtained. Every other entry's failure
   * throws, so nothing is written.
   */
  soft?: (e: MergedBootstrapEntry) => boolean;
  failed?: Map<string, ApiError>;
  /**
   * The credential of an extra-manifest marketplace (by name) for its git entries; default: the
   * token `marketplaces.tokens[name]` (never the file or the secrets table) and the manifest's
   * `username`. It is sent only to that marketplace URL's origin.
   */
  gitCredentials?: (marketplace: string) => { token?: string; username?: string };
  /** Filled with the git tree oid of each git entry read from git (by entry name). */
  gitTrees?: Map<string, string>;
}

/**
 * The marketplace a git entry names, its URL expanded as the managed row's (`config:<name>`) is and
 * checked as an admin-added one is (`bootstrap.extra_invalid` otherwise).
 */
export function bootstrapGitMarketplace(
  manifest: Pick<MergedBootstrapManifest, "extra">,
  e: BootstrapGitRunEntry,
  config: Pick<KernelConfig, "marketplaces">,
): BootstrapExtraMarketplace {
  const m = manifest.extra?.marketplaces.find((x) => x.name === e.marketplace);
  const invalid = (why: string) =>
    new ApiError(
      "bootstrap.extra_invalid",
      `Bootstrap plugin ${e.name} ${e.version}: marketplace ${e.marketplace} ${why}`,
    );
  if (m === undefined) throw invalid("is not declared in the extra bootstrap manifest");
  const { form, url } = marketplaceForm(m.url);
  if (form !== "git") throw invalid("is not a git repository");
  const problem = marketplaceUrlProblem(url, config.marketplaces.allowInsecureLoopback);
  if (problem !== null) throw invalid(`has an unusable url: ${problem}`);
  return { ...m, url };
}

/** The managed marketplace's id of an extra-manifest marketplace (the row the kernel start creates). */
const managedMarketplaceId = (name: string) => `${CONFIG_MARKETPLACE_PREFIX}${name}`;

/**
 * Obtains every entry's tgz, checked against its pinned sha512: from the offline directory when a
 * file there has that sha512, else (a `source: "npm"` entry) downloaded from the npm registry and
 * verified against the pin (the packument's `dist.integrity` is not consulted), else (a
 * `source: "git"` entry) its marketplace's tree at the pinned commit, the files under `path`
 * re-rooted and packed with `packPackageTgz` (the pin is defined on that pack), refused unless the
 * pack's sha512 is the pin: nothing of an unverified tree is read, translated or imported. The
 * marketplace's token and username go only to its URL's origin. Throws an {@link ApiError} naming
 * the plugin for the first entry it cannot obtain (`bootstrap.missing_file`,
 * `bootstrap.download_failed`, `bootstrap.git_read_failed`, `bootstrap.integrity_mismatch`), except
 * for the `soft` entries (recorded in `failed`, left out of the result).
 */
export async function resolveBootstrapPackages(
  manifest: MergedBootstrapManifest,
  o: BootstrapResolveOptions,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  if (manifest.plugins.length === 0) return out;
  const { npmRegistry, npmToken, maxBytes } = o.config.packages;
  const offline = o.dir !== undefined ? await scanOfflineDir(o.dir, maxBytes, o.log) : new Map();
  const fetchPackage = o.fetch ?? fetchNpmPackage;
  const signal = o.signal ?? new AbortController().signal;
  const where = o.dir !== undefined ? o.dir : "the bootstrap directory (config bootstrap.dir)";
  for (const e of manifest.plugins) {
    signal.throwIfAborted();
    try {
      out.set(e.name, await obtain(e));
    } catch (err) {
      if (signal.aborted || !(err instanceof ApiError) || o.soft?.(e) !== true) throw err;
      o.failed?.set(e.name, err);
    }
  }
  return out;

  async function obtain(e: MergedBootstrapEntry): Promise<Uint8Array> {
    const found = offline.get(e.integrity);
    if (found !== undefined) return found;
    if (e.source === "git") return obtainGit(e);
    if (e.source === "workspace") {
      throw new ApiError(
        "bootstrap.missing_file",
        `Bootstrap plugin ${e.name} ${e.version}: no file in ${where} has its pinned sha512 (${e.integrity.slice(0, 19)}…), and a workspace entry cannot be downloaded; put its package tgz (pnpm pack-plugin ${e.path}) in that directory`,
      );
    }
    const registry = registryOrigin(npmRegistry);
    const offlineHint = `to install offline, put the package tgz (npm pack ${e.npm}@${e.version}, any file name) in ${where}`;
    try {
      const r = await fetchPackage(
        {
          registry: npmRegistry,
          ...(npmToken !== undefined && { token: npmToken }),
          maxBytes,
          net: marketplaceNetPolicy(o.config),
        },
        e.npm,
        e.version,
        signal,
        { expectedIntegrity: e.integrity },
      );
      return r.bytes;
    } catch (err) {
      if (signal.aborted) throw err;
      if (err instanceof IntegrityMismatchError) {
        throw new ApiError(
          "bootstrap.integrity_mismatch",
          `Bootstrap plugin ${e.name} ${e.version}: the package ${e.npm}@${e.version} downloaded from ${registry} does not match its pinned sha512 (expected ${e.integrity.slice(0, 19)}…, got ${err.actual.slice(0, 19)}…); refusing to install anything`,
        );
      }
      const reason =
        err instanceof NpmFetchError || err instanceof PackageTooLargeError
          ? err.message
          : err instanceof Error
            ? err.message
            : String(err);
      throw new ApiError(
        "bootstrap.download_failed",
        `Bootstrap plugin ${e.name} ${e.version}: cannot download ${e.npm}@${e.version} from ${registry} (${reason}); ${offlineHint}, or set packages.npmRegistry to a reachable mirror`,
      );
    }
  }

  async function obtainGit(e: BootstrapGitRunEntry): Promise<Uint8Array> {
    const m = bootstrapGitMarketplace(manifest, e, o.config);
    const u = new URL(m.url);
    const at = `${e.path} at ${e.commit.slice(0, 12)} of marketplace ${m.name} (${u.origin}${u.pathname})`;
    const cred = (o.gitCredentials ?? defaultGitCredentials)(m.name);
    const token = cred.token !== undefined && cred.token !== "" ? cred.token : undefined;
    const dir = normalGitPath(e.path);
    let read: Awaited<ReturnType<typeof readGitTreeAndOids>>;
    try {
      read = await readGitTreeAndOids(
        { url: m.url, commit: e.commit, path: e.path },
        {
          net: marketplaceNetPolicy(o.config),
          maxBytes,
          signal,
          ...(token !== undefined && {
            token,
            tokenOrigin: u.origin,
            ...(cred.username !== undefined && cred.username !== "" && { username: cred.username }),
          }),
          trees: () => [dir],
        },
      );
    } catch (err) {
      if (signal.aborted) throw err;
      // git-source messages never carry the token; redacted all the same, it is a credential
      const reason = errMsg(err);
      const redacted = token !== undefined ? reason.replaceAll(token, "***") : reason;
      // A bootstrap entry pins a commit by its sha: a ref tip is not what it can change to
      const message =
        err instanceof GitSourceError && err.refusedCommit !== undefined
          ? `the host refused to send commit ${err.refusedCommit} by its sha. The commit must be fetchable by its sha (GitHub: always; GitLab, Gitea and other hosts: only when fetching unadvertised commits is allowed, e.g. git's uploadpack.allowReachableSHA1InWant or the host's equivalent), or pin the commit of a tag and keep the tag, or put its pack (capybara-plugin bootstrap --write --out <dir>) in the offline directory, ${where}`
          : `${redacted}; to install offline, put its pack (capybara-plugin bootstrap --write) in ${where}`;
      throw new ApiError(
        "bootstrap.git_read_failed",
        `Bootstrap plugin ${e.name} ${e.version}: cannot read ${at}: ${message}`,
      );
    }
    const pack = await packPackageTgz(read.files);
    const actual = integrityOf(pack);
    if (actual !== e.integrity) {
      throw new ApiError(
        "bootstrap.integrity_mismatch",
        `Bootstrap plugin ${e.name} ${e.version}: ${at} packs to another sha512 than its pin (expected ${e.integrity.slice(0, 19)}…, got ${actual.slice(0, 19)}…); refusing to install anything`,
      );
    }
    const tree = read.trees.get(dir);
    if (tree !== undefined) o.gitTrees?.set(e.name, tree);
    return pack;
  }

  function defaultGitCredentials(name: string): { token?: string; username?: string } {
    const tokens = o.config.marketplaces.tokens;
    const username = manifest.extra?.marketplaces.find((x) => x.name === name)?.username;
    return {
      ...(Object.hasOwn(tokens, name) && { token: tokens[name] }),
      ...(username !== undefined && { username }),
    };
  }
}

/** The message of a thrown value. */
export const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The registry's origin, for messages (never its credentials or path). */
function registryOrigin(registry: string): string {
  try {
    return new URL(registry).origin;
  } catch {
    return "the configured npm registry";
  }
}

/**
 * The `*.tgz` files directly in `dir` by their sha512 integrity. A missing directory is an empty
 * one; a file larger than `maxBytes` is skipped with a warning.
 */
async function scanOfflineDir(
  dir: string,
  maxBytes: number,
  log: Pick<Logger, "warn"> | undefined,
): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return out;
    throw err;
  }
  for (const name of names.sort()) {
    if (!name.endsWith(".tgz")) continue;
    const file = join(dir, name);
    const st = await stat(file).catch(() => undefined);
    if (!st?.isFile()) continue;
    if (st.size > maxBytes) {
      log?.warn("bootstrap: a file in the bootstrap directory exceeds packages.maxBytes; skipped", {
        file,
        size: st.size,
        maxBytes,
      });
      continue;
    }
    const bytes = new Uint8Array(await readFile(file));
    const integrity = integrityOf(bytes);
    if (!out.has(integrity)) out.set(integrity, bytes);
  }
  return out;
}

/** The lock around a whole run (`lock:bootstrap`). */
export const BOOTSTRAP_LOCK_KEY = "bootstrap";
/** Its lifetime without renewal; a run keeps it by renewal, a crashed holder's expires. */
export const BOOTSTRAP_LOCK_TTL_MS = 120_000;
/** Optional provider: the lock's lifetime (ms) instead of {@link BOOTSTRAP_LOCK_TTL_MS} (tests shorten it). */
export const BOOTSTRAP_LOCK_TTL = Symbol("BOOTSTRAP_LOCK_TTL");
/** The pause between attempts while another holder runs the step. */
const LOCK_RETRY_MS = 500;

/** What a run imports a declarative entry or an entry's catalog version with. */
export type BootstrapImports = Pick<PluginImport, "prepare" | "prepareGit" | "confirm">;

/** A git entry's import: its files (unpacked from the verified pack) and where they came from. */
interface GitEntryImport {
  files: Map<string, Uint8Array>;
  /** Publisher of a skills-only tree (the repo owner, as an admin import names it). */
  publisher: string;
}

@Injectable()
export class BootstrapService {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(PluginApproveLock) private readonly approveLock: PluginApproveLock,
    @Inject(ExtensionInstalls) private readonly installs: ExtensionInstalls,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    /**
     * Config-declared extension names (an entry of the same name is kept, config wins, and no
     * install record is created): the start sequence records them before the bootstrap step, the
     * CLI from its inspection.
     */
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(KernelConfigService) private readonly configService: KernelConfigService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    /** The lock's lifetime without renewal. */
    @Optional()
    @Inject(BOOTSTRAP_LOCK_TTL)
    private readonly lockTtlMs: number = BOOTSTRAP_LOCK_TTL_MS,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  private config(): KernelConfig {
    return this.configService.get();
  }

  /** Whether the bootstrap step completed for the manifest with this sha256. */
  async isDone(manifestSha256: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("bootstrap_runs")
      .select("manifest_sha256")
      .where("manifest_sha256", "=", manifestSha256)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * What an extra manifest left ({@link ExtraManifestTraces}): the config-managed marketplaces
   * (`managed = 'config'`) and the entries the last completed run flagged `extra`. A process
   * without an extra manifest that finds any is configured differently from the ones that wrote
   * them (rulings R14, R17). An entry a built-in manifest dropped is never flagged, so it is no
   * trace.
   */
  async extraManifestTraces(): Promise<ExtraManifestTraces> {
    const rows = await this.db
      .selectFrom("marketplaces")
      .select("name")
      .where("managed", "=", "config")
      .orderBy("name")
      .execute();
    const last = await this.lastRunResults();
    return {
      marketplaces: rows.map((r) => r.name),
      plugins: (last ?? [])
        .filter((r) => r.extra === true)
        .map((r) => r.name)
        .sort(),
    };
  }

  /**
   * Runs the bootstrap step (see the file header); when it is already done for this manifest
   * (also when another replica finished it while this one waited for the lock) returns the
   * recorded result without doing anything. `carry`: the results of an earlier, failed run in the
   * same start ({@link BootstrapFailedError.results}); an entry it installed, upgraded or imported
   * keeps that action instead of `kept` in this run's record. A manifest without an extra manifest
   * while an extra manifest left traces ({@link extraManifestTraces}) throws
   * {@link BootstrapExtraMismatchError}, checked under the lock before anything is obtained or
   * written (ruling R16): the caller's own check may have run before another replica's sync
   * committed. Every result of an entry from the extra manifest is flagged `extra` (R17).
   */
  async run(o: {
    manifest: MergedBootstrapManifest;
    /** The offline directory (see {@link resolveBootstrapPackages}); omitted: npm only. */
    dir?: string;
    signal?: AbortSignal;
    carry?: readonly BootstrapEntryResult[];
    /**
     * The first pass of a start (before the extensions load, so no object store): builtin entries
     * are skipped, and the run throws {@link BootstrapFailedError} with them as `deferred` instead
     * of being recorded as done.
     */
    deferBuiltin?: boolean;
    /**
     * Packages an earlier pass of the same start obtained ({@link BootstrapFailedError.packages});
     * one whose sha512 still equals its entry's pin is used instead of obtaining it again.
     */
    packages?: ReadonlyMap<string, Uint8Array>;
    /** The plugin import a declarative entry (or an entry's catalog version) goes through. */
    imports: BootstrapImports;
  }): Promise<BootstrapResult> {
    const manifestSha256 = bootstrapManifestSha256(o.manifest);
    const recorded = async () => {
      const done = await this.db
        .selectFrom("bootstrap_runs")
        .select("results")
        .where("manifest_sha256", "=", manifestSha256)
        .executeTakeFirst();
      return done && { manifestSha256, results: done.results as BootstrapEntryResult[] };
    };
    // Done: no lock, no directory, no network
    const before = await recorded();
    if (before) return before;
    return this.locked(o.signal, async (signal) => {
      // Another replica may have finished it while this one waited for the lock
      const done = await recorded();
      if (done) return done;
      if (o.manifest.extra === undefined) {
        const traces = await this.extraManifestTraces();
        if (hasExtraManifestTraces(traces)) throw new BootstrapExtraMismatchError(traces);
      }
      const fromExtra = new Set(o.manifest.extra?.plugins);
      const deferBuiltin = o.deferBuiltin === true;
      const isDeferred = (e: MergedBootstrapEntry) => deferBuiltin && e.builtin === true;
      // Every package is obtained and checked before the first write (a deferred entry's by the
      // later pass). The first pass refuses to write anything when one is missing or tampered;
      // the later pass only fails that entry unless it is required.
      const files = new Map<string, Uint8Array>();
      const fetchFailed = new Map<string, ApiError>();
      const toObtain: MergedBootstrapEntry[] = [];
      const gitTrees = new Map<string, string>();
      for (const e of o.manifest.plugins) {
        if (isDeferred(e)) continue;
        const kept = o.packages?.get(e.name);
        if (kept !== undefined && integrityOf(kept) === e.integrity) files.set(e.name, kept);
        else toObtain.push(e);
      }
      const obtained = await resolveBootstrapPackages(
        { ...o.manifest, plugins: toObtain },
        {
          ...(o.dir !== undefined && { dir: o.dir }),
          config: this.config(),
          signal,
          log: this.log,
          ...(!deferBuiltin && {
            soft: (e: MergedBootstrapEntry) => !e.required,
            failed: fetchFailed,
          }),
          gitTrees,
        },
      );
      for (const [name, bytes] of obtained) files.set(name, bytes);
      const handled = await this.lastRunNames();
      const results: BootstrapEntryResult[] = [];
      const failures: BootstrapFailure[] = [];
      const deferred: string[] = [];
      for (const e of o.manifest.plugins) {
        signal.throwIfAborted();
        if (isDeferred(e)) {
          deferred.push(e.name);
          continue;
        }
        await this.warnIfHeld(e);
        try {
          const fetchErr = fetchFailed.get(e.name);
          if (fetchErr !== undefined) throw fetchErr;
          const r = await this.entry(e, files.get(e.name) as Uint8Array, handled, o.imports, {
            manifest: o.manifest,
            tree: gitTrees.get(e.name),
          });
          const c = carried(r, o.carry);
          results.push(fromExtra.has(e.name) ? { ...c, extra: true } : c);
        } catch (err) {
          this.log.error("bootstrap: a plugin could not be installed", {
            plugin: e.name,
            version: e.version,
            required: e.required,
            ...(e.builtin === true && { builtin: true }),
            err,
          });
          failures.push({
            name: e.name,
            required: e.required,
            code: err instanceof ApiError ? err.code : "internal",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
      results.push(...(await this.clearRemoved(o.manifest)));
      if (failures.length > 0 || deferred.length > 0) {
        throw new BootstrapFailedError(failures, results, deferred, files);
      }
      signal.throwIfAborted();
      await this.recordDone(manifestSha256, results);
      this.log.info("bootstrap completed", { manifestSha256, results });
      return { manifestSha256, results };
    });
  }

  /**
   * A pin whose plugin name an org holds (a live org-owned catalog item): the bootstrap takes no
   * name over (ruling P3-28), so the entry fails; this warning tells the super admin why and
   * which org holds it (final review M4).
   */
  private async warnIfHeld(e: MergedBootstrapEntry): Promise<void> {
    const holder = await otherNameOwner(this.db, e.name, null);
    if (holder?.kind !== "org") return;
    this.log.warn(
      "bootstrap: the plugin name is held by an organization; the entry cannot take it over until the organization renames or deletes its plugin",
      {
        plugin: e.name,
        version: e.version,
        required: e.required,
        ownerOrgId: holder.orgId,
        ownerOrg: holder.name,
      },
    );
  }

  /** The `bootstrap_runs` row and the `bootstrap.completed` audit, in one transaction. */
  @Transactional()
  private async recordDone(manifestSha256: string, results: BootstrapEntryResult[]): Promise<void> {
    await this.db
      .insertInto("bootstrap_runs")
      .values({
        manifest_sha256: manifestSha256,
        completed_at: sql<Date>`now()` as unknown as Date,
        results: JSON.stringify(results),
      })
      .execute();
    await audit(this.db, {
      action: "bootstrap.completed",
      target: manifestSha256,
      detail: { manifestSha256, results },
    });
  }

  /**
   * Runs `fn` holding `lock:bootstrap`: waits without bound while another replica holds it
   * (until `signal` aborts), renews it while `fn` runs and releases it afterwards. `fn` gets a
   * signal that also aborts when the lock is lost.
   */
  private async locked<T>(
    signal: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const handle = await this.locks.acquire(BOOTSTRAP_LOCK_KEY, {
      ttlMs: this.lockTtlMs,
      waitMs: Number.POSITIVE_INFINITY,
      retryMs: LOCK_RETRY_MS,
      ...(signal !== undefined && { signal }),
    });
    // An unbounded wait returns a handle or throws the abort reason
    if (!handle) throw new Error("bootstrap: the lock could not be taken");
    try {
      return await fn(signal ? AbortSignal.any([signal, handle.lost]) : handle.lost);
    } finally {
      await handle.release();
    }
  }

  /** The results of the last completed run (undefined before any run completed). */
  private async lastRunResults(): Promise<BootstrapEntryResult[] | undefined> {
    const row = await this.db
      .selectFrom("bootstrap_runs")
      .select("results")
      .orderBy("completed_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row?.results as BootstrapEntryResult[] | undefined;
  }

  /** The entry names the last completed run handled (undefined before any run completed). */
  private async lastRunNames(): Promise<Set<string> | undefined> {
    const results = await this.lastRunResults();
    if (!results) return undefined;
    return new Set(results.filter((r) => r.action !== "required_cleared").map((r) => r.name));
  }

  private async entry(
    e: MergedBootstrapEntry,
    bytes: Uint8Array,
    handled: ReadonlySet<string> | undefined,
    imports: BootstrapImports,
    /** For a git entry: the manifest (its marketplaces) and the tree oid when read from git now. */
    at: { manifest: MergedBootstrapManifest; tree: string | undefined },
  ): Promise<BootstrapEntryResult> {
    let plugin: { name: string; version: string; extension: boolean };
    let source: PluginImportSource;
    let git: GitEntryImport | undefined;
    if (e.source === "git") {
      const m = bootstrapGitMarketplace(at.manifest, e, this.config());
      git = { files: await this.unpackGit(e, bytes), publisher: repoOwner(m.url) };
      plugin = this.gitPlugin(e, git.files);
      // The source an admin import of the managed marketplace's `path` entry records (same
      // arguments), so its later versions add to this item
      const where = marketplaceGitSource(
        {
          url: m.url,
          commit: e.commit,
          path: e.path,
          ...(m.ref !== undefined && { ref: m.ref }),
        },
        { commit: e.commit, tree: at.tree },
        false,
      );
      const marketplaceId = managedMarketplaceId(m.name);
      // The managed row is created by the kernel start before its bootstrap step; `capybara
      // bootstrap` may run before any start, when the item cannot name it yet (a foreign key).
      // The git location alone makes it the same source; an import from the marketplace names it
      const managed = await this.db
        .selectFrom("marketplaces")
        .select("id")
        .where("id", "=", marketplaceId)
        .executeTakeFirst();
      source = {
        kind: "bootstrap",
        ref: `${marketplaceId}:${where.ref}`,
        integrity: e.integrity,
        ...(managed !== undefined && { marketplaceId }),
        detail: where.detail,
      };
    } else {
      const pkg = await readPluginPackage(bytes, {
        maxBytes: this.config().packages.maxBytes,
        hostSdkVersion: SDK_VERSION,
      }).catch((err: unknown) => {
        throw err instanceof PluginPackageError ? catalogPackageError(err) : err;
      });
      plugin = {
        name: pkg.manifest.name,
        version: pkg.manifest.version,
        extension: pkg.manifest.extension !== undefined,
      };
      source = {
        kind: "bootstrap",
        ref: `bootstrap:${e.name}@${e.version}`,
        integrity: e.integrity,
      };
    }
    if (plugin.name !== e.name || plugin.version !== e.version) {
      throw new ApiError(
        "catalog.invalid_manifest",
        `The package for bootstrap entry ${e.name} ${e.version} contains plugin ${plugin.name} ${plugin.version}`,
      );
    }
    // Not new to the manifest: an optional entry left out on purpose stays out (Ruling 5)
    const isNew = handled === undefined || !handled.has(e.name);
    // Required and builtin entries are builtin in the catalog and put back when missing
    const builtin = e.required || e.builtin === true;
    if (!plugin.extension) {
      await this.markBuiltin(e.name, builtin);
      if (!isNew && !(builtin && !(await this.hasLiveItem(e.name)))) {
        return { name: e.name, action: "kept", version: e.version };
      }
      const imported = await this.importOnly(e, bytes, source, imports, git);
      await this.markBuiltin(e.name, builtin);
      return { name: e.name, action: imported ? "imported" : "kept", version: e.version };
    }
    if (this.registry.declared().has(e.name)) {
      this.log.warn(
        "bootstrap: the plugin is declared in the extensions config list; the config plugin is used",
        { plugin: e.name },
      );
      return { name: e.name, action: "kept", version: e.version };
    }
    const row = await this.db
      .selectFrom("extension_installs")
      .select(["version", "source", "required", "desired_state", "sha256"])
      .where("name", "=", e.name)
      .executeTakeFirst();
    if (!row && !isNew && !builtin) {
      this.log.info("bootstrap: an optional plugin that is not installed stays uninstalled", {
        plugin: e.name,
      });
      return { name: e.name, action: "kept", version: e.version };
    }
    let result: BootstrapEntryResult;
    let leftDisabled: SingleProviderNote | undefined;
    if (!row) {
      leftDisabled = await this.deploy(e, bytes, source, true, imports, git);
      result = { name: e.name, action: "installed", version: e.version };
    } else if (row.source === "bootstrap" && isLower(row.version, e.version)) {
      // The desired state the admin chose is kept; a required plugin is enabled below anyway
      leftDisabled = await this.deploy(
        e,
        bytes,
        source,
        row.desired_state === "enabled",
        imports,
        git,
      );
      result = { name: e.name, action: "upgraded", version: e.version };
    } else {
      if (
        row.source === "bootstrap" &&
        row.version === e.version &&
        row.sha256 !== createHash("sha256").update(bytes).digest("hex")
      ) {
        // The pin changed bytes without a version bump (an image built from main between
        // releases): the installed package stays, so say so instead of keeping it silently
        this.log.warn(
          "bootstrap: the image's package differs from the installed one at the same version; the installed package is kept (bump the version to roll it out)",
          { plugin: e.name, version: e.version },
        );
      }
      result = { name: e.name, action: "kept", version: row.version };
    }
    if (row?.required !== e.required) {
      await this.db
        .updateTable("extension_installs")
        .set({ required: e.required })
        .where("name", "=", e.name)
        .execute();
    }
    // A required install must run on the deployment (an org cannot use it otherwise)
    if (e.required && row?.desired_state === "disabled") {
      leftDisabled = await this.enableOrWarn(e);
    }
    await this.markBuiltin(e.name, builtin);
    return leftDisabled === undefined ? result : { ...result, leftDisabled };
  }

  /** Whether a live (not deleted) platform catalog item has this name. */
  private async hasLiveItem(name: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", name)
      .where("owner_org_id", "is", null)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return row !== undefined;
  }

  /**
   * The catalog item of a bootstrap entry follows `required` / `builtin`: such an entry is builtin,
   * offered to every org (scope `all`, which an org admin cannot switch off) and not disabled
   * (migration 0075 could leave a required plugin disabled); an entry that stops being required or
   * builtin is no longer builtin and keeps scope `all` (the admin may change it from then on).
   * Only the platform item: an org-owned item of the same name (the entry then fails with
   * `plugin.name_taken`) is never touched.
   */
  private async markBuiltin(name: string, builtin: boolean): Promise<void> {
    const touch = { updated_at: sql<Date>`now()` as unknown as Date };
    if (builtin) {
      await this.db
        .updateTable("catalog_items")
        .set({
          builtin: true,
          scope: "all",
          disabled: false,
          ...touch,
        })
        .where("name", "=", name)
        .where("owner_org_id", "is", null)
        .where("deleted_at", "is", null)
        .where((eb) =>
          eb.or([eb("builtin", "=", false), eb("scope", "<>", "all"), eb("disabled", "=", true)]),
        )
        .execute();
      return;
    }
    await this.db
      .updateTable("catalog_items")
      .set({ builtin: false, ...touch })
      .where("name", "=", name)
      .where("owner_org_id", "is", null)
      .where("deleted_at", "is", null)
      .where("builtin", "=", true)
      .execute();
  }

  /**
   * The files of a git entry's verified pack (exactly the tree read at its commit). A tree the tgz
   * rules refuse is `catalog.invalid_manifest`.
   */
  private async unpackGit(e: BootstrapGitRunEntry, bytes: Uint8Array) {
    try {
      const unpacked = await unpackPackageTgz(bytes, {
        maxBytes: this.config().packages.maxBytes,
      });
      return new Map<string, Uint8Array>(unpacked.map((f) => [f.path, f.data]));
    } catch (err) {
      if (!(err instanceof PackageTgzError)) throw err;
      throw new ApiError(
        "catalog.invalid_manifest",
        `The tree of bootstrap entry ${e.name} ${e.version}: ${err.issues.join("; ")}`,
      );
    }
  }

  /**
   * Name, version and extension of a git entry's tree: from its `plugin.json`; a tree without one
   * (a Claude Code or skills-only plugin, never an extension) is named by the entry, which its
   * import's review is checked against ({@link prepareGitEntry}).
   */
  private gitPlugin(
    e: BootstrapGitRunEntry,
    files: Map<string, Uint8Array>,
  ): { name: string; version: string; extension: boolean } {
    if (!files.has(PLUGIN_MANIFEST_FILE)) {
      return { name: e.name, version: e.version, extension: false };
    }
    try {
      const { manifest } = readPluginFiles(files, {
        hostSdkVersion: SDK_VERSION,
        requirePackageJson: false,
      });
      return {
        name: manifest.name,
        version: manifest.version,
        extension: manifest.extension !== undefined,
      };
    } catch (err) {
      throw err instanceof PluginPackageError ? catalogPackageError(err) : err;
    }
  }

  /** Stages a git entry from its files as an admin git import would (translation included). */
  private async prepareGitEntry(
    e: MergedBootstrapEntry,
    git: GitEntryImport,
    source: PluginImportSource,
    imports: BootstrapImports,
  ): Promise<Awaited<ReturnType<BootstrapImports["prepare"]>>> {
    const staged = await imports.prepareGit(null, git.files, source, {
      fallback: {
        name: e.name,
        version: e.version,
        publisher: git.publisher,
        entryVersion: e.version,
      },
    });
    const { name, version, pluginVersion } = staged.review;
    if (name !== e.name || (pluginVersion ?? version) !== e.version) {
      throw new ApiError(
        "catalog.invalid_manifest",
        `The tree of bootstrap entry ${e.name} ${e.version} is plugin ${name} ${pluginVersion ?? version}`,
      );
    }
    return staged;
  }

  /** A declarative plugin: catalog only. Returns false when that version is already imported. */
  private async importOnly(
    e: MergedBootstrapEntry,
    bytes: Uint8Array,
    source: PluginImportSource,
    imports: BootstrapImports,
    git: GitEntryImport | undefined,
  ): Promise<boolean> {
    try {
      const { stagingId, review } =
        git !== undefined
          ? await this.prepareGitEntry(e, git, source, imports)
          : await imports.prepare(null, bytes, source);
      await imports.confirm(null, stagingId, {
        reviewHash: review.reviewHash,
        scope: e.scope ?? "optional",
      });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "catalog.version_exists") return false;
      throw err;
    }
  }

  /**
   * Imports, approves, installs and enables (one review; its confirm deploys the extension). When
   * the catalog already has this version (an earlier run stopped after importing, or the same
   * package came from a marketplace), the extension is deployed from the package store instead.
   */
  private async deploy(
    e: MergedBootstrapEntry,
    bytes: Uint8Array,
    source: PluginImportSource,
    enable: boolean,
    imports: BootstrapImports,
    git: GitEntryImport | undefined,
  ): Promise<SingleProviderNote | undefined> {
    let staged: Awaited<ReturnType<BootstrapImports["prepare"]>>;
    try {
      // A git plugin with an extension is packed again from these files: the verified bytes
      staged =
        git !== undefined
          ? await this.prepareGitEntry(e, git, source, imports)
          : await imports.prepare(null, bytes, source);
    } catch (err) {
      if (err instanceof ApiError && err.code === "catalog.version_exists") {
        return this.deployFromStore(e, bytes, source.ref, enable);
      }
      throw err;
    }
    const r = await imports.confirm(null, staged.stagingId, {
      reviewHash: staged.review.reviewHash,
      enable,
      scope: e.scope ?? "optional",
    });
    if (r.deploy?.result === "failed") {
      throw new ApiError(
        (r.deploy.code ?? "internal") as ErrorCode,
        r.deploy.message ?? `installing extension ${e.name} failed`,
      );
    }
    if (r.deploy?.singleProvider !== undefined) {
      return this.leftDisabled(e, {
        code: r.deploy.code as string,
        message: r.deploy.message as string,
        singleProvider: r.deploy.singleProvider,
      });
    }
    return undefined;
  }

  /** The extension of a catalog version already imported: ingest, approve, install (, enable). */
  private async deployFromStore(
    e: MergedBootstrapEntry,
    bytes: Uint8Array,
    ref: string,
    enable: boolean,
  ): Promise<SingleProviderNote | undefined> {
    const review = await this.installs.ingest(
      null,
      bytes,
      { source: "bootstrap", ref },
      { store: "pg" },
    );
    let set: PermissionSet;
    try {
      set = permissionSetOfPackage(
        await readExtensionPackage(bytes, {
          maxBytes: this.config().packages.maxBytes,
          hostSdkVersion: SDK_VERSION,
        }),
      );
    } catch (err) {
      throw err instanceof ExtensionPackageError ? catalogPackageError(err) : err;
    }
    await this.approveStored(e, set, review.sha256);
    const item = await this.db
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", e.name)
      .where("owner_org_id", "is", null)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const installed = await this.ops.install(
      e.name,
      review.sha256,
      null,
      undefined,
      item ? { catalogItemId: item.id } : {},
    );
    // An upgrade newly providing a held single-provider point is left disabled by the install
    if (installed.leftDisabled !== undefined) return this.leftDisabled(e, installed.leftDisabled);
    return enable ? this.enableOrWarn(e) : undefined;
  }

  /**
   * Enables a bootstrap extension unless another enabled extension provides one of its
   * single-provider extension points (see {@link leftDisabled}).
   */
  private async enableOrWarn(e: MergedBootstrapEntry): Promise<SingleProviderNote | undefined> {
    const r = await this.ops.enableUnlessOccupied(e.name, null);
    return r.enabled ? undefined : this.leftDisabled(e, r.note);
  }

  /**
   * A bootstrap extension left disabled because another enabled extension holds a single-provider
   * extension point it provides. An optional preinstall (a sandbox while the super admin runs
   * another one) stays disabled with a warning, and the entry's result says so. A required entry
   * fails (thrown, so the run is not recorded done, `capybara bootstrap` exits 1 and
   * `capybara start` refuses to serve): the deployment cannot run without it, and only the super
   * admin can free the point, by disabling the other provider and running the bootstrap again.
   */
  private leftDisabled(e: MergedBootstrapEntry, note: SingleProviderNote): SingleProviderNote {
    const block = note.singleProvider;
    if (e.required) {
      const other = block.enabled.name;
      throw new ApiError(
        note.code as ErrorCode,
        `Required plugin ${e.name} provides ${block.extensionPoint}, which ${other} already provides; disable ${other} and run the bootstrap again`,
        [block],
      );
    }
    this.log.warn(`bootstrap: the plugin is installed disabled; ${note.message}`, {
      plugin: e.name,
      required: e.required,
    });
    return note;
  }

  /** The permission snapshot of a stored package (source `bootstrap`), under the approve lock. */
  @Transactional()
  private async approveStored(
    e: MergedBootstrapEntry,
    set: PermissionSet,
    sha256: string,
  ): Promise<void> {
    await this.approveLock.lock(e.name);
    const snap = await this.db
      .selectFrom("extension_permission_snapshots")
      .select("permissions")
      .where("plugin", "=", e.name)
      .forUpdate()
      .executeTakeFirst();
    const { added, removed } = diffPermissions(snap?.permissions as PermissionSet | undefined, set);
    await writeSnapshot(this.db, e.name, e.version, set, {
      source: "bootstrap",
      audit: { added, removed, sha256 },
    });
  }

  /** Install records still `required` whose entry left the manifest lose `required`. */
  private async clearRemoved(manifest: MergedBootstrapManifest): Promise<BootstrapEntryResult[]> {
    const names = manifest.plugins.map((p) => p.name);
    let q = this.db
      .updateTable("extension_installs")
      .set({ required: false })
      .where("required", "=", true);
    if (names.length > 0) q = q.where("name", "not in", names);
    const rows = await q.returning(["name", "version"]).execute();
    for (const r of rows) await this.markBuiltin(r.name, false);
    // A declarative plugin has no install record: clear builtin by catalog name
    let items = this.db
      .updateTable("catalog_items")
      .set({ builtin: false, updated_at: sql<Date>`now()` as unknown as Date })
      .where("builtin", "=", true)
      .where("owner_org_id", "is", null)
      .where("deleted_at", "is", null);
    if (names.length > 0) items = items.where("name", "not in", names);
    await items.execute();
    return rows.map((r) => ({ name: r.name, action: "required_cleared", version: r.version }));
  }
}

/** A `kept` result whose entry an earlier pass of the same start installed / upgraded / imported. */
function carried(
  r: BootstrapEntryResult,
  carry: readonly BootstrapEntryResult[] | undefined,
): BootstrapEntryResult {
  if (r.action !== "kept") return r;
  const before = carry?.find((c) => c.name === r.name && c.version === r.version);
  return before !== undefined && before.action !== "kept" && before.action !== "required_cleared"
    ? before
    : r;
}

/** `installed` is below `pinned` (a version that is not semver is never upgraded). */
const isLower = (installed: string, pinned: string): boolean =>
  semver.valid(installed) !== null && semver.valid(pinned) !== null && semver.lt(installed, pinned);
