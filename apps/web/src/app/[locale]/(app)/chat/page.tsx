"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useSearchParams } from "next/navigation";
import { useNewConversationPage } from "../../../../components/conversation/NewConversation";
import { OrgGate } from "../../../../components/OrgGate";

/**
 * `/[locale]/chat` (`?agent=<id>`): a new conversation. Only the composer: the agent can be picked
 * here, and the conversation is created on the first send (spec §5.2), never before.
 */
export default function NewChatPage() {
  const agent = useSearchParams().get("agent");
  return (
    <OrgGate>{(orgId) => <NewChat key={orgId} orgId={orgId} preferredAgent={agent} />}</OrgGate>
  );
}

function NewChat({ orgId, preferredAgent }: { orgId: string; preferredAgent: string | null }) {
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent)} />;
}
