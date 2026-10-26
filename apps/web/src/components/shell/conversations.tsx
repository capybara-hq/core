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
 * The sidebar's conversation section for the current user (design spec §6.13): my conversations
 * grouped by agent, loaded on an org change, on a route into `/chat/*` (a new conversation shows)
 * and when the window gets focus. State lives in this browser only.
 *
 * Paging is by cursor (`next` → `after`): a group that gets new activity between two pages can
 * come back on a later page, so pages are merged by agent id.
 */
export function useConversationGroups(
  orgId: string | null,
  pathname: string,
): SidebarProps["conversations"] {
  const router = useRouter();
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The org whose answer is awaited: an answer for another org (after a switch) is dropped.
  const current = useRef<string | null>(orgId);
  current.current = orgId;

  const load = useCallback(async (org: string) => {
    try {
      const page = await listConversationGroups(org);
      if (current.current !== org) return;
      setLoaded({ orgId: org, groups: page.groups, next: page.next });
      setFailed(null);
    } catch {
      if (current.current !== org) return;
      setFailed(org);
    }
  }, []);

  // A new org: drop the old org's groups at once, then load.
  useEffect(() => {
    setFailed(null);
    if (orgId === null) return;
    setLoaded((l) => (l?.orgId === orgId ? l : null));
    void load(orgId);
  }, [orgId, load]);

  // Into a conversation: reload, so a conversation started elsewhere shows.
  const inChat = pathname.startsWith("/chat/") ? pathname : null;
  const lastChat = useRef(inChat);
  useEffect(() => {
    if (inChat === null || inChat === lastChat.current || orgId === null) {
      lastChat.current = inChat;
      return;
    }
    lastChat.current = inChat;
    void load(orgId);
  }, [inChat, orgId, load]);

  useEffect(() => {
    if (orgId === null) return;
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
    } catch {
      // The More row stays; the viewer can try again.
    }
  };

  const onMoreGroups = async (org: string, after: string) => {
    try {
      const page = await listConversationGroups(org, { after });
      update(org, (l) => ({ ...l, groups: mergeGroups(l.groups, page.groups), next: page.next }));
    } catch {
      // The More groups row stays.
    }
  };

  const onNew = async (org: string, agentId: string) => {
    try {
      const { conversation } = await createConversation(org, agentId);
      router.push(`/chat/${encodeURIComponent(conversation.id)}`);
    } catch {
      // Nothing opens; the group ＋ can be pressed again.
    }
  };

  const activeId = activeIdFrom(pathname);
  const noop = () => {};
  if (orgId === null) {
    return {
      state: "ready",
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
