"use client";

import type { SidebarGroup, SidebarProps } from "@capybara-hq/design";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "../../i18n/navigation";
import {
  type Conversation,
  type ConversationGroup,
  createConversation,
  listConversationGroups,
  listConversations,
} from "../../lib/conversations";

/** The conversation id of a `/chat/<id>` route. */
export function activeIdFrom(pathname: string): string | undefined {
  const m = /^\/chat\/([^/]+)/.exec(pathname);
  return m?.[1] === undefined ? undefined : decodeURIComponent(m[1]);
}

type Loaded = {
  orgId: string;
  groups: ConversationGroup[];
  next: string | null;
};

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
    groups: [...groups, ...beyond],
    next: beyond.length > 0 ? old.next : fresh.next,
  };
}

export type ConversationGroupsOptions = {
  /** A failed action the viewer started (group ＋, More, More groups): AppFrame shows a toast. */
  onError?(e: unknown): void;
};

/**
 * The sidebar's conversation section for the current user (design spec §6.13): my conversations
 * grouped by agent, loaded on an org change, refreshed on a route into `/chat/*` (a new
 * conversation shows) and when the window gets focus. State lives in this browser only.
 *
 * `orgId`: `undefined` while the session loads (the section shows its skeleton), `null` when the
 * account has no current org (an empty list), else the org. A refresh keeps the rows and groups
 * the viewer opened with More / More groups (`mergeRefresh`); only an org change starts over.
 * Only the latest refresh for an org applies.
 *
 * Paging is by cursor (`next` → `after`): a group that gets new activity between two pages can
 * come back on a later page, so pages are merged by agent id.
 */
export function useConversationGroups(
  orgId: string | null | undefined,
  pathname: string,
  options: ConversationGroupsOptions = {},
): SidebarProps["conversations"] {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The org whose answer is awaited: an answer for another org (after a switch) is dropped.
  const current = useRef<string | null | undefined>(orgId);
  current.current = orgId;
  // Only the latest load applies (m5): an older answer for the same org is dropped.
  const seq = useRef(0);
  const onError = useRef(options.onError);
  onError.current = options.onError;
  // Group ＋ in flight, per agent: a second press does not post again.
  const creating = useRef(new Set<string>());

  const load = useCallback(async (org: string) => {
    const mine = ++seq.current;
    try {
      const page = await listConversationGroups(org);
      if (current.current !== org || mine !== seq.current) return;
      const fresh = { orgId: org, groups: page.groups, next: page.next };
      setLoaded((l) => (l !== null && l.orgId === org ? mergeRefresh(l, fresh) : fresh));
      setFailed(null);
    } catch {
      if (current.current !== org || mine !== seq.current) return;
      setFailed(org);
    }
  }, []);

  // A new org: drop the old org's groups at once, then load.
  useEffect(() => {
    setFailed(null);
    if (orgId === null || orgId === undefined) return;
    setLoaded((l) => (l?.orgId === orgId ? l : null));
    void load(orgId);
  }, [orgId, load]);

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
    return () => window.removeEventListener("focus", onFocus);
  }, [orgId, load]);

  const update = (org: string, f: (l: Loaded) => Loaded) =>
    setLoaded((l) => (l === null || l.orgId !== org ? l : f(l)));

  const onMore = async (org: string, g: ConversationGroup) => {
    const last = g.conversations.at(-1);
    try {
      const page = await listConversations(org, {
        agentId: g.agent.id,
        ...(last ? { after: last.id } : {}),
      });
      update(org, (l) => ({
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
    try {
      const page = await listConversationGroups(org, { after });
      update(org, (l) => ({ ...l, groups: mergeGroups(l.groups, page.groups), next: page.next }));
    } catch (e) {
      // The More groups row stays.
      if (current.current === org) onError.current?.(e);
    }
  };

  const onNew = async (org: string, agentId: string) => {
    if (creating.current.has(agentId)) return;
    creating.current.add(agentId);
    try {
      const { conversation } = await createConversation(org, agentId);
      router.push(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch (e) {
      // Nothing opens (the agent may be gone or private now); the group ＋ can be pressed again.
      onError.current?.(e);
    } finally {
      creating.current.delete(agentId);
    }
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
      ...(activeId ? { activeId } : {}),
    };
  }
  const mine = loaded?.orgId === orgId ? loaded : null;
  const state = failed === orgId && mine === null ? "error" : mine === null ? "loading" : "ready";
  const toRow = (c: Conversation) => ({
    id: c.id,
    title: c.title,
    startedAt: new Date(c.createdAt),
    href: `/chat/${encodeURIComponent(c.id)}`,
  });
  const groups: SidebarGroup[] = (mine?.groups ?? []).map((g) => ({
    agentId: g.agent.id,
    agentName: g.agent.name,
    conversations: g.conversations.map(toRow),
    more: g.more,
    onMore: () => void onMore(orgId, g),
    onNew: () => void onNew(orgId, g.agent.id),
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
    ...(activeId ? { activeId } : {}),
  };
}
