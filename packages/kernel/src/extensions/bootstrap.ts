import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapEntry,
  type BootstrapManifest,
  type Logger,
  parseBootstrapManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import semver from "semver";
import { catalogPackageError, type PluginImport } from "../catalog/plugin-import.js";
import { PluginPackageError, readPluginPackage } from "../catalog/plugin-package.js";
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
import { ExtensionAdminOps } from "./admin-ops.js";
import { writeSnapshot } from "./approvals.js";
import { ExtensionInstalls } from "./installs.js";
import { PluginApproveLock } from "./locks.js";
import { ExtensionPackageError, permissionSetOfPackage, readExtensionPackage } from "./package.js";
import { diffPermissions, type PermissionSet } from "./permission-set.js";
import { ExtensionRegistry } from "./registry.js";

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
 *   the pin only). A workspace entry without a matching file is `bootstrap.missing_file`, a failed
 *   download `bootstrap.download_failed`, a download that differs from the pin
 *   `bootstrap.integrity_mismatch` (all name the plugin), and then nothing is written. Downloading
 *   inside the lock means a fleet starting together downloads once.
 * - The whole run holds the Redis lock `lock:bootstrap` (`LockService`, ruling R5: TTL
 *   {@link BOOTSTRAP_LOCK_TTL_MS}, renewed every third of it, so a run longer than the TTL keeps
 *   it and a crashed holder's lock expires within it), taken by an unbounded wait that observes
 *   the signal: when several replicas (or `capybara bootstrap` and a starting kernel) run it
 *   together only one runs it; the others wait, then find it done. A lost lock (renewal failed
 *   until expiry) aborts the run at its next step. "Done" is a `bootstrap_runs` row for the
 *   manifest's sha256 (written with the audit `bootstrap.completed` only when every entry
 *   succeeded; otherwise the next start runs it again, which is idempotent).
 * - Only entries new to the manifest are installed (Ruling 5): an optional entry that the last
 *   completed run already handled and that is not installed now (an enterprise admin uninstalled
 *   it) stays uninstalled -> `kept`. A required entry is always installed.
 * - Per entry, by the installed state of its extension:
 *   - not installed (and new, or required): imported into the catalog (source `bootstrap`, ref
 *     `bootstrap:<name>@<version>`, like a marketplace import), installed, approved (snapshot
 *     source `bootstrap`, audited `extension.permissions_approved` with `source: "bootstrap"`)
 *     and enabled -> `installed`;
 *   - installed from `bootstrap` at a lower version: upgraded the same way (core's release vouched
 *     for the version, so new permissions are pre-approved and audited), keeping the desired state
 *     an enterprise admin chose (a disabled optional plugin stays disabled) -> `upgraded`;
 *   - installed at a higher version, or from another source (an enterprise admin upgraded it), or
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
 * never needed again; a declarative plugin's catalog files do need the object store.
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

/** Some entries failed (the others were done); the run is not recorded as done. */
export class BootstrapFailedError extends Error {
  /**
   * @param results what the entries that did not fail did (pass them as `carry` to a later run in
   * the same start, so its record keeps `installed` instead of `kept`).
   */
  constructor(
    readonly failures: BootstrapFailure[],
    readonly results: BootstrapEntryResult[] = [],
  ) {
    super(
      `bootstrap failed for ${failures.map((f) => `${f.name}${f.required ? " (required)" : ""}: ${f.message}`).join("; ")}`,
    );
    this.name = "BootstrapFailedError";
  }

  /** A required entry failed: the kernel must not serve without it. */
  get requiredFailed(): boolean {
    return this.failures.some((f) => f.required);
  }
}

/** sha256 (hex) of a manifest: of its JSON text as parsed (key order kept). */
export function bootstrapManifestSha256(manifest: BootstrapManifest): string {
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
  config: Pick<KernelConfig, "packages">;
  signal?: AbortSignal;
  log?: Pick<Logger, "warn">;
  /** The npm download (default {@link fetchNpmPackage}; tests replace it). */
  fetch?: typeof fetchNpmPackage;
}

/**
 * Obtains every entry's tgz, checked against its pinned sha512: from the offline directory when a
 * file there has that sha512, else (a `source: "npm"` entry) downloaded from the npm registry and
 * verified against the pin (the packument's `dist.integrity` is not consulted). Throws an
 * {@link ApiError} naming the plugin for the first entry it cannot obtain
 * (`bootstrap.missing_file`, `bootstrap.download_failed`, `bootstrap.integrity_mismatch`).
 */
export async function resolveBootstrapPackages(
  manifest: BootstrapManifest,
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
    const found = offline.get(e.integrity);
    if (found !== undefined) {
      out.set(e.name, found);
      continue;
    }
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
        { registry: npmRegistry, ...(npmToken !== undefined && { token: npmToken }), maxBytes },
        e.npm,
        e.version,
        signal,
        { expectedIntegrity: e.integrity },
      );
      out.set(e.name, r.bytes);
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
  return out;
}

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
/** Its lifetime without renewal (R5); a run keeps it by renewal, a crashed holder's expires. */
export const BOOTSTRAP_LOCK_TTL_MS = 120_000;
/** Optional provider: the lock's lifetime (ms) instead of {@link BOOTSTRAP_LOCK_TTL_MS} (tests shorten it). */
export const BOOTSTRAP_LOCK_TTL = Symbol("BOOTSTRAP_LOCK_TTL");
/** The pause between attempts while another holder runs the step. */
const LOCK_RETRY_MS = 500;

/** What a run imports a declarative entry or an entry's catalog version with. */
export type BootstrapImports = Pick<PluginImport, "prepare" | "confirm">;

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
   * Runs the bootstrap step (see the file header); when it is already done for this manifest
   * (also when another replica finished it while this one waited for the lock) returns the
   * recorded result without doing anything. `carry`: the results of an earlier, failed run in the
   * same start ({@link BootstrapFailedError.results}); an entry it installed, upgraded or imported
   * keeps that action instead of `kept` in this run's record.
   */
  async run(o: {
    manifest: BootstrapManifest;
    /** The offline directory (see {@link resolveBootstrapPackages}); omitted: npm only. */
    dir?: string;
    signal?: AbortSignal;
    carry?: readonly BootstrapEntryResult[];
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
      // Every package is obtained and checked before the first write
      const files = await resolveBootstrapPackages(o.manifest, {
        ...(o.dir !== undefined && { dir: o.dir }),
        config: this.config(),
        signal,
        log: this.log,
      });
      const handled = await this.lastRunNames();
      const results: BootstrapEntryResult[] = [];
      const failures: BootstrapFailure[] = [];
      for (const e of o.manifest.plugins) {
        signal.throwIfAborted();
        try {
          const r = await this.entry(e, files.get(e.name) as Uint8Array, handled, o.imports);
          results.push(carried(r, o.carry));
        } catch (err) {
          this.log.error("bootstrap: a plugin could not be installed", {
            plugin: e.name,
            version: e.version,
            required: e.required,
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
      if (failures.length > 0) throw new BootstrapFailedError(failures, results);
      signal.throwIfAborted();
      await this.recordDone(manifestSha256, results);
      this.log.info("bootstrap completed", { manifestSha256, results });
      return { manifestSha256, results };
    });
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
   * Runs `fn` holding `lock:bootstrap` (R5): waits without bound while another replica holds it
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

  /** The entry names the last completed run handled (undefined before any run completed). */
  private async lastRunNames(): Promise<Set<string> | undefined> {
    const row = await this.db
      .selectFrom("bootstrap_runs")
      .select("results")
      .orderBy("completed_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!row) return undefined;
    return new Set(
      (row.results as BootstrapEntryResult[])
        .filter((r) => r.action !== "required_cleared")
        .map((r) => r.name),
    );
  }

  private async entry(
    e: BootstrapEntry,
    bytes: Uint8Array,
    handled: ReadonlySet<string> | undefined,
    imports: BootstrapImports,
  ): Promise<BootstrapEntryResult> {
    const pkg = await readPluginPackage(bytes, {
      maxBytes: this.config().packages.maxBytes,
      hostSdkVersion: SDK_VERSION,
    }).catch((err: unknown) => {
      throw err instanceof PluginPackageError ? catalogPackageError(err) : err;
    });
    if (pkg.manifest.name !== e.name || pkg.manifest.version !== e.version) {
      throw new ApiError(
        "catalog.invalid_manifest",
        `The package for bootstrap entry ${e.name} ${e.version} contains plugin ${pkg.manifest.name} ${pkg.manifest.version}`,
      );
    }
    const ref = `bootstrap:${e.name}@${e.version}`;
    // Not new to the manifest: an optional entry left out on purpose stays out (Ruling 5)
    const isNew = handled === undefined || !handled.has(e.name);
    if (!pkg.manifest.extension) {
      if (!isNew) return { name: e.name, action: "kept", version: e.version };
      const imported = await this.importOnly(e, bytes, ref, imports);
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
    if (!row && !isNew && !e.required) {
      this.log.info("bootstrap: an optional plugin that is not installed stays uninstalled", {
        plugin: e.name,
      });
      return { name: e.name, action: "kept", version: e.version };
    }
    let result: BootstrapEntryResult;
    if (!row) {
      await this.deploy(e, bytes, ref, true, imports);
      result = { name: e.name, action: "installed", version: e.version };
    } else if (row.source === "bootstrap" && isLower(row.version, e.version)) {
      // The desired state the admin chose is kept; a required plugin is enabled below anyway
      await this.deploy(e, bytes, ref, row.desired_state === "enabled", imports);
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
      await this.ops.enable(e.name, null);
    }
    return result;
  }

  /** A declarative plugin: catalog only. Returns false when that version is already imported. */
  private async importOnly(
    e: BootstrapEntry,
    bytes: Uint8Array,
    ref: string,
    imports: BootstrapImports,
  ): Promise<boolean> {
    try {
      const { stagingId, review } = await imports.prepare(null, bytes, {
        kind: "bootstrap",
        ref,
        integrity: e.integrity,
      });
      await imports.confirm(null, stagingId, {
        reviewHash: review.reviewHash,
        deployExtension: false,
      });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === "catalog.version_exists") return false;
      throw err;
    }
  }

  /**
   * Imports, approves, installs and enables (one review, confirmed with `deployExtension`). When
   * the catalog already has this version (an earlier run stopped after importing, or the same
   * package came from a marketplace), the extension is deployed from the package store instead.
   */
  private async deploy(
    e: BootstrapEntry,
    bytes: Uint8Array,
    ref: string,
    enable: boolean,
    imports: BootstrapImports,
  ): Promise<void> {
    let staged: Awaited<ReturnType<BootstrapImports["prepare"]>>;
    try {
      staged = await imports.prepare(null, bytes, {
        kind: "bootstrap",
        ref,
        integrity: e.integrity,
      });
    } catch (err) {
      if (err instanceof ApiError && err.code === "catalog.version_exists") {
        await this.deployFromStore(e, bytes, ref, enable);
        return;
      }
      throw err;
    }
    const r = await imports.confirm(null, staged.stagingId, {
      reviewHash: staged.review.reviewHash,
      deployExtension: true,
      enable,
    });
    if (r.deploy?.result === "failed") {
      throw new ApiError(
        (r.deploy.code ?? "internal") as ErrorCode,
        r.deploy.message ?? `installing extension ${e.name} failed`,
      );
    }
  }

  /** The extension of a catalog version already imported: ingest, approve, install (, enable). */
  private async deployFromStore(
    e: BootstrapEntry,
    bytes: Uint8Array,
    ref: string,
    enable: boolean,
  ): Promise<void> {
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
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    await this.ops.install(
      e.name,
      review.sha256,
      null,
      undefined,
      item ? { catalogItemId: item.id } : {},
    );
    if (enable) await this.ops.enable(e.name, null);
  }

  /** The permission snapshot of a stored package (source `bootstrap`), under the approve lock. */
  @Transactional()
  private async approveStored(
    e: BootstrapEntry,
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
  private async clearRemoved(manifest: BootstrapManifest): Promise<BootstrapEntryResult[]> {
    const names = manifest.plugins.map((p) => p.name);
    let q = this.db
      .updateTable("extension_installs")
      .set({ required: false })
      .where("required", "=", true);
    if (names.length > 0) q = q.where("name", "not in", names);
    const rows = await q.returning(["name", "version"]).execute();
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
