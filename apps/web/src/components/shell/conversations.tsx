"use client";

import type { SidebarConversations, SidebarFilter, SidebarGroup } from "@capybara-hq/design";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import {
  archiveConversation,
  CONVERSATIONS_CHANGED,
  type Conversation,
  type ConversationGroup,
  type ConversationSearch,
  deleteConversation,
  listConversationGroups,
  listConversations,
  NoCurrentOrgError,
  notifyConversationsChanged,
  renameConversation,
} from "../../lib/conversations";

/** The conversation id of a `/chat/<id>` route. */
export function activeIdFrom(pathname: string): string | undefined {
  const m = /^\/chat\/([^/]+)/.exec(pathname);
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1]);
}

type Loaded = {
  orgId: string;
  /** The view the groups belong to (`viewKey`): another view starts over. */
  view: string;
  groups: ConversationGroup[];
  next: string | null;
};

/** The view the list shows: the live or the archived list, narrowed by the kernel's search. */
type View = { archived: boolean; q: string; state: SidebarFilter["state"] };
const viewKey = (v: View) => JSON.stringify([v.archived, v.q.trim(), v.state]);
const searchOf = (v: View): ConversationSearch => ({
  q: v.q,
  state: v.state,
  ...(v.archived ? { archived: true } : {}),
});

/** The loaded list without one conversation; a group left empty goes too. */
function withoutRow(l: Loaded, id: string): Loaded {
  const groups = l.groups
    .map((g) => ({ ...g, conversations: g.conversations.filter((c) => c.id !== id) }))
    .filter((g) => g.conversations.length > 0 || g.more);
  return { ...l, groups };
}

/** Typing in the filter asks the kernel once the input settles (the rows narrow at once). */
const QUERY_SETTLE_MS = 200;

/** Pages of groups merged by agent id: a group already shown is not shown twice (cursor paging). */
function mergeGroups(a: ConversationGroup[], b: ConversationGroup[]): ConversationGroup[] {
  const seen = new Set(a.map((g) => g.agent.id));
  return [...a, ...b.filter((g) => !seen.has(g.agent.id))];
}

/**
 * A refresh (route, focus) merged into what the viewer has opened (review I1): the fresh first
 * page leads; per group its fresh rows come first, then the rows loaded before ("More") that the
 * fresh page lacks; groups loaded beyond page 1 ("More groups") stay after it, and the groups
 * cursor stays the loaded one while they do.
 */
export function mergeRefresh(old: Loaded, fresh: Loaded): Loaded {
  const before = new Map(old.groups.map((g) => [g.agent.id, g]));
  const groups = fresh.groups.map((g) => {
    const prev = before.get(g.agent.id);
    if (!prev) return g;
    const shown = new Set(g.conversations.map((c) => c.id));
    // Rows the fresh page lacks were loaded before (More, or pushed past page 1 by a newer one);
    // after them the old `more` holds, as it was computed after the old last row.
    const extra = prev.conversations.filter((c) => !shown.has(c.id));
    return extra.length === 0
      ? g
      : { ...g, conversations: [...g.conversations, ...extra], more: prev.more };
  });
  const freshIds = new Set(fresh.groups.map((g) => g.agent.id));
  // Groups the fresh page lacks: loaded with More groups, or pushed past page 1 by newer activity.
  const beyond = old.groups.filter((g) => !freshIds.has(g.agent.id));
  return {
    orgId: fresh.orgId,
    view: fresh.view,
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

/**
 * The sidebar's conversation section for the current user (web order §2.1): my conversations
 * grouped by agent, loaded on an org change, refreshed on a route into `/chat/*` (a new
 * conversation shows), when the window gets focus and after a row action. State lives in this
 * browser only.
 *
 * `orgId`: `undefined` while the session loads (the section shows its skeleton), `null` when the
 * account has no current org (an empty list), else the org. A refresh keeps the rows and groups
 * the viewer opened with More / More groups (`mergeRefresh`); an org or view change starts over.
 * Only the latest load applies.
 *
 * The filter (`q`, `state`) is sent to the kernel; the archived list loads `…/groups?archived=1`
 * and swaps the list in place. The archived count is the `archivedCount` of the latest load (the
 * kernel counts it whatever the view). Rename, archive and delete call the kernel and reload;
 * deleting the open conversation goes to `/chat`.
 *
 * Paging is by cursor (`next` → `after`): a group that gets new activity between two pages can
 * come back on a later page, so pages are merged by agent id.
 */
export function useConversationGroups(
  orgId: string | null | undefined,
  pathname: string,
  options: ConversationGroupsOptions = {},
): SidebarConversations {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [filter, setFilter] = useState<SidebarFilter>({ q: "", state: "all" });
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [archivedCount, setArchivedCount] = useState<{ orgId: string; n: number } | null>(null);
  // The q sent to the kernel: the filter's once typing settles.
  const [settledQ, setSettledQ] = useState("");
  useEffect(() => {
    if (filter.q === settledQ) return;
    const timer = setTimeout(() => setSettledQ(filter.q), QUERY_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [filter.q, settledQ]);
  const view = useMemo<View>(
    () => ({ archived: archivedOpen, q: settledQ, state: filter.state }),
    [archivedOpen, settledQ, filter.state],
  );
  const key = viewKey(view);
  // The org and view whose answer is awaited: an answer for another (after a switch) is dropped.
  const current = useRef<string | null | undefined>(orgId);
  current.current = orgId;
  const currentView = useRef(view);
  currentView.current = view;
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  // Only the latest load applies (m5): an older answer for the same org is dropped.
  const seq = useRef(0);
  const onError = useRef(options.onError);
  onError.current = options.onError;

  const load = useCallback(async (org: string) => {
    const mine = ++seq.current;
    const v = currentView.current;
    const k = viewKey(v);
    try {
      const page = await listConversationGroups(org, searchOf(v));
      if (current.current !== org || mine !== seq.current) return;
      if (page.archivedCount !== undefined) setArchivedCount({ orgId: org, n: page.archivedCount });
      const fresh = { orgId: org, view: k, groups: page.groups, next: page.next };
      setLoaded((l) =>
        l !== null && l.orgId === org && l.view === k ? mergeRefresh(l, fresh) : fresh,
      );
      setFailed(null);
    } catch {
      if (current.current !== org || mine !== seq.current) return;
      setFailed(org);
    }
  }, []);

  // A new org: drop the old org's groups, filter and archived view at once, then load.
  useEffect(() => {
    setFailed(null);
    setFilter({ q: "", state: "all" });
    setSettledQ("");
    setArchivedOpen(false);
    if (orgId === null || orgId === undefined) return;
    setLoaded((l) => (l?.orgId === orgId ? l : null));
  }, [orgId]);

  // A new org or view: load it (the old view's rows stay until the answer replaces them).
  // biome-ignore lint/correctness/useExhaustiveDependencies: key names the view load reads
  useEffect(() => {
    if (orgId === null || orgId === undefined) return;
    void load(orgId);
  }, [orgId, key, load]);

  // Into a conversation: refresh, so a conversation started elsewhere shows.
  const inChat = pathname.startsWith("/chat/") ? pathname : null;
  const lastChat = useRef(inChat);
  useEffect(() => {
    if (inChat === null || inChat === lastChat.current || orgId === null || orgId === undefined) {
      lastChat.current = inChat;
      return;
    }
    lastChat.current = inChat;
    void load(orgId);
  }, [inChat, orgId, load]);

  useEffect(() => {
    if (orgId === null || orgId === undefined) return;
    const onFocus = () => void load(orgId);
    window.addEventListener("focus", onFocus);
    // A title changed (generated or renamed), a conversation was archived or deleted.
    window.addEventListener(CONVERSATIONS_CHANGED, onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(CONVERSATIONS_CHANGED, onFocus);
    };
  }, [orgId, load]);

  const update = (org: string, k: string, f: (l: Loaded) => Loaded) =>
    setLoaded((l) => (l === null || l.orgId !== org || l.view !== k ? l : f(l)));

  const onMore = async (org: string, g: ConversationGroup) => {
    const last = g.conversations.at(-1);
    const v = currentView.current;
    try {
      const page = await listConversations(org, {
        agentId: g.agent.id,
        ...(last ? { after: last.id } : {}),
        ...searchOf(v),
      });
      update(org, viewKey(v), (l) => ({
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
      if (current.current === org) onError.current?.(e);
    }
  };

  const onMoreGroups = async (org: string, after: string) => {
    const v = currentView.current;
    try {
      const page = await listConversationGroups(org, { after, ...searchOf(v) });
      update(org, viewKey(v), (l) => ({
        ...l,
        groups: mergeGroups(l.groups, page.groups),
        next: page.next,
      }));
    } catch (e) {
      // The More groups row stays.
      if (current.current === org) onError.current?.(e);
    }
  };

  // Group ＋ opens a new conversation with that agent picked; it is created on first send.
  const onNew = (agentId: string) => router.push(`/chat?agent=${encodeURIComponent(agentId)}`);

  // The row actions: the kernel call, then every list reloads; a failure is reported, and
  // rename and delete reject so the row stays as it was.
  const act = async (
    call: (org: string) => Promise<unknown>,
    rethrow: boolean,
    removed?: string,
  ) => {
    try {
      if (orgId === null || orgId === undefined) throw new NoCurrentOrgError();
      await call(orgId);
      // A row that left this view goes at once; the refresh merges into what is left (a merge
      // keeps rows the fresh page lacks, so it would bring the row back).
      if (removed !== undefined)
        setLoaded((l) => (l === null || l.orgId !== orgId ? l : withoutRow(l, removed)));
      notifyConversationsChanged();
    } catch (e) {
      onError.current?.(e);
      if (rethrow) throw e;
    }
  };
  const actions = {
    filter: { ...filter, onChange: setFilter },
    archived: {
      count: orgId != null && archivedCount?.orgId === orgId ? archivedCount.n : 0,
      open: archivedOpen,
      onOpenChange: setArchivedOpen,
    },
    onRename: (id: string, title: string) => act((org) => renameConversation(org, id, title), true),
    onArchive: (id: string, archived: boolean) =>
      act((org) => archiveConversation(org, id, archived), false, id),
    onDelete: (id: string) =>
      act(
        async (org) => {
          await deleteConversation(org, id);
          // The open conversation is gone: back to a new one.
          if (activeIdFrom(pathnameRef.current) === id) router.push("/chat");
        },
        true,
        id,
      ),
  };

  const activeId = activeIdFrom(pathname);
  const noop = () => {};
  if (orgId === null || orgId === undefined) {
    return {
      state: orgId === null ? "ready" : "loading",
      groups: [],
      moreGroups: false,
      onMoreGroups: noop,
      onRetry: noop,
      ...actions,
      ...(activeId ? { activeId } : {}),
    };
  }
  // The rows of this org; a view switch keeps the old view's rows until its answer arrives
  // only when the view is the same (otherwise the section shows its skeleton).
  const mine = loaded?.orgId === orgId && loaded.view === key ? loaded : null;
  const state = failed === orgId && mine === null ? "error" : mine === null ? "loading" : "ready";
  const toRow = (c: Conversation) => ({
    id: c.id,
    title: c.title,
    startedAt: new Date(c.createdAt),
    href: `/chat/${encodeURIComponent(c.id)}`,
    activity: c.activity ?? null,
  });
  const groups: SidebarGroup[] = (mine?.groups ?? []).map((g) => ({
    agentId: g.agent.id,
    agentName: g.agent.name,
    conversations: g.conversations.map(toRow),
    more: g.more,
    onMore: () => void onMore(orgId, g),
    onNew: () => onNew(g.agent.id),
  }));
  const next = mine?.next ?? null;
  return {
    state,
    groups,
    // remembered collapsed groups are per org
    scope: orgId,
    moreGroups: next !== null,
    onMoreGroups: () => {
      if (next !== null) void onMoreGroups(orgId, next);
    },
    onRetry: () => {
      setFailed(null);
      void load(orgId);
    },
    ...actions,
    ...(activeId ? { activeId } : {}),
  };
}
