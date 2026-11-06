import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type CatalogItemView, CatalogService } from "../catalog/catalog.service.js";
import { CatalogRequestsService, type CatalogRequestView } from "../catalog/requests.service.js";
import type { ScopeSyncOp } from "../db/kernel-schema.js";
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
 * An open failure of the plugin scope sync: its last attempt to install the plugin in the org, to
 * uninstall it, or to install the dependencies a platform update added (`dependencies`) failed,
 * and the org still differs from the scope in that direction.
 */
export interface ScopeSyncFailureView {
  item: { id: string; name: string; displayName: LocalizedName | null };
  org: { id: string; name: string };
  op: ScopeSyncOp;
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

/**
 * `GET /admin/inbox`: newest first, at most {@link PLATFORM_INBOX_MAX_ITEMS}; `truncated`: more;
 * `total`: how many items wait in all (also `GET /admin/inbox/count`).
 */
export interface PlatformInboxView {
  items: PlatformInboxItem[];
  truncated: boolean;
  total: number;
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
    private readonly requests: Pick<
      CatalogRequestsService,
      "listDeployment" | "countPendingDeployment"
    >,
    @Inject(CatalogService) private readonly catalog: Pick<CatalogService, "list">,
    @Inject(KernelDb) private readonly kdb: KernelDb,
  ) {}

  async list(): Promise<PlatformInboxView> {
    const [requests, requestCount, pending, failures, failureCount, run] = await Promise.all([
      this.requests.listDeployment(),
      this.requests.countPendingDeployment(),
      this.catalog.list({ pending: true }),
      this.scopeSyncFailures(),
      this.countScopeSyncFailures(),
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
    const total = requestCount + pending.length + failureCount + (run === null ? 0 : 1);
    const items = all.slice(0, PLATFORM_INBOX_MAX_ITEMS);
    return { items, truncated: total > items.length, total };
  }

  /**
   * How many items wait (the sidebar's count): the same sources, counted where they can be (the
   * requests and the failures; the permission confirmations are the catalog's pending list).
   */
  async count(): Promise<number> {
    const [requests, pending, failures, run] = await Promise.all([
      this.requests.countPendingDeployment(),
      this.catalog.list({ pending: true }),
      this.countScopeSyncFailures(),
      this.migrationRun(),
    ]);
    return requests + pending.length + failures + (run === null ? 0 : 1);
  }

  /**
   * The open failures still worth a look, joined to their item and org: of a live item and org,
   * and the pair still differs in the failed direction (a person may have converged it meanwhile):
   * an install failure while the org has no live install of the item; an uninstall or dependencies
   * failure while it has one.
   */
  private failureRows() {
    return this.kdb.db
      .selectFrom("plugin_scope_sync_failures as f")
      .innerJoin("catalog_items as i", "i.id", "f.item_id")
      .innerJoin("orgs as o", "o.id", "f.org_id")
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
          eb.and([eb("f.op", "in", ["uninstall", "dependencies"]), live]),
        ]);
      });
  }

  private async countScopeSyncFailures(): Promise<number> {
    const r = await this.failureRows()
      .select(sql<string>`count(*)`.as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The open scope sync failures ({@link failureRows}), newest first. */
  private async scopeSyncFailures(): Promise<ScopeSyncFailureView[]> {
    const rows = await this.failureRows()
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
