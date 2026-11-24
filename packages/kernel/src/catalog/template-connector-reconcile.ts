import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { BOOTSTRAP_LOCK_KEY, BOOTSTRAP_LOCK_TTL_MS } from "../extensions/bootstrap.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { OrgLock } from "../orgs/org-lock.js";
import { connectorTemplatesOn } from "./component-state.js";
import { PluginInstaller } from "./plugin-install.js";

/**
 * The `deployment_settings` key the reconciliation writes once it ran through: later starts skip
 * it, so a template connector an admin deletes afterwards is not made again.
 */
export const TEMPLATE_CONNECTOR_RECONCILE_SETTING = "templateConnectorsReconciled";

/** Pause between attempts while another replica holds `lock:bootstrap`. */
const LOCK_RETRY_MS = 500;

/** One connector template of an installed plugin with no live connector in the org. */
interface Missing {
  orgId: string;
  itemId: string;
  platformTemplateId: string;
  templateId: string;
}

/**
 * The one-off reconciliation of template connectors (plugin pages spec §7 "Plugins waiting
 * today"): installs made before phase 2 left connector templates that are on without a connector
 * (the install asked for input nobody gave). Since phase 2 every install creates them (§5.2.2), so
 * this pass creates each missing one once, under the same rule: no input, no outbound call,
 * `needs_config` when it needs an org credential or OAuth client, recorded on the install.
 *
 * Run once at startup, after the extensions loaded (a template's connector extension must be
 * deployed to plan its connector), holding the bootstrap step's Redis lock `lock:bootstrap`, so
 * only one replica runs it at a time; the next finds the pass done ({@link
 * TEMPLATE_CONNECTOR_RECONCILE_SETTING}) and does nothing. The lock is taken outside any
 * transaction; each connector is created in its own transaction under the org row lock, which
 * re-checks that the plugin is still installed, the template still on and still without a
 * connector (so a second run, or an install racing it, creates nothing more). A template that
 * cannot be planned (its connector extension missing or off in the org) is logged and skipped:
 * an org admin creates it from its card on the connectors page. A pass cut short (the shutdown, a
 * lost lock) is not marked done, and the next start resumes it.
 */
@Injectable()
export class TemplateConnectorReconciler {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(OrgLock) private readonly orgLock: OrgLock,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Runs the reconciliation unless it is done; returns the number of connectors it created (0
   * when it was done already). `signal` ends the wait for the lock and the pass (the shutdown).
   */
  async run(signal?: AbortSignal): Promise<{ created: number }> {
    if (await this.done()) return { created: 0 };
    const handle = await this.locks.acquire(BOOTSTRAP_LOCK_KEY, {
      ttlMs: BOOTSTRAP_LOCK_TTL_MS,
      waitMs: Number.POSITIVE_INFINITY,
      retryMs: LOCK_RETRY_MS,
      ...(signal !== undefined && { signal }),
    });
    // An unbounded wait returns a handle or throws the abort reason
    if (!handle) throw new Error("template connector reconciliation: the lock could not be taken");
    try {
      // another replica may have finished it while this one waited
      if (await this.done()) return { created: 0 };
      const stop = signal ? AbortSignal.any([signal, handle.lost]) : handle.lost;
      let created = 0;
      let skipped = 0;
      for (const m of await this.missing()) {
        stop.throwIfAborted();
        try {
          if (await this.createOne(m)) created += 1;
        } catch (e) {
          skipped += 1;
          this.log.warn("template connector reconciliation: connector not created", {
            orgId: m.orgId,
            itemId: m.itemId,
            templateId: m.templateId,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      stop.throwIfAborted();
      await this.markDone();
      this.log.info("template connector reconciliation done", { created, skipped });
      return { created };
    } finally {
      await handle.release();
    }
  }

  private async done(): Promise<boolean> {
    const row = await this.db
      .selectFrom("deployment_settings")
      .select("key")
      .where("key", "=", TEMPLATE_CONNECTOR_RECONCILE_SETTING)
      .executeTakeFirst();
    return row !== undefined;
  }

  private async markDone(): Promise<void> {
    const value = JSON.stringify({ at: new Date().toISOString() });
    await this.db
      .insertInto("deployment_settings")
      .values({ key: TEMPLATE_CONNECTOR_RECONCILE_SETTING, value })
      .onConflict((oc) => oc.column("key").doNothing())
      .execute();
  }

  /**
   * The connector templates of installed plugins (in live orgs) with no live connector in the org:
   * none made from the platform template, none recorded on the install for the template id (the
   * two links `PluginInstaller.missingConnectors` reads). Whether each is on is decided per
   * connector, under the org lock.
   */
  private async missing(): Promise<Missing[]> {
    const rows = await this.db
      .selectFrom("plugin_installs as a")
      .innerJoin("orgs as o", "o.id", "a.org_id")
      .innerJoin("platform_connector_templates as t", "t.catalog_item_id", "a.item_id")
      .select(["a.org_id", "a.item_id", "t.id as platform_template_id", "t.template_id"])
      .where("a.status", "=", "installed")
      .where("o.deleted_at", "is", null)
      .where("t.deleted_at", "is", null)
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("connectors as c")
              .select("c.id")
              .whereRef("c.org_id", "=", "a.org_id")
              .whereRef("c.platform_template_id", "=", "t.id")
              .where("c.deleted_at", "is", null),
          ),
        ),
      )
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("plugin_install_components as l")
              .innerJoin("connectors as c", (j) =>
                j.on(sql<string>`c.id::text`, "=", sql<string>`l.ref`),
              )
              .select("l.ref")
              .whereRef("l.install_id", "=", "a.id")
              .where("l.kind", "=", "connector")
              .whereRef("l.template_id", "=", "t.template_id")
              .where("c.deleted_at", "is", null),
          ),
        ),
      )
      .orderBy("a.org_id")
      .orderBy("a.item_id")
      .orderBy("t.template_id")
      .execute();
    return rows.map((r) => ({
      orgId: r.org_id,
      itemId: r.item_id,
      platformTemplateId: r.platform_template_id,
      templateId: r.template_id,
    }));
  }

  /**
   * Creates one missing connector in its own transaction, under the org row lock: none for an org
   * deleted meanwhile or a template off in the org (switched off, shipped default-off). The
   * installer re-checks the install and the live connector and records the new one on the install.
   */
  @Transactional()
  private async createOne(m: Missing): Promise<boolean> {
    if ((await this.orgLock.tryLock(m.orgId)) === undefined) return false;
    const on = await connectorTemplatesOn(this.db, m.orgId, m.itemId, [m.templateId]);
    if (!on.has(m.templateId)) return false;
    const id = await this.installer.createSwitchedOnTemplateConnectorIn(
      m.orgId,
      null,
      m.platformTemplateId,
      { auditDetail: { via: "reconcile" } },
    );
    return id !== undefined;
  }
}
