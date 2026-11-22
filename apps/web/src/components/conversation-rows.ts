"use client";

import type {
  AvatarValue,
  ConversationListActions,
  ConversationListItem,
} from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useRef } from "react";
import { useRouter } from "../i18n/navigation";
import { avatarValue } from "../lib/agents";
import {
  archiveConversation,
  type ConversationListRow,
  deleteConversation,
} from "../lib/conversations";
import { renameWithRow } from "../lib/query/conversation";
import { keys } from "../lib/query/keys";
import { useAppMutation } from "../lib/query/mutation";
import { HOME_PATH } from "../lib/routes";
import { activeIdFrom } from "./shell/conversations";

/** An agent as a conversation row draws it. */
export type RowAgent = { id: string; name: string; avatar: AvatarValue };

/** A conversation as a by-time row; its agent comes with the row (null reads as the agent's id). */
export function conversationRow(c: ConversationListRow, orgId: string): ConversationListItem {
  return {
    id: c.id,
    title: c.title,
    startedAt: new Date(c.createdAt),
    updatedAt: c.updatedAt,
    href: `/chat/${encodeURIComponent(c.id)}`,
    agent: c.agent
      ? { name: c.agent.name, avatar: avatarValue(c.agent, orgId) }
      : { name: c.agentId, avatar: null },
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
