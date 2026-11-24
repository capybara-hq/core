import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { BOOTSTRAP_LOCK_KEY, BOOTSTRAP_LOCK_TTL_MS } from "../extensions/bootstrap.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { LockService } from "../infra/lock/lock.service.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { TemplateConnectorEnsurer } from "./template-connector-ensure.js";

/**
 * The `deployment_settings` key the reconciliation writes once it ran through: later starts skip
 * it (ruling R23).
 */
export const TEMPLATE_CONNECTOR_RECONCILE_SETTING = "templateConnectorsReconciled";

/**
 * The one-off reconciliation of template connectors (plugin pages spec §7 "Plugins waiting
 * today"). Installs made before phase 2 left connector templates that are on without a connector,
 * because the install asked for input nobody gave. Since phase 2 every install creates them
 * (§5.2.2), so this pass creates each one the org never had, once, through
 * {@link TemplateConnectorEnsurer} (the same rule and checks as the queued ensure).
 *
 * It runs once at startup, after the extensions loaded: a template's connector extension must be
 * deployed to plan its connector (ruling R22). It runs under the bootstrap step's Redis lock
 * `lock:bootstrap`, taken outside any transaction without waiting. A replica that does not get the
 * lock skips the pass (ruling R26); the holder or the next start finishes it. Under the lock it
 * re-checks the done mark ({@link TEMPLATE_CONNECTOR_RECONCILE_SETTING}).
 *
 * A template the create's checks refuse (kind off in the org, planning failed) or whose connector
 * extension is not loaded here is logged and skipped, and the mark is still written (rulings R23,
 * R25); the queued ensure of a later install or extension switch-on creates it. Any other error,
 * the shutdown or a lost lock stops the pass without the mark, and the next start resumes it.
 */
@Injectable()
export class TemplateConnectorReconciler {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(TemplateConnectorEnsurer) private readonly ensurer: TemplateConnectorEnsurer,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Runs the reconciliation unless it is done or another replica holds the lock; returns the
   * number of connectors it created. `signal` ends the pass (the shutdown).
   */
  async run(signal?: AbortSignal): Promise<{ created: number }> {
    if (await this.done()) return { created: 0 };
    const handle = await this.locks.acquire(BOOTSTRAP_LOCK_KEY, { ttlMs: BOOTSTRAP_LOCK_TTL_MS });
    if (!handle) {
      this.log.info("template connector reconciliation skipped: another replica holds the lock");
      return { created: 0 };
    }
    try {
      // another replica may have finished it before this one got the lock
      if (await this.done()) return { created: 0 };
      const stop = signal ? AbortSignal.any([signal, handle.lost]) : handle.lost;
      let created = 0;
      let skipped = 0;
      for (const orgId of await this.ensurer.orgsMissing()) {
        stop.throwIfAborted();
        const r = await this.ensurer.ensureTemplateConnectorsIn(orgId, undefined, {
          signal: stop,
          via: "reconcile",
        });
        created += r.created;
        skipped += r.skipped + r.notLoaded;
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
}
