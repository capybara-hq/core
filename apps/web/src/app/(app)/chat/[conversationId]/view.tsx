"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useConversationPage } from "../../../../components/conversation/ConversationView";
import { conversationQuery, eventsQuery } from "../../../../lib/query/conversation";
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
  // The snapshot's row and log go into the cache (until the route table prefetches them).
  const qc = useQueryClient();
  useState(() => {
    const events = eventsQuery(orgId, conversationId).queryKey;
    if (qc.getQueryData(events) === undefined) qc.setQueryData(events, initial.events);
    const row = conversationQuery(orgId, conversationId).queryKey;
    if (qc.getQueryData(row) === undefined) qc.setQueryData(row, initial.conversation);
  });
  const { page, dialogs } = useConversationPage(orgId, conversationId, initial);
  return (
    <>
      <ConversationPage {...page} />
      {dialogs}
    </>
  );
}
