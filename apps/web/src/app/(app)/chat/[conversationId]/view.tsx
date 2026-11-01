"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useConversationPage } from "../../../../components/conversation/ConversationView";
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
  const { page, dialogs } = useConversationPage(orgId, conversationId, initial);
  return (
    <>
      <ConversationPage {...page} />
      {dialogs}
    </>
  );
}
