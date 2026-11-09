import type { PluginClientSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { type PrefixedStorage, StorageService } from "../storage/storage.service.js";
import {
  checkClientFiles,
  clientBuildPrefix,
  clientContentType,
  clientRelPath,
} from "./client-files.js";

/** A stored client build (`extension_client_builds`); paths are manifest keys. */
export interface ClientBuildRow {
  /** The package sha256: the build id. */
  packageSha256: string;
  plugin: string;
  entry: string | null;
  styles: string[];
  assets: string[];
  /** Manifest key -> `sha384-<base64>`, recomputed from the bytes when stored. */
  integrity: Record<string, string>;
  /** Manifest key -> bytes. */
  sizes: Record<string, number>;
  apiVersion: number;
  /** Relative to `deployment/`: `platform/client/<plugin>/<sha256>/`. */
  objectPrefix: string;
}

/**
 * The client builds of extension packages (client extensions spec §9.1): when a package with an
 * `extension.client` section is stored, its client files are checked (`client-files.ts`) and
 * written to object storage under `deployment/platform/client/<plugin>/<sha256>/<path inside
 * dist/client/>`, and one `extension_client_builds` row records the keys, sizes and integrity.
 * Content-addressed by the package sha256, so storing the same package again is harmless.
 *
 * The objects are written before the row's transaction (object storage is never called inside
 * one). A transaction that rolls back after the objects were written leaves them unreferenced
 * under the prefix: nothing sweeps them, and the next store of the same package rewrites them
 * (content-addressed, so they are never wrong, only orphaned). The row references
 * `extension_packages` (ON DELETE CASCADE); whoever deletes the package row calls
 * {@link deleteFiles} in `afterCommit`.
 *
 * Storing a package's build and deleting its files run under one lock per package sha256
 * ({@link locked}, `LockService`, never inside a transaction), and the delete first re-checks that
 * no package row exists: a concurrent store of the same bytes either sees the row gone and writes
 * everything again, or has recorded the row and the delete leaves its files alone, so a build row
 * never stays without its files.
 */
@Injectable()
export class ClientBuilds {
  /** Where client files go: the kernel's object storage, or the CLI's own ({@link useCliStorage}). */
  private storage: PrefixedStorage;

  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) storage: StorageService,
    @Inject(LockService) private readonly locks: LockService,
  ) {
    this.storage = storage;
  }

  /**
   * CLI only (like `PluginImport.useCliStorage`): client files go to the object store the CLI set
   * up itself (`loadCliObjectStore`); without one, a package with client code is refused with its
   * `storage.unavailable`. Called once, right after the command's context is created.
   */
  useCliStorage(storage: PrefixedStorage): void {
    this.storage = storage;
  }

  /** `storage.unavailable` (503) when client files cannot be stored here. */
  assertAvailable(): void {
    this.storage.assertAvailable();
  }

  /**
   * Runs `fn` under the lock of package `sha256`'s client build (see the class header): the store
   * of a package with client code and the delete of its files. Never inside a transaction.
   */
  async locked<T>(sha256: string, fn: () => Promise<T>): Promise<T> {
    return this.locks.run(`client-build:${sha256}`, { ttlMs: 60_000, waitMs: 60_000 }, fn);
  }

  /**
   * Checks the client files of package `sha256` (`files` keyed by their path in the package, see
   * `checkClientFiles`) and writes them to object storage; returns the row to insert. No
   * transaction may be open. `storage.unavailable` without an object store; `client.invalid` /
   * `client.integrity_mismatch` for files that do not match the section.
   */
  async writeFiles(
    sha256: string,
    plugin: string,
    files: ReadonlyMap<string, Uint8Array>,
    section: PluginClientSection,
  ): Promise<ClientBuildRow> {
    this.storage.assertAvailable();
    const checked = checkClientFiles(section, files);
    const objectPrefix = clientBuildPrefix(plugin, sha256);
    const store = this.storage.deployment();
    for (const f of checked.files) {
      await store.put(objectPrefix + clientRelPath(f.key), f.data, {
        contentType: clientContentType(f.key),
        size: f.size,
      });
    }
    return {
      packageSha256: sha256,
      plugin,
      entry: section.entry ?? null,
      styles: section.styles ?? [],
      assets: section.assets ?? [],
      integrity: Object.fromEntries(checked.files.map((f) => [f.key, f.integrity])),
      sizes: Object.fromEntries(checked.files.map((f) => [f.key, f.size])),
      apiVersion: section.apiVersion,
      objectPrefix,
    };
  }

  /**
   * Inserts the build row (joins the caller's transaction, which also inserts the package row);
   * does nothing when the row exists.
   */
  @Transactional()
  async insert(row: ClientBuildRow): Promise<void> {
    await this.db
      .insertInto("extension_client_builds")
      .values({
        package_sha256: row.packageSha256,
        plugin: row.plugin,
        entry: row.entry,
        styles: row.styles,
        assets: row.assets,
        integrity: JSON.stringify(row.integrity),
        sizes: JSON.stringify(row.sizes),
        api_version: row.apiVersion,
        object_prefix: row.objectPrefix,
      })
      .onConflict((oc) => oc.column("package_sha256").doNothing())
      .execute();
  }

  /**
   * {@link writeFiles} then {@link insert}, for a package whose `extension_packages` row exists
   * (storing it again restores missing objects and a missing row). Idempotent by sha256.
   */
  async extract(
    sha256: string,
    plugin: string,
    files: ReadonlyMap<string, Uint8Array>,
    section: PluginClientSection,
  ): Promise<void> {
    await this.insert(await this.writeFiles(sha256, plugin, files, section));
  }

  /** The client build of package `sha256`, or null when it has none. */
  async byPackage(sha256: string): Promise<ClientBuildRow | null> {
    const r = await this.db
      .selectFrom("extension_client_builds")
      .selectAll()
      .where("package_sha256", "=", sha256)
      .executeTakeFirst();
    if (!r) return null;
    return {
      packageSha256: r.package_sha256,
      plugin: r.plugin,
      entry: r.entry,
      styles: r.styles,
      assets: r.assets,
      integrity: r.integrity,
      sizes: r.sizes,
      apiVersion: r.api_version,
      objectPrefix: r.object_prefix,
    };
  }

  /**
   * Deletes the objects of package `sha256`'s build (call in `afterCommit`, once its package row is
   * gone): under {@link locked}, and only while no package row exists (a concurrent store of the
   * same bytes keeps its files). Returns whether it deleted.
   */
  async deleteFiles(sha256: string, objectPrefix: string): Promise<boolean> {
    return this.locked(sha256, async () => {
      const again = await this.db
        .selectFrom("extension_packages")
        .select("sha256")
        .where("sha256", "=", sha256)
        .executeTakeFirst();
      if (again !== undefined) return false;
      await this.storage.deployment().deletePrefix(objectPrefix);
      return true;
    });
  }
}
