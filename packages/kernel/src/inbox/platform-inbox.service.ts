import type { LocalizedName } from "@capybara-hq/plugin-sdk";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { type CatalogItemView, CatalogService } from "../catalog/catalog.service.js";
import { LIVE_INSTALL_STATUSES } from "../catalog/install-status.js";
import { CatalogRequestsService, type CatalogRequestView } from "../catalog/requests.service.js";
import type { ScopeSyncOp } from "../db/kernel-schema.js";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import type { PlatformNoticeDetails } from "./platform-notices.js";

/** The most items one platform inbox read returns. */
export const PLATFORM_INBOX_MAX_ITEMS = 100;
/** The most open scope sync failures one read takes. */
export const SCOPE_SYNC_FAILURES_LIST_MAX = 200;

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
 * A live platform plugin (or an org's own) whose scope turns it on (`all` or `named`) while its
 * extension is installed and approved but disabled on the deployment (a super admin disabled it, or
 * its enable was refused because another enabled extension holds one of its single-provider
 * extension points): the scope sync installs it nowhere until the extension is enabled, whose
 * enable owes the sync. Derived from the current state at every read.
 */
export interface ExtensionDisabledView {
  item: { id: string; name: string; displayName: LocalizedName | null };
  /** The extension's name (the plugin's) and its installed version. */
  extension: { name: string; version: string };
  /** When the extension's install record last changed (its disable, or its install). */
  since: string;
}

/**
 * One item of the super admin's inbox (by `type`). Nothing is decided in the inbox: each item is
 * acted on where it lives (the web links to it).
 * - `catalog_request`: an org's pending request to the platform (`access`: use a plugin shown to
 *   it; `import`: bring in a marketplace entry), as `GET /admin/catalog/requests` lists them;
 * - `permission_confirmation`: a platform plugin whose extension permissions wait for a super
 *   admin's confirmation (`GET /admin/catalog/items?pending=true`), `id` = the item's;
 * - `org_upload_pending`: an org-owned plugin whose uploaded version (with an extension) waits for
 *   the super admin in 待确认 (ruling P3-22; confirmed or rejected there), `id` = the item's;
 * - `scope_sync_failed`: an open scope sync failure, `id` = `<itemId>/<orgId>`;
 * - `extension_disabled`: a plugin its scope turns on whose extension is disabled on the deployment
 *   ({@link ExtensionDisabledView}), `id` = the item's; gone once the extension is enabled (or the
 *   scope no longer turns it on);
 * - `ownership_transferred`: a deleted org's shared item now belongs to the platform, until a
 *   super admin dismisses it (`POST admin/inbox/notices/:id/dismiss`).
 */
export type PlatformInboxItem =
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequestView }
  | { type: "permission_confirmation"; id: string; createdAt: string; item: CatalogItemView }
  | { type: "org_upload_pending"; id: string; createdAt: string; item: CatalogItemView }
  | { type: "scope_sync_failed"; id: string; createdAt: string; failure: ScopeSyncFailureView }
  | {
      type: "extension_disabled";
      id: string;
      createdAt: string;
      disabled: ExtensionDisabledView;
    }
  | {
      type: "ownership_transferred";
      id: string;
      createdAt: string;
      notice: PlatformNoticeView;
    };

/** Every {@link PlatformInboxItem} type, in the order the admin overview lists them. */
export const PLATFORM_INBOX_TYPES = [
  "catalog_request",
  "permission_confirmation",
  "org_upload_pending",
  "scope_sync_failed",
  "extension_disabled",
  "ownership_transferred",
] as const satisfies readonly PlatformInboxItem["type"][];

/** How many items of each type wait: every type, zeros included. */
export type PlatformInboxCounts = Record<PlatformInboxItem["type"], number>;

/** An open platform notice (`platform_notices`, kind `ownership_transferred`). */
export interface PlatformNoticeView {
  id: string;
  kind: "ownership_transferred";
  createdAt: string;
  detail: PlatformNoticeDetails["ownership_transferred"];
}

/**
 * `GET /admin/inbox`: newest first, at most {@link PLATFORM_INBOX_MAX_ITEMS}; `truncated`: more;
 * `total`: how many items wait in all (also `GET /admin/inbox/count`); `byType`: `total` per
 * type, counted over everything waiting (not the listed window).
 */
export interface PlatformInboxView {
  items: PlatformInboxItem[];
  truncated: boolean;
  total: number;
  byType: PlatformInboxCounts;
}

/**
 * The super admin's inbox (plugin scope spec §5.1 rule 5, §13.5): what waits on the platform,
 * gathered from the sources the admin pages read (the 待确认 tab's requests and permission
 * confirmations), plus the scope sync's open failures and the platform notices. Stateless, read
 * live from PG.
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
    const [
      requests,
      requestCount,
      pending,
      failures,
      failureCount,
      disabled,
      disabledCount,
      notices,
      noticeCount,
    ] = await Promise.all([
      this.requests.listDeployment(),
      this.requests.countPendingDeployment(),
      this.catalog.list({ pending: true }),
      this.scopeSyncFailures(),
      this.countScopeSyncFailures(),
      this.disabledExtensions(),
      this.countDisabledExtensions(),
      this.notices(),
      this.countNotices(),
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
          type: i.owner.kind === "org" ? "org_upload_pending" : "permission_confirmation",
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
      ...disabled.map(
        (d): PlatformInboxItem => ({
          type: "extension_disabled",
          id: d.item.id,
          createdAt: d.since,
          disabled: d,
        }),
      ),
      ...notices.map(
        (n): PlatformInboxItem => ({
          type: "ownership_transferred",
          id: n.id,
          createdAt: n.createdAt,
          notice: n,
        }),
      ),
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
    const orgUploads = pending.filter((i) => i.owner.kind === "org").length;
    const byType: PlatformInboxCounts = {
      catalog_request: requestCount,
      permission_confirmation: pending.length - orgUploads,
      org_upload_pending: orgUploads,
      scope_sync_failed: failureCount,
      extension_disabled: disabledCount,
      ownership_transferred: noticeCount,
    };
    const total = Object.values(byType).reduce((a, b) => a + b, 0);
    const items = all.slice(0, PLATFORM_INBOX_MAX_ITEMS);
    return { items, truncated: total > items.length, total, byType };
  }

  /**
   * How many items wait (the sidebar's count): the same sources, counted where they can be (the
   * requests and the failures; the permission confirmations are the catalog's pending list).
   */
  async count(): Promise<number> {
    const [requests, pending, failures, disabled, notices] = await Promise.all([
      this.requests.countPendingDeployment(),
      this.catalog.list({ pending: true }),
      this.countScopeSyncFailures(),
      this.countDisabledExtensions(),
      this.countNotices(),
    ]);
    return requests + pending.length + failures + disabled + notices;
  }

  private async countNotices(): Promise<number> {
    const r = await this.kdb.db
      .selectFrom("platform_notices")
      .select(sql<string>`count(*)`.as("n"))
      .where("dismissed_at", "is", null)
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The open platform notices, newest first, at most {@link PLATFORM_INBOX_MAX_ITEMS}. */
  private async notices(): Promise<PlatformNoticeView[]> {
    const rows = await this.kdb.db
      .selectFrom("platform_notices")
      .select(["id", "kind", "detail", "created_at"])
      .where("dismissed_at", "is", null)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .limit(PLATFORM_INBOX_MAX_ITEMS)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      createdAt: r.created_at.toISOString(),
      detail: r.detail as unknown as PlatformNoticeDetails["ownership_transferred"],
    }));
  }

  /**
   * A super admin dismisses a platform notice (for every super admin). Dismissing one already
   * dismissed is fine; no notice with that id -> `inbox.notice_not_found`.
   */
  async dismissNotice(accountId: string, id: string): Promise<void> {
    if (!UUID_RE.test(id)) throw new ApiError("inbox.notice_not_found", "Notice not found");
    const r = await this.kdb.db
      .updateTable("platform_notices")
      .set({ dismissed_at: sql<Date>`now()`, dismissed_by: accountId })
      .where("id", "=", id)
      .where("dismissed_at", "is", null)
      .executeTakeFirst();
    if (r.numUpdatedRows > 0n) return;
    const exists = await this.kdb.db
      .selectFrom("platform_notices")
      .select("id")
      .where("id", "=", id)
      .executeTakeFirst();
    if (!exists) throw new ApiError("inbox.notice_not_found", "Notice not found");
  }

  private async countDisabledExtensions(): Promise<number> {
    const r = await disabledExtensionRows(this.kdb)
      .select(sql<string>`count(*)`.as("n"))
      .executeTakeFirstOrThrow();
    return Number(r.n);
  }

  /** The plugins on by scope whose extension is disabled, newest change first. */
  private async disabledExtensions(): Promise<ExtensionDisabledView[]> {
    const rows = await disabledExtensionRows(this.kdb)
      .select(["i.id", "i.name", "i.display_name", "e.version", "e.updated_at"])
      .orderBy("e.updated_at", "desc")
      .orderBy("i.id")
      .limit(PLATFORM_INBOX_MAX_ITEMS)
      .execute();
    return rows.map((r) => ({
      item: { id: r.id, name: r.name, displayName: r.display_name },
      extension: { name: r.name, version: r.version },
      since: r.updated_at.toISOString(),
    }));
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
            .where("p.status", "in", [...LIVE_INSTALL_STATUSES]),
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
}

/**
 * The rows of {@link ExtensionDisabledView}: a live, usable, not builtin, not disabled item whose
 * scope is not `optional`, joined to its extension's install record (same name) that is disabled
 * and approved (a permission snapshot exists; an unapproved one is a permission confirmation).
 */
function disabledExtensionRows(kdb: KernelDb) {
  return kdb.db
    .selectFrom("catalog_items as i")
    .innerJoin("extension_installs as e", "e.name", "i.name")
    .where("i.deleted_at", "is", null)
    .where("i.builtin", "=", false)
    .where("i.disabled", "=", false)
    .where("i.awaiting_confirmation", "=", false)
    .where("i.scope", "<>", "optional")
    .where("e.desired_state", "=", "disabled")
    .where((eb) =>
      eb.exists(
        eb
          .selectFrom("extension_permission_snapshots as s")
          .select("s.plugin")
          .whereRef("s.plugin", "=", "e.name"),
      ),
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
