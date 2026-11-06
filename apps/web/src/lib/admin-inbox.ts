import { apiFetch } from "./api";
import type { CatalogItem, CatalogRequest, LocalizedName } from "./catalog";

/**
 * An open failure of the plugin scope sync: its last attempt to turn the plugin on in the org, off,
 * or to install the dependencies a platform update added (`dependencies`) failed, and the org
 * still differs from the plugin's scope.
 */
export interface ScopeSyncFailure {
  item: { id: string; name: string; displayName: LocalizedName | null };
  org: { id: string; name: string };
  op: "install" | "uninstall" | "dependencies";
  code: string;
  message: string;
  failedAt: string;
}

/**
 * The latest platform components migration run when it needs a look: finished with plugins whose
 * components could not be written (`<name>@<version>`), or `stuck` (unfinished an hour after its
 * start).
 */
export interface MigrationRun {
  id: string;
  startedAt: string;
  finishedAt: string | null;
  stuck: boolean;
  itemsFailed: string[];
}

/**
 * The super admin's inbox (kernel `GET /api/v1/admin/inbox`, `inbox/platform-inbox.service.ts`):
 * what waits on the platform, newest first, at most 100 (`truncated`: more; `total`: how many in
 * all). Nothing is decided here: each item links to the page where it is acted on.
 */
export type PlatformInboxItem =
  | { type: "catalog_request"; id: string; createdAt: string; request: CatalogRequest }
  | { type: "permission_confirmation"; id: string; createdAt: string; item: CatalogItem }
  | { type: "scope_sync_failed"; id: string; createdAt: string; failure: ScopeSyncFailure }
  | { type: "platform_migration"; id: string; createdAt: string; run: MigrationRun };

export interface PlatformInboxView {
  items: PlatformInboxItem[];
  truncated: boolean;
  total: number;
}

export const getPlatformInbox = () => apiFetch<PlatformInboxView>("/api/v1/admin/inbox");

/** How many items wait in the super admin's inbox (`GET /admin/inbox/count`). */
export const getPlatformInboxCount = () => apiFetch<{ total: number }>("/api/v1/admin/inbox/count");

/**
 * Where an item is acted on: requests and permission confirmations in the admin 插件 page's
 * 待确认 tab, a failed scope sync on its plugin's page (a scope change there syncs it again), a
 * migration run on the plugin list.
 */
export function platformInboxHref(item: PlatformInboxItem): string {
  switch (item.type) {
    case "catalog_request":
    case "permission_confirmation":
      return "/admin/plugins/pending";
    case "scope_sync_failed":
      return `/admin/plugins/${encodeURIComponent(item.failure.item.id)}`;
    case "platform_migration":
      return "/admin/plugins";
  }
}
