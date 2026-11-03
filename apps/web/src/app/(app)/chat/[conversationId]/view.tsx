"use client";

import { ConversationPage } from "@capybara-hq/design";
import { type DehydratedState, hashKey, hydrate, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useConversationPage } from "../../../../components/conversation/ConversationView";
import { useSession } from "../../../../components/shell/session";
import { reviveDehydrated } from "../../../../lib/query/client";
import {
  attachmentLimitsQuery,
  connectorsQuery,
  contributionsQuery,
  conversationQuery,
  eventsQuery,
  filesQuery,
  invocableSkillsQuery,
  queueQuery,
  sandboxQuery,
  subagentsQuery,
  toolInfoQuery,
  usageQuery,
} from "../../../../lib/query/conversation";
import { membersQuery } from "../../../../lib/query/members";
import type { ConversationSnapshot } from "../../../../lib/server/conversation";

/**
 * `/chat/[conversationId]`: a conversation of the current org (ConversationPage), painted from the
 * server's snapshot (`page.tsx`); the stream opens at its last seq. Keyed by the conversation id,
 * so nothing of one conversation (panel, queue, drafts, picks) shows under another.
 */
export default function ChatView({
  orgId,
  conversationId,
  initial,
}: {
  orgId: string;
  conversationId: string;
  initial: ConversationSnapshot;
}) {
  return (
    <Conversation
      key={conversationId}
      orgId={orgId}
      conversationId={conversationId}
      initial={initial}
    />
  );
}

function Conversation({
  orgId,
  conversationId,
  initial,
}: {
  orgId: string;
  conversationId: string;
  initial: ConversationSnapshot;
}) {
  // The snapshot's pieces go into the cache (until the route table prefetches them), as the
  // layout's hydration would: a piece the kernel failed or refused (`null`) is a failed query the
  // view does not read again on mount (R5).
  const qc = useQueryClient();
  const session = useSession();
  useState(() => {
    const at = Date.now();
    const queries: DehydratedState["queries"] = [];
    const put = (queryKey: readonly unknown[], data: unknown, failed = data === null) => {
      if (qc.getQueryState(queryKey) !== undefined) return;
      // query-exempt: the snapshot as a dehydrated entry, until the route entry prefetches it
      queries.push({
        queryKey,
        queryHash: hashKey(queryKey),
        dehydratedAt: at,
        state: {
          data: failed ? undefined : data,
          dataUpdateCount: failed ? 0 : 1,
          dataUpdatedAt: failed ? 0 : at,
          error: failed ? ({ status: 500, code: "internal", message: "" } as never) : null,
          errorUpdateCount: failed ? 1 : 0,
          errorUpdatedAt: failed ? at : 0,
          fetchFailureCount: failed ? 1 : 0,
          fetchFailureReason: null,
          fetchMeta: null,
          isInvalidated: false,
          status: failed ? "error" : "success",
          fetchStatus: "idle",
        },
      });
    };
    const dispatched = initial.events.some((e) => e.type === "subagent_dispatched");
    put(eventsQuery(orgId, conversationId).queryKey, initial.events);
    put(conversationQuery(orgId, conversationId).queryKey, initial.conversation);
    put(queueQuery(orgId, conversationId).queryKey, initial.queue);
    put(filesQuery(orgId, conversationId).queryKey, initial.files);
    put(
      sandboxQuery(orgId, conversationId).queryKey,
      initial.sandbox?.status ?? null,
      initial.sandbox === null,
    );
    put(contributionsQuery(orgId).queryKey, initial.contributions);
    put(
      connectorsQuery(orgId).queryKey,
      initial.connectors === null ? null : { connectors: initial.connectors },
    );
    put(attachmentLimitsQuery(orgId).queryKey, initial.limits);
    if (dispatched) {
      put(subagentsQuery(orgId, conversationId).queryKey, initial.subagents);
      put(usageQuery(orgId, conversationId).queryKey, initial.usage);
    }
    if (initial.tools !== null)
      put(toolInfoQuery(orgId, conversationId, initial.tools.keys).queryKey, initial.tools.info);
    const mine =
      initial.conversation.accountId === undefined ||
      initial.conversation.accountId === session.me.account.id;
    put(
      invocableSkillsQuery(orgId, initial.conversation.agentId, mine ? conversationId : undefined)
        .queryKey,
      initial.skills,
    );
    if (initial.members !== null)
      put(membersQuery(orgId).queryKey, {
        members: initial.members.map((m) => ({ account: { id: m.id, displayName: m.name } })),
      });
    hydrate(qc, reviveDehydrated({ mutations: [], queries }));
  });
  const { page, dialogs } = useConversationPage(orgId, conversationId, initial);
  return (
    <>
      <ConversationPage {...page} />
      {dialogs}
    </>
  );
}
