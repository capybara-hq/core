import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { type CatalogItemView, CatalogService } from "../catalog/catalog.service.js";
import {
  CATALOG_REQUESTS_LIST_MAX,
  CatalogRequestsService,
  type CatalogRequestView,
} from "../catalog/requests.service.js";
import { KernelDb } from "../infra/database/kernel-db.js";

/** The most items one platform inbox read returns. */
export const PLATFORM_INBOX_MAX_ITEMS = 100;
/** The most open scope sync failures one read takes. */
export const SCOPE_SYNC_FAILURES_LIST_MAX = 200;
/**
 * A platform components migration run unfinished this long after its start is stuck (its worker
 * stopped mid-run; a run takes seconds, and the next one starts at the next worker start or day).
 */
export const MIGRATION_RUN_STUCK_MS = 60 * 60_000;

/** Plugin install statuses of a plugin that is on in the org. */
const LIVE_INSTALL = ["installing", "installed", "upgrading"] as const;

/**
 * An open failure of the plugin scope sync: its last attempt to install the plugin in the org (or
 * to uninstall it) failed, and the org still differs from the scope in that direction.
 */
export interface ScopeSyncFailureView {
  item: { id: string; name: string; displayName: LocalizedName | null };
  org: { id: string; name: string };
  op: "install" | "uninstall";
  /** The error code (`internal` for an unexpected error) and its message. */
  code: string;
  message: string;
  failedAt: string;
}

/**
 * The latest platform components migration run (`platform_migration_runs`) when it needs a look:
 * finished with catalog items whose components could not be written (`itemsFailed`,
 * `<name>@<version>`), or `stuck` (unfinished {@link MIGRATION_RUN_STUCK_MS} after its start).
 */
export interface MigrationRunView {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  stuck: boolean;
  itemsFailed: string[];
}

/**
 * One item of the super admin's inbox (by `type`). Nothing is decided in the inbox: each item is
 * acted on where it lives (the web links to it).
 * - `catalog_request`: an org's pending request to the platform (`access`: use a plugin shown to
 *   it; `import`: bring in a marketplace entry), as `GET /admin/catalog/requests` lists them;
 * - `permission_confirmation`: a plugin whose extension permissions wait for a super admin's
 *   confirmation (`GET /admin/catalog/items?pending=true`), `id` = the item's;
 * - `scope_sync_failed`: an open scope sync failure, `id` = `<itemId>/<orgId>`;
 * - `platform_migration`: the latest migration run, failed items or stuck, `id` = the run's.
 */
export type PlatformInboxItem =
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequestView }
  | { type: "permission_confirmation"; id: string; createdAt: string; item: CatalogItemView }
  | { type: "scope_sync_failed"; id: string; createdAt: string; failure: ScopeSyncFailureView }
  | { type: "platform_migration"; id: string; createdAt: string; run: MigrationRunView };

/** `GET /admin/inbox`: newest first, at most {@link PLATFORM_INBOX_MAX_ITEMS}; `truncated`: more. */
export interface PlatformInboxView {
  items: PlatformInboxItem[];
  truncated: boolean;
}

/**
 * The super admin's inbox (plugin scope spec §5.1 rule 5, §13.5): what waits on the platform,
 * gathered from the sources the admin pages read (the 待确认 tab's requests and permission
 * confirmations), plus the scope sync's open failures and the platform components migration's
 * latest run. Stateless, read live from PG.
 */
@Injectable()
export class PlatformInboxService {
  constructor(
    @Inject(CatalogRequestsService)
    private readonly requests: Pick<CatalogRequestsService, "listDeployment">,
    @Inject(CatalogService) private readonly catalog: Pick<CatalogService, "list">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  async list(): Promise<PlatformInboxView> {
    const [requests, pending, failures, run] = await Promise.all([
      this.requests.listDeployment(),
      this.catalog.list({ pending: true }),
      this.scopeSyncFailures(),
      this.migrationRun(),
    ]);
    const all: PlatformInboxItem[] = [
      ...requests.map(
        (r): PlatformInboxItem => ({
          type: "catalog_request",
          id: r.id,
          createdAt: r.createdAt,
          request: r,
        }),
      ),
      ...pending.map(
        (i): PlatformInboxItem => ({
          type: "permission_confirmation",
          id: i.id,
          createdAt: i.updatedAt,
          item: i,
        }),
      ),
      ...failures.map(
        (f): PlatformInboxItem => ({
          type: "scope_sync_failed",
          id: `${f.item.id}/${f.org.id}`,
          createdAt: f.failedAt,
          failure: f,
        }),
      ),
      ...(run === null
        ? []
        : [
            {
              type: "platform_migration",
              id: run.id,
              createdAt: run.finishedAt ?? run.startedAt,
              run,
            } satisfies PlatformInboxItem,
          ]),
    ];
    // newest first; equal times by id (a stable order)
    all.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt
          ? 1
          : -1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
    );
    const full =
      requests.length >= CATALOG_REQUESTS_LIST_MAX ||
      failures.length >= SCOPE_SYNC_FAILURES_LIST_MAX;
    return {
      items: all.slice(0, PLATFORM_INBOX_MAX_ITEMS),
      truncated: full || all.length > PLATFORM_INBOX_MAX_ITEMS,
    };
  }

  /**
   * The open scope sync failures of live items and orgs whose pair still differs from the scope in
   * the failed direction (a person may have converged it meanwhile): an install failure while the
   * org has no live install of the item, an uninstall failure while it has one. Newest first.
   */
  private async scopeSyncFailures(): Promise<ScopeSyncFailureView[]> {
    const rows = await this.kdb.db
      .selectFrom("plugin_scope_sync_failures as f")
      .innerJoin("catalog_items as i", "i.id", "f.item_id")
      .innerJoin("orgs as o", "o.id", "f.org_id")
      .select([
        "f.item_id",
        "i.name as item_name",
        "i.display_name",
        "f.org_id",
        "o.name as org_name",
        "f.op",
        "f.code",
        "f.message",
        "f.failed_at",
      ])
      .where("i.deleted_at", "is", null)
      .where("o.deleted_at", "is", null)
      .where((eb) => {
        const live = eb.exists(
          eb
            .selectFrom("plugin_installs as p")
            .select("p.id")
            .whereRef("p.org_id", "=", "f.org_id")
            .whereRef("p.item_id", "=", "f.item_id")
            .where("p.status", "in", [...LIVE_INSTALL]),
        );
        return eb.or([
          eb.and([eb("f.op", "=", "install"), eb.not(live)]),
          eb.and([eb("f.op", "=", "uninstall"), live]),
        ]);
      })
      .orderBy("f.failed_at", "desc")
      .orderBy("f.item_id")
      .orderBy("f.org_id")
      .limit(SCOPE_SYNC_FAILURES_LIST_MAX)
      .execute();
    return rows.map((r) => ({
      item: { id: r.item_id, name: r.item_name, displayName: r.display_name },
      org: { id: r.org_id, name: r.org_name },
      op: r.op,
      code: r.code,
      message: r.message,
      failedAt: r.failed_at.toISOString(),
    }));
  }

  /**
   * The latest migration run when it needs a look (see {@link MigrationRunView}); null when it
   * finished without failed items, is still running, or there was none. An earlier run's failure
   * is not shown: each run tries every unwritten item again.
   */
  private async migrationRun(): Promise<MigrationRunView | null> {
    const run = await this.kdb.db
      .selectFrom("platform_migration_runs")
      .select(["id", "started_at", "finished_at", "stats"])
      .orderBy("started_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .executeTakeFirst();
    if (run === undefined) return null;
    const failed = run.stats.itemsFailed;
    const itemsFailed = Array.isArray(failed)
      ? failed.filter((x): x is string => typeof x === "string")
      : [];
    const stuck =
      run.finished_at === null && run.started_at.getTime() < Date.now() - MIGRATION_RUN_STUCK_MS;
    if (!stuck && (run.finished_at === null || itemsFailed.length === 0)) return null;
    return {
      id: run.id,
      startedAt: run.started_at.toISOString(),
      finishedAt: run.finished_at?.toISOString() ?? null,
      stuck,
      itemsFailed,
    };
  }
}
