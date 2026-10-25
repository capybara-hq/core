import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BootstrapEntry,
  type BootstrapManifest,
  bootstrapFileName,
  type Logger,
  parseBootstrapManifest,
  SDK_VERSION,
} from "@capybara-hq/plugin-sdk";
import { sql } from "kysely";
import pg from "pg";
import semver from "semver";
import { catalogPackageError, type PluginImport } from "../catalog/plugin-import.js";
import { PluginPackageError, readPluginPackage } from "../catalog/plugin-package.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelDb } from "../db/kernel-schema.js";
import { pgConnectOptions } from "../db/pool.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { audit } from "../identity/audit.js";
import type { ExtensionAdminOps } from "./admin-ops.js";
import { writeSnapshot } from "./approvals.js";
import type { ExtensionInstalls } from "./installs.js";
import { ExtensionPackageError, permissionSetOfPackage, readExtensionPackage } from "./package.js";
import { diffPermissions, type PermissionSet } from "./permission-set.js";
import type { ExtensionSource } from "./sources.js";

/**
 * The bootstrap step (package ecosystem spec §7): installs the plugins pinned by the bootstrap
 * manifest (`packages/kernel/bootstrap.json`) from the tgz files baked into the image. It replaced
 * the builtin extensions.
 *
 * - Every file (`<dir>/<name>-<version>.tgz`) is checked against the entry's sha512 before anything
 *   is read or written; a missing file is `bootstrap.missing_file`, a mismatch
 *   `bootstrap.integrity_mismatch` (both name the plugin), and then nothing is written. It never
 *   touches the network.
 * - The whole run holds the session advisory lock `capybara.bootstrap` on a connection of its own
 *   (taken with `pg_try_advisory_lock` in a backoff loop that observes the signal, and closed
 *   afterwards, so the lock never outlives the run): when several replicas start together only one
 *   runs it; the others wait, then find it done. "Done" is a `bootstrap_runs` row for the
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
 * the object store (object-store-s3 is itself a bootstrap plugin); a declarative plugin's catalog
 * files do.
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

/** The advisory lock around a whole run. */
const LOCK_KEY = "capybara.bootstrap";

export interface BootstrapServiceDeps {
  db: KernelDb;
  /** The lock connection is opened separately (and closed after every run). */
  dbUrl: string;
  connectTimeoutMs?: number;
  config: () => KernelConfig;
  imports: Pick<PluginImport, "prepare" | "confirm">;
  installs: Pick<ExtensionInstalls, "ingest">;
  ops: Pick<ExtensionAdminOps, "install" | "enable">;
  /**
   * Config-declared extension names (an entry of the same name is kept, config wins, and no
   * install record is created). The kernel resolves them from `extensions` before loading.
   */
  declared?: () => ReadonlySet<string> | ReadonlyMap<string, ExtensionSource>;
  log: Pick<Logger, "info" | "warn" | "error">;
}

export class BootstrapService {
  constructor(private readonly d: BootstrapServiceDeps) {}

  /** Whether the bootstrap step completed for the manifest with this sha256. */
  async isDone(manifestSha256: string): Promise<boolean> {
    const row = await this.d.db
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
    dir: string;
    signal?: AbortSignal;
    carry?: readonly BootstrapEntryResult[];
  }): Promise<BootstrapResult> {
    const manifestSha256 = bootstrapManifestSha256(o.manifest);
    const files = await this.verifyFiles(o.manifest, o.dir);
    return this.locked(o.signal, async () => {
      const done = await this.d.db
        .selectFrom("bootstrap_runs")
        .select("results")
        .where("manifest_sha256", "=", manifestSha256)
        .executeTakeFirst();
      if (done) {
        return { manifestSha256, results: done.results as BootstrapEntryResult[] };
      }
      const handled = await this.lastRunNames();
      const results: BootstrapEntryResult[] = [];
      const failures: BootstrapFailure[] = [];
      for (const e of o.manifest.plugins) {
        o.signal?.throwIfAborted();
        try {
          const r = await this.entry(e, files.get(e.name) as Uint8Array, handled);
          results.push(carried(r, o.carry));
        } catch (err) {
          this.d.log.error("bootstrap: a plugin could not be installed", {
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
      await this.d.db.transaction().execute(async (trx) => {
        await trx
          .insertInto("bootstrap_runs")
          .values({
            manifest_sha256: manifestSha256,
            completed_at: sql<Date>`now()` as unknown as Date,
            results: JSON.stringify(results),
          })
          .execute();
        await audit(trx, {
          action: "bootstrap.completed",
          target: manifestSha256,
          detail: { manifestSha256, results },
        });
      });
      this.d.log.info("bootstrap completed", { manifestSha256, results });
      return { manifestSha256, results };
    });
  }

  /**
   * Runs `fn` holding the session advisory lock on a connection of its own: `pg_try_advisory_lock`
   * retried with a backoff (100 ms doubling to 1 s) that stops when `signal` aborts. The connection
   * is closed afterwards in every case, which releases the lock even when the unlock failed.
   */
  private async locked<T>(signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
    const client = new pg.Client({
      connectionString: this.d.dbUrl,
      ...pgConnectOptions({ connectTimeoutMs: this.d.connectTimeoutMs }),
    });
    client.on("error", () => {});
    await client.connect();
    try {
      for (let wait = 100; ; wait = Math.min(wait * 2, 1_000)) {
        signal?.throwIfAborted();
        const r = await client.query<{ ok: boolean }>(
          "SELECT pg_try_advisory_lock(hashtext($1)) AS ok",
          [LOCK_KEY],
        );
        if (r.rows[0]?.ok === true) break;
        await sleep(wait, signal);
      }
      try {
        return await fn();
      } finally {
        await client
          .query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY])
          .catch((err: unknown) =>
            this.d.log.warn("bootstrap: cannot release the advisory lock; closing its connection", {
              err,
            }),
          );
      }
    } finally {
      await client.end().catch(() => {});
    }
  }

  /** The entry names the last completed run handled (undefined before any run completed). */
  private async lastRunNames(): Promise<Set<string> | undefined> {
    const row = await this.d.db
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

  /** Reads every entry's file and checks its sha512 (before the lock: nothing is written yet). */
  private async verifyFiles(
    manifest: BootstrapManifest,
    dir: string,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    for (const e of manifest.plugins) {
      const file = join(dir, bootstrapFileName(e));
      let bytes: Uint8Array;
      try {
        bytes = new Uint8Array(await readFile(file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        throw new ApiError(
          "bootstrap.missing_file",
          `Bootstrap plugin ${e.name} ${e.version}: ${file} is missing; the image must carry every package bootstrap.json pins`,
        );
      }
      const actual = integrityOf(bytes);
      if (actual !== e.integrity) {
        throw new ApiError(
          "bootstrap.integrity_mismatch",
          `Bootstrap plugin ${e.name} ${e.version}: ${file} does not match its pinned sha512 (expected ${e.integrity.slice(0, 19)}…, got ${actual.slice(0, 19)}…); refusing to install anything`,
        );
      }
      out.set(e.name, bytes);
    }
    return out;
  }

  private async entry(
    e: BootstrapEntry,
    bytes: Uint8Array,
    handled: ReadonlySet<string> | undefined,
  ): Promise<BootstrapEntryResult> {
    const pkg = await readPluginPackage(bytes, {
      maxBytes: this.d.config().packages.maxBytes,
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
      const imported = await this.importOnly(e, bytes, ref);
      return { name: e.name, action: imported ? "imported" : "kept", version: e.version };
    }
    if (this.d.declared?.().has(e.name)) {
      this.d.log.warn(
        "bootstrap: the plugin is declared in the extensions config list; the config plugin is used",
        { plugin: e.name },
      );
      return { name: e.name, action: "kept", version: e.version };
    }
    const row = await this.d.db
      .selectFrom("extension_installs")
      .select(["version", "source", "required", "desired_state"])
      .where("name", "=", e.name)
      .executeTakeFirst();
    if (!row && !isNew && !e.required) {
      this.d.log.info("bootstrap: an optional plugin that is not installed stays uninstalled", {
        plugin: e.name,
      });
      return { name: e.name, action: "kept", version: e.version };
    }
    let result: BootstrapEntryResult;
    if (!row) {
      await this.deploy(e, bytes, ref, true);
      result = { name: e.name, action: "installed", version: e.version };
    } else if (row.source === "bootstrap" && isLower(row.version, e.version)) {
      // The desired state the admin chose is kept; a required plugin is enabled below anyway
      await this.deploy(e, bytes, ref, row.desired_state === "enabled");
      result = { name: e.name, action: "upgraded", version: e.version };
    } else {
      result = { name: e.name, action: "kept", version: row.version };
    }
    if (row?.required !== e.required) {
      await this.d.db
        .updateTable("extension_installs")
        .set({ required: e.required })
        .where("name", "=", e.name)
        .execute();
    }
    // A required install must run on the deployment (an org cannot use it otherwise)
    if (e.required && row?.desired_state === "disabled") {
      await this.d.ops.enable(e.name, null);
    }
    return result;
  }

  /** A declarative plugin: catalog only. Returns false when that version is already imported. */
  private async importOnly(e: BootstrapEntry, bytes: Uint8Array, ref: string): Promise<boolean> {
    try {
      const { stagingId, review } = await this.d.imports.prepare(null, bytes, {
        kind: "bootstrap",
        ref,
        integrity: e.integrity,
      });
      await this.d.imports.confirm(null, stagingId, {
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
  ): Promise<void> {
    let staged: Awaited<ReturnType<BootstrapServiceDeps["imports"]["prepare"]>>;
    try {
      staged = await this.d.imports.prepare(null, bytes, {
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
    const r = await this.d.imports.confirm(null, staged.stagingId, {
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
    const review = await this.d.installs.ingest(
      null,
      bytes,
      { source: "bootstrap", ref },
      { store: "pg" },
    );
    let set: PermissionSet;
    try {
      set = permissionSetOfPackage(
        await readExtensionPackage(bytes, {
          maxBytes: this.d.config().packages.maxBytes,
          hostSdkVersion: SDK_VERSION,
        }),
      );
    } catch (err) {
      throw err instanceof ExtensionPackageError ? catalogPackageError(err) : err;
    }
    await this.d.db.transaction().execute(async (trx) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`capybara.plugin-approve:${e.name}`}))`.execute(
        trx,
      );
      const snap = await trx
        .selectFrom("extension_permission_snapshots")
        .select("permissions")
        .where("plugin", "=", e.name)
        .forUpdate()
        .executeTakeFirst();
      const { added, removed } = diffPermissions(
        snap?.permissions as PermissionSet | undefined,
        set,
      );
      await writeSnapshot(trx, e.name, e.version, set, {
        source: "bootstrap",
        audit: { added, removed, sha256: review.sha256 },
      });
    });
    const item = await this.d.db
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", e.name)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    await this.d.ops.install(
      e.name,
      review.sha256,
      null,
      undefined,
      item ? { catalogItemId: item.id } : {},
    );
    if (enable) await this.d.ops.enable(e.name, null);
  }

  /** Install records still `required` whose entry left the manifest lose `required`. */
  private async clearRemoved(manifest: BootstrapManifest): Promise<BootstrapEntryResult[]> {
    const names = manifest.plugins.map((p) => p.name);
    let q = this.d.db
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

/** Resolves after `ms`; rejects with the abort reason when `signal` aborts first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `installed` is below `pinned` (a version that is not semver is never upgraded). */
const isLower = (installed: string, pinned: string): boolean =>
  semver.valid(installed) !== null && semver.valid(pinned) !== null && semver.lt(installed, pinned);
