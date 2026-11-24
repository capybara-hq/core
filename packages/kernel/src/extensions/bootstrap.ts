import { createHash } from "node:crypto";
import { SDK_VERSION } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { sql } from "kysely";
import semver from "semver";
import { marketplaceGitSource, repoOwner } from "../catalog/catalog.service.js";
import { gitTreeOidOf } from "../catalog/git-source.js";
import { CONFIG_MARKETPLACE_PREFIX } from "../catalog/marketplaces.service.js";
import { otherNameOwner } from "../catalog/ownership.js";
import {
  catalogPackageError,
  type PluginImport,
  type PluginImportSource,
} from "../catalog/plugin-import.js";
import { PluginPackageError, readPluginPackage } from "../catalog/plugin-package.js";
import type { PlatformPluginUpdater } from "../catalog/plugin-upgrade.js";
import { oweScopeItem } from "../catalog/scope-jobs.js";
import type { KernelConfig } from "../config/schema.js";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError, type ErrorCode } from "../errors.js";
import { audit } from "../identity/audit.js";
import { KernelConfigService } from "../infra/config/kernel-config.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { PackageTgzError, unpackPackageTgz } from "../packages/tgz.js";
import { ExtensionAdminOps } from "./admin-ops.js";
import { writeSnapshot } from "./approvals.js";
import {
  BootstrapExtraMismatchError,
  type BootstrapGitRunEntry,
  bootstrapExtraSha256,
  type ExtraManifestTraces,
  hasExtraManifestTraces,
  type MergedBootstrapEntry,
  type MergedBootstrapManifest,
} from "./bootstrap-extra.js";
import { bootstrapManifestSha256 } from "./bootstrap-manifest.js";
import {
  bootstrapGitMarketplace,
  integrityOf,
  readBootstrapGitPlugin,
  resolveBootstrapPackages,
} from "./bootstrap-packages.js";
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
 *   succeeded; otherwise the next start runs it again, which is idempotent) while the latest
 *   completed run has the same extra-manifest part ({@link bootstrapExtraSha256}, ruling R18): an
 *   extra manifest removed and added back runs again; another built-in manifest with the same
 *   extra part (a replica of the previous release) does not.
 * - Before its first write a run records itself as started (`bootstrap_run_started`, with the
 *   names of its extra entries; ruling R19) and completing deletes the row, so the extra-manifest
 *   mismatch check ({@link BootstrapService.extraManifestTraces}) sees an extra manifest's entries
 *   from the first pass on, also while the run is not recorded done.
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

/** The managed marketplace's id of an extra-manifest marketplace (the row the kernel start creates). */
const managedMarketplaceId = (name: string) => `${CONFIG_MARKETPLACE_PREFIX}${name}`;

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

/**
 * What a run moves the platform to a raised pin with, with or without an extension (the
 * platform plugin update, acting as the kernel).
 */
export type BootstrapUpdater = Pick<PlatformPluginUpdater, "preview" | "update">;

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
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
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

  /**
   * Whether the bootstrap step is done for this manifest: a completed run of its sha256 while the
   * latest completed run has the same extra-manifest part (ruling R18).
   */
  async isDone(manifest: MergedBootstrapManifest): Promise<boolean> {
    return (await this.recorded(manifest)) !== undefined;
  }

  /** The recorded result of the manifest's run when it counts as done ({@link isDone}). */
  private async recorded(manifest: MergedBootstrapManifest): Promise<BootstrapResult | undefined> {
    const manifestSha256 = bootstrapManifestSha256(manifest);
    const row = await this.db
      .selectFrom("bootstrap_runs")
      .select("results")
      .where("manifest_sha256", "=", manifestSha256)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    const latest = await this.db
      .selectFrom("bootstrap_runs")
      .select(["manifest_sha256", "extra_sha256"])
      .orderBy("completed_at", "desc")
      .orderBy("manifest_sha256")
      .limit(1)
      .executeTakeFirstOrThrow();
    if (
      latest.manifest_sha256 !== manifestSha256 &&
      latest.extra_sha256 !== bootstrapExtraSha256(manifest)
    ) {
      return undefined;
    }
    return { manifestSha256, results: row.results as BootstrapEntryResult[] };
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
    // A run that started writing and has not completed is the latest state (R19)
    const started = await this.db
      .selectFrom("bootstrap_run_started")
      .select("extra_plugins")
      .executeTakeFirst();
    const plugins =
      started !== undefined
        ? [...(started.extra_plugins as string[])]
        : ((await this.lastRunResults()) ?? []).filter((r) => r.extra === true).map((r) => r.name);
    return { marketplaces: rows.map((r) => r.name), plugins: plugins.sort() };
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
    /** The platform update a raised pin goes through (after the extension step, if any). */
    updater: BootstrapUpdater;
  }): Promise<BootstrapResult> {
    const manifestSha256 = bootstrapManifestSha256(o.manifest);
    // Done: no lock, no directory, no network
    const before = await this.recorded(o.manifest);
    if (before) return before;
    return this.locked(o.signal, async (signal) => {
      // Another replica may have finished it while this one waited for the lock
      const done = await this.recorded(o.manifest);
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
      // Before the first write: a process without the extra manifest is refused from here on (R19)
      await this.recordStarted(manifestSha256, o.manifest.extra?.plugins ?? []);
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
          const r = await this.entry(e, files.get(e.name) as Uint8Array, handled, o, {
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
      await this.recordDone(manifestSha256, bootstrapExtraSha256(o.manifest), results);
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

  /** The run has started writing: the `bootstrap_run_started` row names its extra entries. */
  @Transactional()
  private async recordStarted(manifestSha256: string, extraPlugins: string[]): Promise<void> {
    const values = {
      manifest_sha256: manifestSha256,
      extra_plugins: JSON.stringify(extraPlugins),
      started_at: sql<Date>`now()` as unknown as Date,
    };
    await this.db
      .insertInto("bootstrap_run_started")
      .values(values)
      .onConflict((oc) => oc.column("singleton").doUpdateSet(values))
      .execute();
  }

  /**
   * The `bootstrap_runs` row (again with the current time and results when the manifest ran before:
   * it is then the latest completed run, R18), the `bootstrap.completed` audit and the end of the
   * started run, in one transaction.
   */
  @Transactional()
  private async recordDone(
    manifestSha256: string,
    extraSha256: string | null,
    results: BootstrapEntryResult[],
  ): Promise<void> {
    const values = {
      completed_at: sql<Date>`now()` as unknown as Date,
      results: JSON.stringify(results),
      extra_sha256: extraSha256,
    };
    await this.db
      .insertInto("bootstrap_runs")
      .values({ manifest_sha256: manifestSha256, ...values })
      .onConflict((oc) => oc.column("manifest_sha256").doUpdateSet(values))
      .execute();
    await this.db.deleteFrom("bootstrap_run_started").execute();
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
      .orderBy("manifest_sha256")
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
    { imports, updater }: { imports: BootstrapImports; updater: BootstrapUpdater },
    /** For a git entry: the manifest (its marketplaces) and the tree oid when read from git now. */
    at: { manifest: MergedBootstrapManifest; tree: string | undefined },
  ): Promise<BootstrapEntryResult> {
    let plugin: { name: string; version: string; extension: boolean };
    let source: PluginImportSource;
    let git: GitEntryImport | undefined;
    if (e.source === "git") {
      const m = bootstrapGitMarketplace(at.manifest, e, this.config());
      git = { files: await this.unpackGit(e, bytes), publisher: repoOwner(m.url) };
      plugin = this.gitPlugin(e, git);
      // The source an admin import of the managed marketplace's `path` entry records (same
      // arguments), so its later versions add to this item
      const where = marketplaceGitSource(
        {
          url: m.url,
          commit: e.commit,
          path: e.path,
          ...(m.ref !== undefined && { ref: m.ref }),
        },
        // From the offline directory git was not read: the verified pack holds exactly the tree's
        // files, so their oid is the tree's (a later commit elsewhere is then no content change)
        { commit: e.commit, tree: at.tree ?? gitTreeOidOf(git.files) },
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
      const live = await this.platformVersion(e.name);
      if (live !== undefined) {
        // As the extension path does: a version the bootstrap put there is raised to the pin; one
        // the super admin moved to (another source, or a higher version) stays
        if (!raisable(live, e.version)) {
          return { name: e.name, action: "kept", version: live.version };
        }
        if (live.disabled) {
          // The update refuses a disabled item: the version waits in the catalog, and the super
          // admin applies it once they enable the plugin
          await this.importOnly(e, bytes, source, imports, git);
          this.logDisabled(e, live.version);
          return { name: e.name, action: "kept", version: live.version };
        }
        await this.importOnly(e, bytes, source, imports, git, true);
        await this.applyPlatform(updater, live.itemId, e.version);
        return { name: e.name, action: "upgraded", version: e.version };
      }
      // A builtin entry a super admin removed is put back; an optional one stays out (Ruling 5)
      if (!isNew && !builtin) return { name: e.name, action: "kept", version: e.version };
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
    // The catalog version of the pin is imported now; the platform (its skills, templates, themes
    // and org installs) follows the extension the same way a declarative entry does (core#727)
    if (await this.raisePlatform(e, updater)) {
      result = { name: e.name, action: "upgraded", version: e.version };
    }
    return leftDisabled === undefined ? result : { ...result, leftDisabled };
  }

  /**
   * After the extension step: when the install record runs the pin from `bootstrap` and the
   * plugin's platform version came from `bootstrap` at a lower version (raised just now, or by a
   * run before core#727 that moved only the extension), the platform update moves the platform to
   * the pin, acting as the kernel. A version the super admin moved to stays; a disabled item gets
   * none (the update refuses it; the super admin applies the version once they enable it).
   * Returns whether the platform moved.
   */
  private async raisePlatform(
    e: MergedBootstrapEntry,
    updater: BootstrapUpdater,
  ): Promise<boolean> {
    const row = await this.db
      .selectFrom("extension_installs")
      .select(["version", "source"])
      .where("name", "=", e.name)
      .executeTakeFirst();
    if (row?.source !== "bootstrap" || row.version !== e.version) return false;
    const live = await this.platformVersion(e.name);
    if (live === undefined || !raisable(live, e.version)) return false;
    if (live.disabled) {
      this.logDisabled(e, live.version);
      return false;
    }
    await this.applyPlatform(updater, live.itemId, e.version);
    return true;
  }

  /**
   * The platform update to the pin, acting as the kernel (actor `null`). The update recomputes its
   * preview under the item's lock; a scope sync the extension step owed may run between the two
   * and change the orgs the preview covers (409 `plugin.upgrade_stale`): previewed again, a few
   * times.
   */
  private async applyPlatform(
    updater: BootstrapUpdater,
    itemId: string,
    version: string,
  ): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const preview = await updater.preview(itemId, version);
      try {
        await updater.update(null, itemId, { version, diffHash: preview.diffHash });
        return;
      } catch (err) {
        if (attempt >= 3 || !(err instanceof ApiError) || err.code !== "plugin.upgrade_stale") {
          throw err;
        }
      }
    }
  }

  private logDisabled(e: MergedBootstrapEntry, current: string): void {
    this.log.info(
      "bootstrap: the plugin is disabled on the deployment; the pinned version is imported, not applied",
      { plugin: e.name, version: e.version, current },
    );
  }

  /**
   * The live (not deleted) platform catalog item of this name: its platform version (the one orgs
   * install, else its latest) and where that version came from. undefined: no such item.
   */
  private async platformVersion(
    name: string,
  ): Promise<
    { itemId: string; version: string; source: string | null; disabled: boolean } | undefined
  > {
    const row = await this.db
      .selectFrom("catalog_items as i")
      .leftJoin("catalog_item_versions as v", (j) =>
        j
          .onRef("v.item_id", "=", "i.id")
          .on("v.version", "=", sql<string>`coalesce(i.platform_synced_version, i.latest_version)`),
      )
      .select([
        "i.id",
        sql<string>`coalesce(i.platform_synced_version, i.latest_version)`.as("version"),
        "v.source",
        "i.disabled",
      ])
      .where("i.name", "=", name)
      .where("i.owner_org_id", "is", null)
      .where("i.deleted_at", "is", null)
      .executeTakeFirst();
    return (
      row && {
        itemId: row.id,
        version: row.version,
        source: row.source ?? null,
        disabled: row.disabled,
      }
    );
  }

  /**
   * The catalog item of a bootstrap entry follows `required` / `builtin`: such an entry is builtin,
   * offered to every org (scope `all`, which an org admin cannot switch off) and not disabled
   * (migration 0075 could leave a required plugin disabled); an entry that stops being required or
   * builtin is no longer builtin and keeps scope `all` (the admin may change it from then on).
   * Only the platform item: an org-owned item of the same name (the entry then fails with
   * `plugin.name_taken`) is never touched.
   *
   * A demoted item owes its scope sync in the same transaction ({@link demoted}): its extension
   * was on in every org without an org row (always-on), and from now on the sync's org install
   * keeps it on where the scope wants it.
   */
  @Transactional()
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
    const rows = await this.db
      .updateTable("catalog_items")
      .set({ builtin: false, ...touch })
      .where("name", "=", name)
      .where("owner_org_id", "is", null)
      .where("deleted_at", "is", null)
      .where("builtin", "=", true)
      .returning("id")
      .execute();
    await this.demoted(rows.map((r) => r.id));
  }

  /**
   * Owes the scope sync of catalog items that just stopped being builtin, in the transaction in
   * context. A builtin item's extension was enabled in every org without an org row and the sync
   * left the item alone; without this sync the orgs its scope (`all`) wants it on in would lose it.
   */
  @Transactional({ propagation: "mandatory" })
  private async demoted(itemIds: string[]): Promise<void> {
    for (const id of itemIds) await oweScopeItem(this.outbox, this.db, id);
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
   * Name, version and extension of a git entry's tree ({@link readBootstrapGitPlugin}, which
   * `capybara-plugin bootstrap --write` pins with): its `plugin.json`, a Claude Code plugin's
   * manifest or the entry; its import's review is checked against the entry again
   * ({@link prepareGitEntry}).
   */
  private gitPlugin(
    e: BootstrapGitRunEntry,
    git: GitEntryImport,
  ): { name: string; version: string; extension: boolean } {
    try {
      return readBootstrapGitPlugin(git.files, e, {
        publisher: git.publisher,
        allowInsecureLoopback: this.config().marketplaces.allowInsecureLoopback,
      });
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

  /**
   * A declarative plugin: catalog only. Returns false when that version is already imported.
   * `updateFollows`: a platform update to this version follows (it owes the scope sync).
   */
  private async importOnly(
    e: MergedBootstrapEntry,
    bytes: Uint8Array,
    source: PluginImportSource,
    imports: BootstrapImports,
    git: GitEntryImport | undefined,
    updateFollows = false,
  ): Promise<boolean> {
    try {
      const { stagingId, review } =
        git !== undefined
          ? await this.prepareGitEntry(e, git, source, imports)
          : await imports.prepare(null, bytes, source);
      await imports.confirm(null, stagingId, {
        reviewHash: review.reviewHash,
        scope: e.scope ?? "optional",
        ...(updateFollows && { updateFollows: true }),
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

  /**
   * Install records still `required` whose entry left the manifest lose `required`; the catalog
   * items of entries that left lose `builtin` and owe their scope sync ({@link demoted}).
   */
  @Transactional()
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
    await this.demoted((await items.returning("id").execute()).map((r) => r.id));
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

/**
 * A platform version the bootstrap raises to the pin: one the bootstrap put there, below the pin
 * (one the super admin moved to, from another source or at a higher version, stays).
 */
const raisable = (live: { source: string | null; version: string }, pinned: string): boolean =>
  live.source === "bootstrap" && isLower(live.version, pinned);
