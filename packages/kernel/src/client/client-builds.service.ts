import type { PluginClientSection } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { StorageService } from "../storage/storage.service.js";
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
 * one): a failed transaction leaves unreferenced objects that the next store of the same package
 * rewrites; a row never exists without its files. The row references `extension_packages` (ON
 * DELETE CASCADE); whoever deletes the package row deletes {@link ClientBuildRow.objectPrefix} in
 * `afterCommit` ({@link deleteFiles}).
 */
@Injectable()
export class ClientBuilds {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
    @Inject(StorageService) private readonly storage: StorageService,
  ) {}

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

  /** Deletes a build's objects (call in `afterCommit`, once its package row is gone). */
  async deleteFiles(objectPrefix: string): Promise<void> {
    await this.storage.deployment().deletePrefix(objectPrefix);
  }
}
