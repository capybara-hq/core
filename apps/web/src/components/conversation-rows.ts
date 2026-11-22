"use client";

import type {
  AvatarValue,
  ConversationListActions,
  ConversationListItem,
} from "@capybara-hq/design";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useRouter } from "../i18n/navigation";
import { avatarValue } from "../lib/agents";
import { archiveConversation, type Conversation, deleteConversation } from "../lib/conversations";
import { agentsQuery } from "../lib/query/agents";
import { retryOnMountOf } from "../lib/query/client";
import { renameWithRow } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { conversationGroupsQuery } from "../lib/query/shell";
import { HOME_PATH } from "../lib/routes";
import { activeIdFrom } from "./shell/conversations";

/** An agent as a conversation row draws it. */
export type RowAgent = { id: string; name: string; avatar: AvatarValue };

/**
 * The agents of my conversations, by id, for rows read by time (`GET …/conversations` carries only
 * `agentId`): first the sidebar's groups (the layout's own read; every agent of my newest
 * conversations is among its groups, which are ordered by latest activity), then, only when a row's
 * agent is not there (an older row past the groups' first page), the agents list. `agents` is the
 * groups' agents in their order (the conversations page's chips).
 */
export function useConversationAgents(
  orgId: string,
  agentIds: readonly string[],
  enabled = true,
): { byId: Map<string, RowAgent>; agents: RowAgent[] } {
  const groupsQ = conversationGroupsQuery(orgId);
  const groups = useQuery({
    ...groupsQ,
    enabled,
    retryOnMount: retryOnMountOf(groupsQ.queryKey),
  }).data;
  const agents: RowAgent[] = (groups?.groups ?? []).map((g) => ({
    id: g.agent.id,
    name: g.agent.name,
    avatar: g.agent.profile ? avatarValue(g.agent, orgId) : null,
  }));
  const byId = new Map(agents.map((a) => [a.id, a]));
  const missing = groups !== undefined && agentIds.some((id) => !byId.has(id));
  const listQ = agentsQuery(orgId);
  const list = useQuery({ ...listQ, enabled: enabled && missing }).data;
  for (const a of list?.agents ?? []) {
    if (byId.has(a.id)) continue;
    byId.set(a.id, { id: a.id, name: a.definition.name, avatar: avatarValue(a, orgId) });
  }
  return { byId, agents };
}

/** A conversation as a by-time row; an agent not known yet reads as the agent's id. */
export function conversationRow(
  c: Conversation,
  agents: ReadonlyMap<string, RowAgent>,
): ConversationListItem {
  const agent = agents.get(c.agentId);
  return {
    id: c.id,
    title: c.title,
    startedAt: new Date(c.createdAt),
    updatedAt: c.updatedAt,
    href: `/chat/${encodeURIComponent(c.id)}`,
    agent: { name: agent?.name ?? c.agentId, avatar: agent?.avatar ?? null },
    activity: c.activity,
  };
}

/**
 * A row's actions (rename, archive, delete) for the by-time lists: each call invalidates every view
 * of my conversations (the sidebar's groups and the by-time pages share the prefix). Deleting the
 * open conversation goes to the new conversation (`/`). A failure is reported through `onError`;
 * rename and delete reject so their dialog stays open.
 */
export function useConversationRowActions(
  orgId: string,
  pathname: string,
  onError?: (e: unknown) => void,
): ConversationListActions {
  const qc = useQueryClient();
  const router = useRouter();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const report = useRef(onError);
  report.current = onError;
  const invalidates = () => [keys.org(orgId).conversationGroupsAll()];
  const rename = useAppMutation({
    fn: (v: { id: string; title: string }) => renameWithRow(qc, orgId, v.id, v.title),
    invalidates,
  });
  const archive = useAppMutation({
    fn: (v: { id: string; archived: boolean }) => archiveConversation(orgId, v.id, v.archived),
    invalidates,
  });
  const remove = useAppMutation({
    fn: async (id: string) => {
      await deleteConversation(orgId, id);
      if (activeIdFrom(pathnameRef.current) === id) router.push(HOME_PATH);
    },
    invalidates,
  });
  const run = async (p: Promise<unknown>, rethrow: boolean) => {
    try {
      await p;
    } catch (e) {
      report.current?.(e);
      if (rethrow) throw e;
    }
  };
  return {
    onRename: (id, title) => run(rename.mutateAsync({ id, title }), true),
    onArchive: (id, archived) => run(archive.mutateAsync({ id, archived }), false),
    onDelete: (id) => run(remove.mutateAsync(id), true),
  };
}
