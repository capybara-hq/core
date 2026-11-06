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
import { OWNED_PLUGIN_CLEANUP_SWEEP_JOB } from "./job-ids.js";
import { releaseExtensionClaim } from "./ownership.js";

/** Codes that mean another run (or the confirmation's own take-out) got there first. */
const GONE = new Set(["extension.not_found", "extension.not_disabled"]);

/**
 * The cleanup of a removed org-owned plugin: {@link run} disables and uninstalls its extension (an
 * install of the item's name from the item's package) when no live catalog item of that package
 * references it any more, then releases the extension name claim (pre-flight F10: the claim of an
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
    const pkg = item.package_name;
    if (pkg === null || (await this.referenced(this.db, pkg))) return;
    const install = await this.db
      .selectFrom("extension_installs as x")
      .innerJoin("extension_packages as p", "p.sha256", "x.sha256")
      .select(["x.desired_state", "p.package_name"])
      .where("x.name", "=", item.name)
      .executeTakeFirst();
    if (install !== undefined && install.package_name === pkg) {
      try {
        if (install.desired_state !== "disabled") await this.ops.disable(item.name, null);
        await this.ops.uninstall(item.name, null);
        this.log.info("extension of a removed org plugin uninstalled", {
          itemId,
          name: item.name,
        });
      } catch (e) {
        if (!(e instanceof ApiError && GONE.has(e.code))) throw e;
      }
    }
    await this.release(item.name, pkg);
  }

  /** Daily: {@link run} for every removed org-owned item whose extension is still installed. */
  @LockedCron("40 3 * * *", { name: OWNED_PLUGIN_CLEANUP_SWEEP_JOB })
  async sweep(): Promise<void> {
    const rows = await this.db
      .selectFrom("catalog_items as ci")
      .innerJoin("extension_installs as x", "x.name", "ci.name")
      .innerJoin("extension_packages as p", (j) =>
        j.onRef("p.sha256", "=", "x.sha256").onRef("p.package_name", "=", "ci.package_name"),
      )
      .select("ci.id")
      .where("ci.deleted_at", "is not", null)
      .where("ci.owner_org_id", "is not", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("catalog_items as live")
              .select("live.id")
              .whereRef("live.package_name", "=", "ci.package_name")
              .where("live.deleted_at", "is", null),
          ),
        ),
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

  /** A live catalog item of the package still references its extension. */
  private async referenced(db: KernelSchemaDb, packageName: string): Promise<boolean> {
    const live = await db
      .selectFrom("catalog_items")
      .select("id")
      .where("package_name", "=", packageName)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    return live !== undefined;
  }

  /** Releases the name claim when still unreferenced and nothing is installed under it. */
  @Transactional()
  private async release(name: string, packageName: string): Promise<void> {
    if (await this.referenced(this.db, packageName)) return;
    await releaseExtensionClaim(this.db, name, packageName);
  }
}

/**
 * {@link OwnedPluginCleanup}: imported only by `MaintenanceModule` (the job's dispatcher), which
 * only the worker role imports, so the sweep runs on worker replicas only.
 */
@Module({
  imports: [ExtensionsModule],
  providers: [OwnedPluginCleanup],
  exports: [OwnedPluginCleanup],
})
export class OwnedPluginCleanupModule {}
