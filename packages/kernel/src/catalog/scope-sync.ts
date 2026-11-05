import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { getQueueToken, OnWorkerEvent, WorkerHost } from "@nestjs/bullmq";
import { Inject, Injectable } from "@nestjs/common";
import type { Job, Queue, Worker } from "bullmq";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import type { OneJob } from "../infra/queue/add-job-once.js";
import { runJob } from "../infra/queue/run-job.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { type InstallPlan, PluginInstaller } from "./plugin-install.js";
import { wantedOn } from "./scope.js";
import { ScopeNoLongerWanted, ScopeStillWanted } from "./scope-state.js";

/**
 * The plugin scope sync (plugin and component management spec §5, phase 1): converges every org
 * to each enterprise plugin's scope. In phase 1 "on in an org" is the org's plugin install, so for
 * each (item, org) the sync:
 * - wanted on (`wantedOn`, or a live install in the org depends on it: rule 9) and no live install
 *   -> installs it as the kernel itself (actor null, audits `via: "scope"`), unless the install
 *   needs the org's input (connector templates, or a required org config of its extension not set):
 *   that is `needs_config`, derived by the org catalog, never attempted here;
 * - wanted off and a live install -> uninstalls it (`via: "scope"`; the person who changed the
 *   scope or the switch confirmed the preview); the connectors the install created stay as the
 *   org's own (spec §5 rule 8); a dependency install it took along that its own scope still wants
 *   on stays as a standalone install (the installer's rule), the others are synced again.
 * The decision is made outside the org row lock; the installer re-checks the scope under it for a
 * `via: "scope"` install or uninstall, so a person's switch committed meanwhile wins.
 * The sync writes no switch row: those record people's choices. Builtin items are left alone (on
 * everywhere through their required extension). An install or uninstall failure is logged and
 * audited `plugin.scope_sync_failed` and not retried until the next enqueue; every worker start
 * enqueues every live item once ({@link PluginScopeSync.enqueueAll}), which also catches a lost
 * enqueue.
 *
 * Jobs (queue {@link PLUGIN_SCOPE_QUEUE}): one per item and scope version
 * (`scope-item-<itemId>-<scope_version>`, every org), one per org (`scope-org-<orgId>`, every item,
 * enqueued after the org is created). Both are removed when done, so the next enqueue with the same
 * id is not swallowed. Pairs of one org are serialized across replicas by a Redis lock per org; the
 * installer's org row lock and its one-live-install rule are the backstop.
 */

/** The scope sync queue (no `:` in the name). */
export const PLUGIN_SCOPE_QUEUE = "cap-kernel-plugin-scope";
/** The job converging one item in every org. */
export const SCOPE_ITEM_JOB = "scope-item";
/** The job converging every item in one org. */
export const SCOPE_ORG_JOB = "scope-org";
/** One item job per scope version (no `:`: item ids are UUIDs). */
export const scopeItemJobId = (itemId: string, version: number): string =>
  `scope-item-${itemId}-${version}`;
/** One org job at a time per org. */
export const scopeOrgJobId = (orgId: string): string => `scope-org-${orgId}`;

/** The job's data. */
export type ScopeJob = { kind: "item"; itemId: string } | { kind: "org"; orgId: string };

/** The item job of a scope version (what {@link PluginScopeSync.enqueueItem} adds). */
export function scopeItemJob(itemId: string, version: number): OneJob<ScopeJob> {
  return {
    name: SCOPE_ITEM_JOB,
    data: { kind: "item", itemId },
    opts: {
      jobId: scopeItemJobId(itemId, version),
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  };
}

/** What a sync of one (item, org) did. */
export type ScopeSyncResult = "installed" | "removed" | "needs_config" | "unchanged";

/** How long one org's pairs wait for each other (an install can take a while). */
const ORG_LOCK_TTL_MS = 60_000;
const ORG_LOCK_WAIT_MS = 10 * 60_000;
/** The worker's concurrency. */
export const PLUGIN_SCOPE_CONCURRENCY = 2;

const LIVE = ["installing", "installed", "upgrading"] as const;

@Injectable()
export class PluginScopeSync {
  constructor(
    @Inject(KernelDb) private readonly kdb: KernelDb,
    @Inject(getQueueToken(PLUGIN_SCOPE_QUEUE)) private readonly queue: Queue<ScopeJob>,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /** Enqueues the sync of an item in every org, once per scope version. Call after the commit. */
  async enqueueItem(itemId: string): Promise<void> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!row) return;
    const job = scopeItemJob(itemId, row.scope_version);
    await this.queue.add(job.name, job.data, job.opts);
  }

  /**
   * Enqueues the sync of every live, not builtin item (a worker start): retries what failed or was
   * never enqueued (a lost `afterCommit` enqueue, a migrated scope). The job ids are the items'
   * scope versions, so replicas starting together add each one once.
   */
  async enqueueAll(): Promise<void> {
    const items = await this.db
      .selectFrom("catalog_items")
      .select("id")
      .where("deleted_at", "is", null)
      .where("builtin", "=", false)
      .orderBy("id")
      .execute();
    for (const i of items) await this.enqueueItem(i.id);
  }

  /** Enqueues the sync of every item in an org (a new org). Call after the commit. */
  async enqueueOrg(orgId: string): Promise<void> {
    await this.queue.add(
      SCOPE_ORG_JOB,
      { kind: "org", orgId },
      { jobId: scopeOrgJobId(orgId), attempts: 1, removeOnComplete: true, removeOnFail: true },
    );
  }

  /** One job: every org of an item, or every item of an org; `signal` stops between pairs. */
  async process(data: ScopeJob, signal?: AbortSignal): Promise<void> {
    const pairs: [string, string][] =
      data.kind === "item"
        ? (
            await this.db
              .selectFrom("orgs")
              .select("id")
              .where("deleted_at", "is", null)
              .orderBy("id")
              .execute()
          ).map((o) => [data.itemId, o.id])
        : (
            await this.db
              .selectFrom("catalog_items")
              .select("id")
              .where("deleted_at", "is", null)
              .where("builtin", "=", false)
              .orderBy("id")
              .execute()
          ).map((i) => [i.id, data.orgId]);
    for (const [itemId, orgId] of pairs) {
      if (signal?.aborted) return;
      try {
        await this.syncPair(itemId, orgId, signal);
      } catch (err) {
        this.log.warn("plugin scope sync of a pair failed", { itemId, orgId, err });
      }
    }
  }

  /** Converges one (item, org), under the org's sync lock; `signal` ends the wait for it. */
  syncPair(itemId: string, orgId: string, signal?: AbortSignal): Promise<ScopeSyncResult> {
    return this.locks.run(
      `plugin-scope-org-${orgId}`,
      {
        ttlMs: ORG_LOCK_TTL_MS,
        waitMs: ORG_LOCK_WAIT_MS,
        ...(signal !== undefined && { signal }),
      },
      () => this.syncLocked(itemId, orgId),
    );
  }

  private async syncLocked(itemId: string, orgId: string): Promise<ScopeSyncResult> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select(["id", "scope", "builtin", "disabled", "latest_version"])
      .where("id", "=", itemId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    const org = await this.db
      .selectFrom("orgs")
      .select("id")
      .where("id", "=", orgId)
      .where("deleted_at", "is", null)
      .executeTakeFirst();
    if (!item || !org || item.builtin) return "unchanged";
    const [listed, sw, live] = await Promise.all([
      this.db
        .selectFrom("catalog_item_scope_orgs")
        .select("item_id")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst(),
      this.db
        .selectFrom("catalog_item_org_switches")
        .select("enabled")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .executeTakeFirst(),
      this.db
        .selectFrom("plugin_installs")
        .select(["id", "status"])
        .where("org_id", "=", orgId)
        .where("item_id", "=", itemId)
        .where("status", "in", [...LIVE])
        .executeTakeFirst(),
    ]);
    const wanted =
      wantedOn(item, listed !== undefined, sw?.enabled ?? null) ||
      (live !== undefined && (await this.dependedOn(orgId, live.id)));
    if (wanted) {
      if (live) return "unchanged";
      try {
        if (await this.needsInput(orgId, itemId, item.latest_version)) return "needs_config";
        await this.installer.install(
          orgId,
          null,
          itemId,
          item.latest_version,
          {},
          { via: "scope" },
        );
        return "installed";
      } catch (e) {
        // A person switched it off (or the scope changed) after this decision: the installer's
        // re-check under the org row lock refused it, nothing written
        if (e instanceof ScopeNoLongerWanted) return "unchanged";
        // Another install of this item got there first (a person, or a dependency): converged
        if (
          e instanceof ApiError &&
          (e.code === "plugin.already_installed" || e.code === "plugin.install_in_progress")
        ) {
          return "unchanged";
        }
        await this.failed(orgId, itemId, "install", e);
        return "unchanged";
      }
    }
    // Wanted off: only a settled install is removed (one still installing or upgrading waits for
    // the next enqueue)
    if (live?.status !== "installed") return "unchanged";
    const deps = await this.createdDependencies(live.id);
    try {
      await this.installer.uninstall(orgId, null, live.id, { via: "scope" });
    } catch (e) {
      // A person switched it on (or the scope changed, or another install came to depend on it)
      // after this decision: the installer's re-check under the org row lock refused it
      if (e instanceof ScopeStillWanted) return "unchanged";
      await this.failed(orgId, itemId, "uninstall", e);
      return "unchanged";
    }
    // Dependency installs it took along may be wanted on by their own scope: synced again
    for (const dep of deps) {
      if (dep !== itemId) await this.syncLocked(dep, orgId);
    }
    return "removed";
  }

  /** Whether a live install of the org depends on this install (spec §5 rule 9). */
  async dependedOn(orgId: string, installId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("plugin_install_components as c")
      .innerJoin("plugin_installs as a", "a.id", "c.install_id")
      .select("a.id")
      .where("a.org_id", "=", orgId)
      .where("a.status", "in", [...LIVE])
      .where("c.kind", "=", "plugin")
      .where("c.ref", "=", installId)
      .executeTakeFirst();
    return row !== undefined;
  }

  /** The items of the dependency installs this install created. */
  private async createdDependencies(installId: string): Promise<string[]> {
    // `ref` is text: the child install ids are read first, then their items
    const refs = await this.db
      .selectFrom("plugin_install_components")
      .select("ref")
      .where("install_id", "=", installId)
      .where("kind", "=", "plugin")
      .where("created", "=", true)
      .execute();
    if (refs.length === 0) return [];
    const rows = await this.db
      .selectFrom("plugin_installs")
      .select("item_id")
      .where(
        "id",
        "in",
        refs.map((r) => r.ref),
      )
      .execute();
    return rows.map((r) => r.item_id);
  }

  /**
   * Whether installing the item (with the dependencies the org lacks) needs the org's input: a
   * connector template, or an extension whose org config is required and not set in the org. The
   * same rule as the org catalog's `needs_config`, applied to the whole tree.
   */
  async needsInput(orgId: string, itemId: string, version: string): Promise<boolean> {
    const v = await this.db
      .selectFrom("catalog_item_versions")
      .select("manifest")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    const root = v?.manifest as PluginManifest | undefined;
    if (root === undefined) return false;
    if (await this.manifestNeedsInput(orgId, root)) return true;
    // the dependencies the install would bring (planning reads no input of the org)
    const plan = await this.installer.plan(orgId, null, itemId, version, null, "", undefined);
    const visit = async (p: InstallPlan): Promise<boolean> => {
      if (await this.manifestNeedsInput(orgId, p.manifest)) return true;
      for (const d of p.dependencies) if (d.plan && (await visit(d.plan))) return true;
      return false;
    };
    return visit(plan);
  }

  private async manifestNeedsInput(orgId: string, m: PluginManifest): Promise<boolean> {
    if ((m.connectorTemplates ?? []).length > 0) return true;
    if (!m.extension) return false;
    const ext = this.registry.manifests().find((x) => x.name === m.name);
    const schema = ext?.config?.org;
    if (schema === undefined || schema.safeParse({}).success) return false;
    const configured = await this.db
      .selectFrom("extension_org_configs")
      .select("plugin")
      .where("org_id", "=", orgId)
      .where("plugin", "=", m.name)
      .where("config", "is not", null)
      .executeTakeFirst();
    return configured === undefined;
  }

  /** Logs and audits a failed install or uninstall (`plugin.scope_sync_failed`, actor null). */
  private async failed(
    orgId: string,
    itemId: string,
    op: "install" | "uninstall",
    e: unknown,
  ): Promise<void> {
    const code = e instanceof ApiError ? e.code : "internal";
    const message = e instanceof Error ? e.message : String(e);
    this.log.warn("plugin scope sync failed", { orgId, itemId, op, code, err: e });
    await this.auditFailure(orgId, itemId, { via: "scope", op, code, message });
  }

  @Transactional({ propagation: "requires_new" })
  private async auditFailure(
    orgId: string,
    itemId: string,
    detail: Record<string, unknown>,
  ): Promise<void> {
    await audit(this.db, {
      actorAccountId: null,
      orgId,
      action: "plugin.scope_sync_failed",
      target: itemId,
      detail,
    });
  }
}

/** The consumer of {@link PLUGIN_SCOPE_QUEUE}: {@link PluginScopeSync}. */
@Injectable()
export class PluginScopeSyncProcessor extends WorkerHost<Worker<ScopeJob>> {
  private readonly stopping = new AbortController();

  constructor(
    @Inject(PluginScopeSync) private readonly sync: PluginScopeSync,
    @Inject(KERNEL_LOGGER) private readonly log: Pick<KernelLogger, "error">,
  ) {
    super();
  }

  process(job: Job<ScopeJob>): Promise<void> {
    return runJob(PLUGIN_SCOPE_QUEUE, job, () => this.sync.process(job.data, this.stopping.signal));
  }

  /** Starts consuming (worker role, after the extensions loaded; built with `autorun: false`). */
  start(): void {
    void this.worker.run().catch((err) => this.error(err));
  }

  /**
   * Enqueues every live item's sync once (the worker role, after the start gate opened), in the
   * background; a failure is only logged (the next worker start, or the next change, enqueues).
   */
  resync(): void {
    void this.sync
      .enqueueAll()
      .catch((err) => this.log.error("plugin scope resync failed", { err }));
  }

  /** Stops between pairs and closes the worker. */
  async close(): Promise<void> {
    this.stopping.abort();
    await this.worker.close();
  }

  @OnWorkerEvent("failed")
  failed(job: Job<ScopeJob> | undefined, err: Error): void {
    this.log.error("plugin scope job failed", { name: job?.name, jobId: job?.id, err });
  }

  @OnWorkerEvent("error")
  error(err: Error): void {
    this.log.error("plugin scope worker error", { err });
  }
}
