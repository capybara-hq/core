import { type QueryClient, replaceEqualDeep } from "@tanstack/react-query";
import type { ConversationPermissions } from "../permissions";
import { keys } from "./keys";

/**
 * Tab-local confirmation metadata of conversation permissions (permission profiles, Task 10
 * Important 2): the lowest root revision an authoritative read must reach before the page shows
 * the profile as current and lets its owner change it again. A successful PATCH (its `{revision}`)
 * and each root `permission_profile_changed` event raise it; neither builds a view. It lives per
 * query client, account, org and root above any composer or route remount, and
 * {@link clearPermissionWatermarks} drops it with the session (`resetSession`). Never persisted,
 * never sent to the server.
 */
export type PermissionWatermarkScope = { accountId: string; orgId: string; rootId: string };

type Store = { required: Map<string, number>; listeners: Set<() => void> };
const stores = new WeakMap<QueryClient, Store>();

function storeOf(qc: QueryClient): Store {
  let s = stores.get(qc);
  if (s === undefined) {
    s = { required: new Map(), listeners: new Set() };
    stores.set(qc, s);
  }
  return s;
}

const scopeKey = (s: PermissionWatermarkScope) => `${s.accountId}/${s.orgId}/${s.rootId}`;
const notify = (s: Store) => {
  for (const fn of [...s.listeners]) fn();
};

/** Raise the root's required revision (monotonic: a lower revision never lowers it). */
export function raisePermissionWatermark(
  qc: QueryClient,
  scope: PermissionWatermarkScope,
  revision: number,
): void {
  const s = storeOf(qc);
  const k = scopeKey(scope);
  if ((s.required.get(k) ?? -1) >= revision) return;
  s.required.set(k, revision);
  notify(s);
}

/** The root's required revision, or undefined when nothing raised one in this session. */
export function permissionWatermark(
  qc: QueryClient,
  scope: PermissionWatermarkScope,
): number | undefined {
  return storeOf(qc).required.get(scopeKey(scope));
}

/** Drop every watermark of the session (an org switch or a sign-out, with the cache). */
export function clearPermissionWatermarks(qc: QueryClient): void {
  const s = storeOf(qc);
  if (s.required.size === 0) return;
  s.required.clear();
  notify(s);
}

/**
 * Calls `fn` whenever a watermark of `qc` moves (raised or cleared); returns the unsubscribe
 * (for `useSyncExternalStore` in a client component).
 */
export function subscribePermissionWatermarks(qc: QueryClient, fn: () => void): () => void {
  const s = storeOf(qc);
  s.listeners.add(fn);
  return () => {
    s.listeners.delete(fn);
  };
}

/**
 * Whether an authoritative view confirms the root's state: at or above the watermark (a higher
 * revision is valid, equality is not required). Query flags never decide this.
 */
export const permissionsConfirmed = (
  view: Pick<ConversationPermissions, "revision"> | undefined,
  required: number | undefined,
): boolean => view !== undefined && view.revision >= (required ?? -1);

const isView = (v: unknown): v is ConversationPermissions =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as ConversationPermissions).revision === "number" &&
  typeof (v as ConversationPermissions).rootConversationId === "string";

/**
 * The permissions query's structural sharing: a read answering a lower revision of the same root
 * than the cached view (a slow read that started before a newer one landed) never replaces it.
 */
export function keepNewerPermissions(old: unknown, next: unknown): unknown {
  if (
    isView(old) &&
    isView(next) &&
    old.rootConversationId === next.rootConversationId &&
    old.revision > next.revision
  )
    return old;
  return replaceEqualDeep(old, next);
}

/**
 * The cached owner permission keys whose view names `rootId` (the root's own and any open
 * child's that inherits it), plus the root's own key.
 */
export function permissionKeysOfRoot(
  qc: QueryClient,
  orgId: string,
  rootId: string,
): (readonly unknown[])[] {
  const own = keys.org(orgId).conversation(rootId).permissions();
  const found: (readonly unknown[])[] = [own];
  for (const [key, data] of qc.getQueriesData({ queryKey: keys.org(orgId).conversationsAll() })) {
    if (key[4] !== "permissions" || key.length !== 5 || key[3] === rootId) continue;
    if (isView(data) && data.rootConversationId === rootId) found.push(key);
  }
  return found;
}

/**
 * Read the views naming `rootId` again. A first read in flight may predate the change and
 * `invalidateQueries` would join it, so it is cancelled first, then read again (the conversation
 * stream's discipline). Inactive keys (no enabled observer, e.g. a viewer's) read nothing.
 */
export function refreshPermissionViews(
  qc: QueryClient,
  orgId: string,
  rootId: string,
  /** Keys read again too (once each), e.g. a viewed child's before its view names the root. */
  also: readonly (readonly unknown[])[] = [],
): void {
  const seen = new Set<string>();
  for (const queryKey of [...permissionKeysOfRoot(qc, orgId, rootId), ...also]) {
    const id = JSON.stringify(queryKey);
    if (seen.has(id)) continue;
    seen.add(id);
    const firstRead =
      qc.isFetching({ queryKey, exact: true, predicate: (q) => q.state.data === undefined }) > 0;
    if (!firstRead) void qc.invalidateQueries({ queryKey, exact: true });
    else
      void qc
        .cancelQueries({ queryKey, exact: true })
        .then(() => qc.invalidateQueries({ queryKey, exact: true }));
  }
}
