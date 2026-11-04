"use client";

import type { SidebarConversations, SidebarFilter, SidebarGroup } from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import { avatarValue } from "../../lib/agents";
import {
  archiveConversation,
  type Conversation,
  type ConversationGroup,
  type ConversationGroupsPage,
  type ConversationSearch,
  deleteConversation,
} from "../../lib/conversations";
import { agentsQuery } from "../../lib/query/agents";
import { retryOnMountOf } from "../../lib/query/client";
import { renameWithRow } from "../../lib/query/conversation";
import { keys } from "../../lib/query/keys";
import { useAppMutation } from "../../lib/query/mutation";
import {
  conversationGroupsQuery,
  groupsViewKey,
  moreConversationsQuery,
  moreGroupsQuery,
} from "../../lib/query/shell";

/** The conversation id of a `/chat/<id>` route. */
export function activeIdFrom(pathname: string): string | undefined {
  const m = /^\/chat\/([^/]+)/.exec(pathname);
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1]);
}

type Loaded = {
  orgId: string;
  /** When the first page it was built on was read (`dataUpdatedAt`): a newer one merges into it. */
  base?: number | undefined;
  /** The view the groups belong to (`viewKey`): a refresh merges only into the same view. */
  view: string;
  /** The archived list (else the live one). */
  archived: boolean;
  groups: ConversationGroup[];
  next: string | null;
};
const EMPTY_LOADED: Loaded = { orgId: "", view: "", archived: false, groups: [], next: null };

/** The view the list shows: the live or the archived list, narrowed by the kernel's search. */
type View = { archived: boolean; q: string; state: SidebarFilter["state"] };
const searchOf = (v: View): ConversationSearch => ({
  q: v.q,
  state: v.state,
  ...(v.archived ? { archived: true } : {}),
});
const viewKey = (v: View) => groupsViewKey(searchOf(v));

/**
 * The loaded list without one conversation; a group left empty goes too (also one with `more`:
 * the reload brings it back with its next rows).
 */
function withoutRow(l: Loaded, id: string): Loaded {
  const groups = l.groups
    .map((g) => ({ ...g, conversations: g.conversations.filter((c) => c.id !== id) }))
    .filter((g) => g.conversations.length > 0);
  return { ...l, groups };
}

/** The sidebar's defaults: the view the `(app)` layout reads on the server. */
const DEFAULT_VIEW: { filter: SidebarFilter; archivedOpen: boolean; settledQ: string } = {
  filter: { q: "", state: "all" },
  archivedOpen: false,
  settledQ: "",
};

/** Typing in the filter asks the kernel once the input settles (the rows narrow at once). */
const QUERY_SETTLE_MS = 200;

/** Pages of groups merged by agent id: a group already shown is not shown twice (cursor paging). */
function mergeGroups(a: ConversationGroup[], b: ConversationGroup[]): ConversationGroup[] {
  const seen = new Set(a.map((g) => g.agent.id));
  return [...a, ...b.filter((g) => !seen.has(g.agent.id))];
}

/** Rows sort by `updatedAt` then `id`, both descending (the kernel's order within a group). */
const rowAfter = (c: Conversation, last: Conversation) =>
  c.updatedAt < last.updatedAt || (c.updatedAt === last.updatedAt && c.id < last.id);
/** Groups sort by `latestAt` then agent id, both descending (the kernel's group order). */
const groupAfter = (g: ConversationGroup, last: ConversationGroup) =>
  g.latestAt < last.latestAt || (g.latestAt === last.latestAt && g.agent.id < last.agent.id);

/**
 * A refresh (route, focus, a row action) merged into what the viewer has opened (review I1): the
 * fresh first page leads and is the truth for the range it covers, so a row or group that left
 * the view (archived, deleted, stopped running) goes. Per group, the rows loaded before ("More")
 * stay only when the group has more than the fresh page and they sort after its last row; groups
 * loaded beyond page 1 ("More groups") likewise stay only after the fresh page's last group, and
 * the groups cursor stays the loaded one while they do.
 */
export function mergeRefresh(old: Loaded, fresh: Loaded): Loaded {
  const before = new Map(old.groups.map((g) => [g.agent.id, g]));
  const groups = fresh.groups.map((g) => {
    const prev = before.get(g.agent.id);
    const last = g.conversations.at(-1);
    if (!prev || !g.more || last === undefined) return g;
    const shown = new Set(g.conversations.map((c) => c.id));
    // Paged-in rows past the fresh page; after them the old `more` holds, as it was computed
    // after the old last row.
    const extra = prev.conversations.filter((c) => !shown.has(c.id) && rowAfter(c, last));
    return extra.length === 0
      ? g
      : { ...g, conversations: [...g.conversations, ...extra], more: prev.more };
  });
  const freshIds = new Set(fresh.groups.map((g) => g.agent.id));
  const lastGroup = fresh.groups.at(-1);
  // Groups loaded with More groups past the fresh page (only when there are more groups at all).
  const beyond =
    fresh.next === null || lastGroup === undefined
      ? []
      : old.groups.filter((g) => !freshIds.has(g.agent.id) && groupAfter(g, lastGroup));
  return {
    ...fresh,
    groups: [...groups, ...beyond],
    next: beyond.length > 0 ? old.next : fresh.next,
  };
}

export type ConversationGroupsOptions = {
  /**
   * A failed action the viewer started (group ＋, More, More groups, rename, archive, delete):
   * AppFrame shows a toast.
   */
  onError?(e: unknown): void;
};

/** The periodic reload of the groups (state dots of background conversations). */
const GROUPS_POLL_MS = 30_000;

/** The archived flag of a view key (`groupsViewKey`). */
const archivedOfKey = (k: unknown): boolean =>
  typeof k === "string" && k !== "default" && (JSON.parse(k) as [boolean])[0] === true;

/** The sidebar of an account without a current org: an empty list, nothing to read. */
export function noOrgConversations(pathname: string): SidebarConversations {
  const activeId = activeIdFrom(pathname);
  const noop = () => {};
  return {
    state: "ready",
    groups: [],
    moreGroups: false,
    onMoreGroups: noop,
    onRetry: noop,
    filter: { q: "", state: "all", onChange: noop },
    archived: { count: 0, open: false, onOpenChange: noop },
    onRename: async () => {},
    onArchive: async () => {},
    onDelete: async () => {},
    ...(activeId ? { activeId } : {}),
  };
}

/**
 * The sidebar's conversation section for the current user (web order §2.1): my conversations
 * grouped by agent, read through the query cache (web query cache spec §6). The first page of each
 * view is a query (`conversationGroupsQuery`, the layout prefetches the default one); it is read
 * again every 30 s, on a path change while stale (AppFrame) and when a write invalidates it. State
 * lives in this browser only.
 *
 * What the viewer opened with More / More groups past the first page stays local and is merged
 * into each fresh first page (`mergeRefresh`); an org or view change starts over.
 *
 * The filter (`q`, `state`) is sent to the kernel; the archived list loads `…/groups?archived=1`
 * and swaps the list in place. The archived count is the `archivedCount` of the shown answer (the
 * kernel counts it whatever the view). Rename, archive and delete call the kernel and invalidate
 * every view; deleting the open conversation goes to `/chat`.
 *
 * Paging is by cursor (`next` → `after`): a group that gets new activity between two pages can
 * come back on a later page, so pages are merged by agent id.
 */
export function useConversationGroups(
  orgId: string,
  pathname: string,
  options: ConversationGroupsOptions = {},
): SidebarConversations {
  const router = useRouter();
  const qc = useQueryClient();
  const [viewState, setViewState] = useState(DEFAULT_VIEW);
  // Rows and groups paged in past the first page, for one view.
  const [paged, setPaged] = useState<Loaded | null>(null);
  // The filter, archived view and paged rows belong to one org: another org starts over.
  const [scope, setScope] = useState(orgId);
  if (scope !== orgId) {
    setScope(orgId);
    setViewState(DEFAULT_VIEW);
    setPaged(null);
  }
  const { filter, archivedOpen, settledQ } = viewState;
  const setView = (patch: Partial<typeof DEFAULT_VIEW>) =>
    setViewState((v) => ({ ...v, ...patch }));
  const setFilter = (f: SidebarFilter) => setView({ filter: f });
  const setArchivedOpen = (open: boolean) => setView({ archivedOpen: open });
  // The q sent to the kernel: the filter's once typing settles.
  useEffect(() => {
    if (filter.q === settledQ) return;
    const timer = setTimeout(
      () => setViewState((v) => ({ ...v, settledQ: filter.q })),
      QUERY_SETTLE_MS,
    );
    return () => clearTimeout(timer);
  }, [filter.q, settledQ]);
  const view = useMemo<View>(
    () => ({ archived: archivedOpen, q: settledQ, state: filter.state }),
    [archivedOpen, settledQ, filter.state],
  );
  const key = viewKey(view);
  const query = conversationGroupsQuery(orgId, searchOf(view));
  const q = useQuery({
    ...query,
    retryOnMount: retryOnMountOf(query.queryKey),
    refetchInterval: GROUPS_POLL_MS,
    // While a new filter of the same list loads, the previous filter's rows stay shown (the
    // design narrows them locally); the live and the archived list never stand in for each other.
    placeholderData: (prev, prevQuery) =>
      prevQuery !== undefined &&
      prevQuery.queryKey[1] === orgId &&
      archivedOfKey(prevQuery.queryKey.at(-1)) === view.archived
        ? prev
        : undefined,
  });
  const fresh: Loaded | null =
    q.data === undefined || q.isPlaceholderData
      ? null
      : {
          orgId,
          base: q.dataUpdatedAt,
          view: key,
          archived: view.archived,
          groups: q.data.groups,
          next: q.data.next,
        };
  const own = paged !== null && paged.orgId === orgId && paged.view === key ? paged : null;
  // The paged rows hold the first page they were built on; a newer first page merges into them.
  const mine: Loaded | null =
    fresh === null
      ? q.data === undefined
        ? null
        : { orgId, view: "", archived: view.archived, groups: q.data.groups, next: q.data.next }
      : own === null
        ? fresh
        : own.base === fresh.base
          ? own
          : { ...mergeRefresh(own, fresh), base: fresh.base };
  // What is shown, for the paging handlers (an answer for another view is dropped).
  const shown = useRef(mine);
  shown.current = mine;
  const currentKey = useRef(key);
  currentKey.current = key;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const onError = useRef(options.onError);
  onError.current = options.onError;

  // `shown` carries the time of the first page it stands for (merged or not).
  const update = (k: string, f: (l: Loaded) => Loaded) => {
    const l = shown.current;
    if (l === null || l.view !== k || currentKey.current !== k) return;
    setPaged(f(l));
  };

  const onMore = async (g: ConversationGroup) => {
    const last = g.conversations.at(-1);
    const k = key;
    try {
      const page = await qc.fetchQuery(
        moreConversationsQuery(orgId, {
          agentId: g.agent.id,
          ...(last ? { after: last.id } : {}),
          ...searchOf(view),
        }),
      );
      update(k, (l) => ({
        ...l,
        groups: l.groups.map((x) =>
          x.agent.id !== g.agent.id
            ? x
            : {
                ...x,
                conversations: [
                  ...x.conversations,
                  ...page.conversations.filter((c) => !x.conversations.some((y) => y.id === c.id)),
                ],
                more: page.next !== null,
              },
        ),
      }));
    } catch (e) {
      // The More row stays; the viewer can try again.
      onError.current?.(e);
    }
  };

  const onMoreGroups = async (after: string) => {
    const k = key;
    try {
      const page = await qc.fetchQuery(moreGroupsQuery(orgId, { after, ...searchOf(view) }));
      update(k, (l) => ({ ...l, groups: mergeGroups(l.groups, page.groups), next: page.next }));
    } catch (e) {
      // The More groups row stays.
      onError.current?.(e);
    }
  };

  // Group ＋ opens a new conversation with that agent picked; it is created on first send.
  const onNew = (agentId: string) => router.push(`/chat?agent=${encodeURIComponent(agentId)}`);

  // A row that left this view goes at once, from the cached first page and from the paged rows (a
  // merge keeps rows the fresh page lacks, so it would bring the row back); every view is then
  // read again.
  const dropRow = (id: string) => {
    const l = shown.current;
    qc.setQueryData<ConversationGroupsPage>(query.queryKey, (page) =>
      page === undefined
        ? page
        : { ...page, groups: withoutRow({ ...EMPTY_LOADED, groups: page.groups }, id).groups },
    );
    // Built on the page just written: the next render shows it as it is.
    const base = qc.getQueryState(query.queryKey)?.dataUpdatedAt;
    if (l !== null && l.view === key) setPaged({ ...withoutRow(l, id), base });
  };
  const invalidates = () => [keys.org(orgId).conversationGroupsAll()];
  // An open conversation's row takes the title first: its stream's `changed: title` for this
  // rename then finds it unchanged and reads the groups no second time.
  const rename = useAppMutation({
    fn: (v: { id: string; title: string }) => renameWithRow(qc, orgId, v.id, v.title),
    invalidates,
  });
  // The row goes as soon as the kernel answers, before the views are read again.
  const archive = useAppMutation({
    fn: async (v: { id: string; archived: boolean }) => {
      await archiveConversation(orgId, v.id, v.archived);
      dropRow(v.id);
    },
    invalidates,
  });
  const remove = useAppMutation({
    fn: async (id: string) => {
      await deleteConversation(orgId, id);
      dropRow(id);
      // The open conversation is gone: back to a new one.
      if (activeIdFrom(pathnameRef.current) === id) router.push("/chat");
    },
    invalidates,
  });
  // A failure is reported; rename and delete reject so the row stays as it was.
  const report = async (p: Promise<unknown>, rethrow: boolean) => {
    try {
      await p;
    } catch (e) {
      onError.current?.(e);
      if (rethrow) throw e;
    }
  };

  const activeId = activeIdFrom(pathname);
  // Loading shows the skeleton: the first answer of this list (live or archived) is on its way.
  const state = mine !== null ? "ready" : q.error !== null ? "error" : "loading";
  const toRow = (c: Conversation) => ({
    id: c.id,
    title: c.title,
    startedAt: new Date(c.createdAt),
    href: `/chat/${encodeURIComponent(c.id)}`,
    activity: c.activity ?? null,
  });
  // The group titles' avatars come from the agents already cached (the sidebar reads none of its
  // own); a group whose agent is not cached shows the initial of its name.
  const cachedAgents = useQuery({ ...agentsQuery(orgId), enabled: false }).data?.agents;
  const agentOf = new Map((cachedAgents ?? []).map((a) => [a.id, a]));
  const groups: SidebarGroup[] = (mine?.groups ?? []).map((g) => {
    const a = agentOf.get(g.agent.id);
    return {
      agentId: g.agent.id,
      agentName: g.agent.name,
      agentAvatar: a ? avatarValue(a, orgId) : null,
      conversations: g.conversations.map(toRow),
      more: g.more,
      onMore: () => void onMore(g),
      onNew: () => onNew(g.agent.id),
    };
  });
  const next = mine?.next ?? null;
  return {
    state,
    groups,
    // remembered collapsed groups are per org
    scope: orgId,
    moreGroups: next !== null,
    onMoreGroups: () => {
      if (next !== null) void onMoreGroups(next);
    },
    onRetry: () => void q.refetch(),
    filter: { ...filter, onChange: setFilter },
    archived: {
      count: q.data?.archivedCount ?? 0,
      open: archivedOpen,
      onOpenChange: setArchivedOpen,
    },
    onRename: (id: string, title: string) => report(rename.mutateAsync({ id, title }), true),
    onArchive: (id: string, archived: boolean) =>
      report(archive.mutateAsync({ id, archived }), false),
    onDelete: (id: string) => report(remove.mutateAsync(id), true),
    ...(activeId ? { activeId } : {}),
  };
}
