"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useConversationPage } from "../../../../../components/conversation/ConversationView";
import { OrgGate } from "../../../../../components/OrgGate";

/** `/[locale]/chat/[conversationId]`: a conversation of the current org (ConversationPage). */
export default function ChatPage() {
  const { conversationId } = useParams<{ conversationId: string }>();
  return (
    <OrgGate>{(orgId) => <ChatInOrg orgId={orgId} conversationId={conversationId} />}</OrgGate>
  );
}

/**
 * A conversation belongs to the org it was opened in: after an org switch (AppFrame is going back
 * to the list) nothing renders with the new org and the old conversation. Keyed by the
 * conversation id, so nothing of one conversation (panel, queue, drafts, picks) shows under another.
 */
function ChatInOrg({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const [openedIn] = useState(orgId);
  if (orgId !== openedIn) return null;
  return <Conversation key={conversationId} orgId={orgId} conversationId={conversationId} />;
}

function Conversation({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const { page, dialogs } = useConversationPage(orgId, conversationId);
  return (
    <>
      <ConversationPage {...page} />
      {dialogs}
    </>
  );
}
