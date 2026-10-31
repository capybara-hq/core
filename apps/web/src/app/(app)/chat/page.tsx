"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useSearchParams } from "next/navigation";
import { useNewConversationPage } from "../../../components/conversation/NewConversation";
import { OrgGate } from "../../../components/OrgGate";

/**
 * `/chat` (`?agent=<id>`): a new conversation. Only the composer: the agent can be picked
 * here, and the conversation is created on the first send (spec §5.2), never before. Until a model
 * and an agent exist the app frame draws the setup layout here instead (web-order spec §3.8), so
 * this page only renders once the org can run (no composer that turns into a checklist).
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
