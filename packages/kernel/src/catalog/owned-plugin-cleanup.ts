// Taking out the extension of a removed org-owned plugin (plugin scope phase 3, spec §14, P3-20,
// P3-21; pre-flight F9, F10): the one-off job `owned-plugin-cleanup-<itemId>` on
// `cap-kernel-maintenance` (dispatched by `MaintenanceProcessor`) and its daily sweep. Worker-only:
// `OwnedPluginCleanupModule` is imported only by `MaintenanceModule`, which only `WorkerModule`
// imports.
import { Inject, Injectable, Module } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionAdminOps } from "../extensions/admin-ops.js";
import { ExtensionsModule } from "../extensions/extensions.module.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { LockedCron } from "../infra/schedule/locked-cron.decorator.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { CatalogImportModule } from "./catalog.module.js";
import { OWNED_PLUGIN_CLEANUP_SWEEP_JOB } from "./job-ids.js";
import { CatalogItemLock } from "./locks.js";
import { releaseExtensionClaim } from "./ownership.js";

/** Codes that mean another run (or the confirmation's own take-out) got there first. */
const GONE = new Set(["extension.not_found", "extension.not_disabled"]);

/**
 * The cleanup of a removed org-owned plugin: {@link run} disables and uninstalls its extension (an
 * install of the item's name from the item's package) when no live catalog item uses it any more
 * ({@link OwnedPluginCleanup.referenced}), then releases the extension name claim, in one transaction under the import's item name lock
 * (pre-flight F10: the claim of an
 * installed extension is released here, never at the removal). Idempotent: a live item (a
 * transferred one), a platform item or nothing installed changes nothing but the claim. The
 * extension's data, secrets and configs stay, as with every uninstall. {@link sweep} runs it daily
 * for every removed org-owned item whose extension is still installed (a lost enqueue).
 */
@Injectable()
export class OwnedPluginCleanup {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(ExtensionAdminOps) private readonly ops: ExtensionAdminOps,
    /** The import's item name lock (M5: no uninstall racing a re-import of the package). */
    @Inject(CatalogItemLock) private readonly itemLock: CatalogItemLock,
    @Inject(LockService) readonly lockService: LockService,
    @Inject(KERNEL_LOGGER) readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** Takes out the extension of removed item `itemId` (see the class). */
  async run(itemId: string): Promise<void> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["name", "package_name", "deleted_at", "owner_org_id"])
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!item || item.deleted_at === null || item.owner_org_id === null) return;
    if (item.package_name === null) return;
    await this.takeOut(itemId, item.name, item.package_name, item.owner_org_id);
  }

  /**
   * {@link run}'s one transaction, under the catalog item name lock an import of that name takes
   * to write its item: a re-import of the package either committed first (a live item: nothing
   * is taken out) or waits until this commits, so a newly imported extension is never uninstalled.
   */
  @Transactional()
  private async takeOut(
    itemId: string,
    name: string,
    pkg: string,
    ownerOrgId: string,
  ): Promise<void> {
    await this.itemLock.lock(name);
    if (await this.referenced(this.db, name, pkg, ownerOrgId)) return;
    const install = await this.db
      .selectFrom("extension_installs as x")
      .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
      .select(["x.desired_state", "p.package_name"])
      .where("x.name", "=", name)
      .executeTakeFirst();
    if (install !== undefined && install.package_name === pkg) {
      try {
        if (install.desired_state !== "disabled") await this.ops.disable(name, null);
        await this.ops.uninstall(name, null);
        this.log.info("extension of a removed org plugin uninstalled", { itemId, name });
      } catch (e) {
        if (!(e instanceof ApiError && GONE.has(e.code))) throw e;
      }
    }
    await releaseExtensionClaim(this.db, name, pkg);
  }

  /**
   * Daily: {@link run} for every removed org-owned item no live item {@link referenced} names
   * whose extension is still installed, or whose name claim is still held (a lost enqueue, or a
   * run that uninstalled and failed before releasing the claim).
   */
  @LockedCron("40 3 * * *", { name: OWNED_PLUGIN_CLEANUP_SWEEP_JOB })
  async sweep(): Promise<void> {
    const rows = await this.db
      .selectFrom("catalog_items as ci")
      .select("ci.id")
      .where("ci.deleted_at", "is not", null)
      .where("ci.owner_org_id", "is not", null)
      .where("ci.package_name", "is not", null)
      .where(({ and, or, not, exists, selectFrom }) =>
        and([
          not(
            exists(
              selectFrom("catalog_items as live")
                .select("live.id")
                .whereRef("live.name", "=", "ci.name")
                .whereRef("live.package_name", "=", "ci.package_name")
                .where("live.deleted_at", "is", null)
                .where((eb) =>
                  eb.or([
                    eb("live.owner_org_id", "is", null),
                    eb("live.owner_org_id", "=", eb.ref("ci.owner_org_id")),
                  ]),
                ),
            ),
          ),
          or([
            exists(
              selectFrom("extension_installs as x")
                .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
                .select("x.name")
                .whereRef("x.name", "=", "ci.name")
                .whereRef("p.package_name", "=", "ci.package_name"),
            ),
            exists(
              selectFrom("extension_name_owners as o")
                .select("o.name")
                .whereRef("o.name", "=", "ci.name")
                .whereRef("o.package_name", "=", "ci.package_name"),
            ),
          ]),
        ]),
      )
      .execute();
    for (const r of rows) {
      try {
        await this.run(r.id);
      } catch (err) {
        this.log.error("owned plugin cleanup failed", { itemId: r.id, err });
      }
    }
  }

  /**
   * A live catalog item still uses the extension: one named like it (a plugin and its extension
   * share one name) from the same package whose owner is the removed item's owner (a re-upload)
   * or the platform (the super admin imported it over the install). Never any item of the package
   * name alone: another org choosing the same package name keeps nothing installed (ruling P3-51).
   */
  private async referenced(
    db: KernelSchemaDb,
    name: string,
    packageName: string,
    ownerOrgId: string,
  ): Promise<boolean> {
    const live = await db
      .selectFrom("catalog_items")
      .select("id")
      .where("name", "=", name)
      .where("package_name", "=", packageName)
      .where("deleted_at", "is", null)
      .where((eb) => eb.or([eb("owner_org_id", "is", null), eb("owner_org_id", "=", ownerOrgId)]))
      .executeTakeFirst();
    return live !== undefined;
  }
}

/**
 * {@link OwnedPluginCleanup}: imported only by `MaintenanceModule` (the job's dispatcher), which
 * only the worker role imports, so the sweep runs on worker replicas only.
 */
@Module({
  imports: [ExtensionsModule, CatalogImportModule],
  providers: [OwnedPluginCleanup],
  exports: [OwnedPluginCleanup],
})
export class OwnedPluginCleanupModule {}
