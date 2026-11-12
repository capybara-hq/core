import type { PluginManifest } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import type { KernelSchemaDb, ScopeSyncOp } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { ExtensionLifecycle } from "../extensions/lifecycle.js";
import { ExtensionRegistry } from "../extensions/registry.js";
import { audit } from "../identity/audit.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { TransactionHost } from "../infra/database/transaction-host.js";
import { Transactional } from "../infra/database/transactional.decorator.js";
import { LockService } from "../infra/lock/lock.service.js";
import { OutboxService } from "../infra/outbox/outbox.service.js";
import type { OneJob } from "../infra/queue/add-job-once.js";
import { KERNEL_LOGGER } from "../infra/tokens.js";
import type { KernelLogger } from "../log.js";
import { connectorTemplatesOn, templateIdOfPath } from "./component-state.js";
import { isUsable } from "./ownership.js";
import { type InstallPlan, PluginInstaller } from "./plugin-install.js";
import { wantedOn } from "./scope.js";
import { ScopeNoLongerWanted, ScopeStillWanted } from "./scope-state.js";

/**
 * The plugin scope sync (plugin and component management spec §5, phase 1): converges every org
 * to each platform plugin's scope. In phase 1 "on in an org" is the org's plugin install, so for
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
 * The sync writes no switch row: those record people's choices, and `wantedOn` honours them for
 * every scope (an org that switched an `all` item off stays off, also across a scope change away
 * and back, layering spec §4). Builtin items are left alone (on everywhere through their required
 * extension). A failed install, uninstall or dependency install is logged, audited
 * `plugin.scope_sync_failed`, kept as the pair's open failure (`plugin_scope_sync_failures`, the
 * super admin's inbox, until a later sync of the pair does not fail) and not retried until the next
 * enqueue. An error outside those steps (a read, the failure write itself) ends the attempt without
 * touching the pair's row, so an older failure stays open.
 *
 * Jobs (queue {@link PLUGIN_SCOPE_QUEUE}): one per item and scope version
 * (`scope-item-<itemId>-<scope_version>`, every org), one per org (`scope-org-<orgId>`, every item,
 * owed by the org's creation). Both are owed in the outbox by the transaction that changes what
 * they converge to (transactional outbox spec §8.1), so none is lost; a migration that changes a
 * scope inserts its outbox rows itself. Both are removed when done, so the next add with the same
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
/**
 * The delayed retry `n` of an item job whose extension this replica had not loaded yet (ruling
 * P3-38); deterministic, so replicas deferring the same item add it once.
 */
export const scopeRetryJobId = (itemId: string, version: number, n: number): string =>
  `scope-item-${itemId}-${version}-r${n}`;
/** How many delayed retries an item job gets while its extension is not loaded here (P3-38). */
export const SCOPE_LOAD_RETRIES = 6;
/** The delay of each such retry. */
export const SCOPE_LOAD_RETRY_DELAY_MS = 5_000;
/** How long a pair waits for this replica's reconcile before deferring (P3-38). */
export const SCOPE_RECONCILE_WAIT_MS = 10_000;

/**
 * The job's data. `retry`: the item job's delayed retry number (P3-38); at
 * {@link SCOPE_LOAD_RETRIES} an extension still not loaded is a failure as before.
 */
export type ScopeJob =
  | { kind: "item"; itemId: string; retry?: number }
  | { kind: "org"; orgId: string };

/**
 * Awaits this replica's extension reconcile for at most `ms` (a slower one carries on in the
 * background); a failure only warns.
 */
export async function reconcileWithin(
  lifecycle: Pick<ExtensionLifecycle, "reconcile">,
  reason: string,
  ms: number,
  log: Pick<KernelLogger, "warn">,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      lifecycle.reconcile(reason),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      }),
    ]);
  } catch (err) {
    log.warn("reconciling extensions on this replica failed", { reason, err });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The item job of a scope version with its BullMQ options, for the CLI, which adds it directly
 * (it has no outbox; {@link PluginScopeSync.enqueueItem} owes the same job id).
 */
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

/**
 * What a sync of one (item, org) did. `deferred`: the plugin's extension is enabled on the
 * deployment but not loaded on this replica yet (P3-38); the item job retries later.
 */
export type ScopeSyncResult = "installed" | "removed" | "needs_config" | "unchanged" | "deferred";

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
    @Inject(OutboxService) private readonly outbox: Pick<OutboxService, "add">,
    @Inject(PluginInstaller) private readonly installer: PluginInstaller,
    @Inject(ExtensionRegistry) private readonly registry: ExtensionRegistry,
    /** This replica's reconcile, awaited (bounded) before deferring an install (P3-38). */
    @Inject(ExtensionLifecycle) private readonly lifecycle: ExtensionLifecycle,
    @Inject(LockService) private readonly locks: LockService,
    @Inject(KERNEL_LOGGER) private readonly log: KernelLogger,
    @Inject(TransactionHost) readonly txHost: TransactionHost,
  ) {}

  private get db(): KernelSchemaDb {
    return this.kdb.db;
  }

  /**
   * Owes the sync of an item in every org, once per scope version (the version read in the
   * caller's transaction, so after its own bump), in the transaction that changes the scope.
   */
  @Transactional({ propagation: "mandatory" })
  async enqueueItem(itemId: string): Promise<void> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!row) return;
    await this.outbox.add<ScopeJob>({
      queue: PLUGIN_SCOPE_QUEUE,
      name: SCOPE_ITEM_JOB,
      jobId: scopeItemJobId(itemId, row.scope_version),
      data: { kind: "item", itemId },
    });
  }

  /** Owes the sync of every item in an org, in the transaction that creates the org. */
  @Transactional({ propagation: "mandatory" })
  async enqueueOrg(orgId: string): Promise<void> {
    await this.outbox.add<ScopeJob>({
      queue: PLUGIN_SCOPE_QUEUE,
      name: SCOPE_ORG_JOB,
      jobId: scopeOrgJobId(orgId),
      data: { kind: "org", orgId },
      orgId,
    });
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
    const retry = data.kind === "item" ? (data.retry ?? 0) : 0;
    const finalTry = data.kind === "item" && retry >= SCOPE_LOAD_RETRIES;
    const deferred = new Set<string>();
    for (const [itemId, orgId] of pairs) {
      if (signal?.aborted) return;
      try {
        const r = await this.syncPair(itemId, orgId, signal, { finalTry });
        if (r === "deferred") deferred.add(itemId);
      } catch (err) {
        this.log.warn("plugin scope sync of a pair failed", { itemId, orgId, err });
      }
    }
    // An extension this replica had not loaded yet: the item again after a delay (P3-38)
    for (const itemId of deferred) {
      try {
        await this.enqueueRetry(itemId, retry + 1);
      } catch (err) {
        this.log.warn("enqueueing a delayed plugin scope sync failed", { itemId, err });
      }
    }
  }

  /**
   * Owes the delayed retry `n` of an item job (deterministic id, P3-38) in a transaction of its
   * own: the job's own follow-up, delivered by the relay once due.
   */
  @Transactional()
  private async enqueueRetry(itemId: string, n: number): Promise<void> {
    const row = await this.db
      .selectFrom("catalog_items")
      .select("scope_version")
      .where("id", "=", itemId)
      .executeTakeFirst();
    if (!row) return;
    await this.outbox.add<ScopeJob>({
      queue: PLUGIN_SCOPE_QUEUE,
      name: SCOPE_ITEM_JOB,
      jobId: scopeRetryJobId(itemId, row.scope_version, n),
      data: { kind: "item", itemId, retry: n },
      runAt: new Date(Date.now() + SCOPE_LOAD_RETRY_DELAY_MS),
    });
  }

  /**
   * Whether the install of the item's `version` may go ahead on this replica (P3-38): its
   * extension is loaded here, or it is not enabled on the deployment (the install reports
   * `catalog.not_deployed` as before). Enabled but not loaded here: this replica's reconcile is
   * awaited (bounded); still not loaded -> false, unless this is the last try.
   */
  private async extensionReady(
    itemId: string,
    version: string,
    finalTry: boolean,
  ): Promise<boolean> {
    const v = await this.db
      .selectFrom("catalog_item_versions")
      .select("manifest")
      .where("item_id", "=", itemId)
      .where("version", "=", version)
      .executeTakeFirst();
    const m = v?.manifest as PluginManifest | undefined;
    if (!m?.extension) return true;
    const loaded = () => this.registry.manifests().some((x) => x.name === m.name);
    if (loaded()) return true;
    const install = await this.db
      .selectFrom("extension_installs")
      .select("desired_state")
      .where("name", "=", m.name)
      .executeTakeFirst();
    if (install?.desired_state !== "enabled") return true;
    await reconcileWithin(
      this.lifecycle,
      `scope-sync:${m.name}`,
      SCOPE_RECONCILE_WAIT_MS,
      this.log,
    );
    return loaded() || finalTry;
  }

  /** Converges one (item, org), under the org's sync lock; `signal` ends the wait for it. */
  syncPair(
    itemId: string,
    orgId: string,
    signal?: AbortSignal,
    opts: { finalTry?: boolean } = {},
  ): Promise<ScopeSyncResult> {
    return this.locks.run(
      `plugin-scope-org-${orgId}`,
      {
        ttlMs: ORG_LOCK_TTL_MS,
        waitMs: ORG_LOCK_WAIT_MS,
        ...(signal !== undefined && { signal }),
      },
      () => this.syncRecorded(itemId, orgId, opts.finalTry === true),
    );
  }

  /**
   * {@link syncLocked} plus the pair's open failure (`plugin_scope_sync_failures`, the super
   * admin's inbox): an attempt that failed records it, any other attempt clears it. An attempt
   * that throws (outside the recorded steps) leaves the row as it was.
   */
  private async syncRecorded(
    itemId: string,
    orgId: string,
    finalTry = false,
  ): Promise<ScopeSyncResult> {
    const attempt = { failed: false, finalTry };
    const result = await this.syncLocked(itemId, orgId, attempt);
    // a deferred pair changed nothing: an older failure stays open
    if (!attempt.failed && result !== "deferred") {
      await this.db
        .deleteFrom("plugin_scope_sync_failures")
        .where("item_id", "=", itemId)
        .where("org_id", "=", orgId)
        .execute();
    }
    return result;
  }

  private async syncLocked(
    itemId: string,
    orgId: string,
    attempt: { failed: boolean; finalTry: boolean },
  ): Promise<ScopeSyncResult> {
    const item = await this.db
      .selectFrom("catalog_items")
      .select([
        "id",
        "scope",
        "builtin",
        "disabled",
        "deleted_at",
        "awaiting_confirmation",
        "latest_version",
        "platform_synced_version",
      ])
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
      if (live) {
        // A platform update may have added dependencies: installed here (rule 9, Task 7)
        if (live.status === "installed") {
          try {
            await this.installer.addMissingDependencies(orgId, live.id);
          } catch (e) {
            await this.failed(orgId, itemId, "dependencies", e, attempt);
          }
        }
        return "unchanged";
      }
      // Never installed while not usable: an org upload still waiting for the super admin
      // (ruling P3-9) has nothing confirmed to install
      if (!isUsable(item)) return "unchanged";
      // The platform's version (one per deployment, Task 7); the latest import before the first sync
      const version = item.platform_synced_version ?? item.latest_version;
      try {
        if (!(await this.extensionReady(itemId, version, attempt.finalTry))) return "deferred";
        if (await this.needsInput(orgId, itemId, version)) return "needs_config";
        await this.installer.install(orgId, null, itemId, version, {}, { via: "scope" });
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
        await this.failed(orgId, itemId, "install", e, attempt);
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
      await this.failed(orgId, itemId, "uninstall", e, attempt);
      return "unchanged";
    }
    // Dependency installs it took along may be wanted on by their own scope: synced again
    for (const dep of deps) {
      if (dep !== itemId) await this.syncRecorded(dep, orgId);
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
    if (await this.manifestNeedsInput(orgId, root, itemId)) return true;
    // the dependencies the install would bring (planning reads no input of the org)
    const plan = await this.installer.plan(orgId, null, itemId, version, null, "", undefined);
    const visit = async (p: InstallPlan): Promise<boolean> => {
      if (await this.manifestNeedsInput(orgId, p.manifest, p.itemId)) return true;
      for (const d of p.dependencies) if (d.plan && (await visit(d.plan))) return true;
      return false;
    };
    return visit(plan);
  }

  /**
   * Whether installing plugin `itemId` (manifest `m`) needs the org's input: a connector template
   * on in the org (ruling P2-6: templates switched off there, outside their own scope or disabled
   * make no connector), or a required org config of its extension not set yet.
   */
  private async manifestNeedsInput(
    orgId: string,
    m: PluginManifest,
    itemId: string,
  ): Promise<boolean> {
    const ids = (m.connectorTemplates ?? []).map((t) => templateIdOfPath(t.path));
    if ((await connectorTemplatesOn(this.db, orgId, itemId, ids)).size > 0) return true;
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

  /**
   * Logs and audits a failed install or uninstall (`plugin.scope_sync_failed`, actor null) and
   * records it as the pair's open failure (the super admin's inbox).
   */
  private async failed(
    orgId: string,
    itemId: string,
    op: ScopeSyncOp,
    e: unknown,
    attempt: { failed: boolean },
  ): Promise<void> {
    attempt.failed = true;
    const code = e instanceof ApiError ? e.code : "internal";
    const message = e instanceof Error ? e.message : String(e);
    this.log.warn("plugin scope sync failed", { orgId, itemId, op, code, err: e });
    await this.recordFailure(orgId, itemId, op, code, message);
  }

  @Transactional({ propagation: "requires_new" })
  private async recordFailure(
    orgId: string,
    itemId: string,
    op: ScopeSyncOp,
    code: string,
    message: string,
  ): Promise<void> {
    await audit(this.db, {
      actorAccountId: null,
      orgId,
      action: "plugin.scope_sync_failed",
      target: itemId,
      detail: { via: "scope", op, code, message },
    });
    const failure = { op, code, message, failed_at: new Date() };
    await this.db
      .insertInto("plugin_scope_sync_failures")
      .values({ item_id: itemId, org_id: orgId, ...failure })
      .onConflict((oc) => oc.columns(["item_id", "org_id"]).doUpdateSet(failure))
      .execute();
  }
}
