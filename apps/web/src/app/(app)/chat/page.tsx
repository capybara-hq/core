"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useSearchParams } from "next/navigation";
import { useAgentList } from "../../../components/conversation/ConversationView";
import { useNewConversationPage } from "../../../components/conversation/NewConversation";
import { SetupGuide, setupReady } from "../../../components/conversation/SetupGuide";
import { useModels } from "../../../components/conversation/useSelection";
import { OrgGate } from "../../../components/OrgGate";

/**
 * `/chat` (`?agent=<id>`): a new conversation. Only the composer: the agent can be picked
 * here, and the conversation is created on the first send (spec §5.2), never before. Without a
 * model or an agent it shows the setup checklist (OnboardingPage) instead.
 */
export default function NewChatPage() {
  const agent = useSearchParams().get("agent");
  return (
    <OrgGate>{(orgId) => <NewChat key={orgId} orgId={orgId} preferredAgent={agent} />}</OrgGate>
  );
}

function NewChat({ orgId, preferredAgent }: { orgId: string; preferredAgent: string | null }) {
  const agents = useAgentList(orgId);
  const providers = useModels(orgId);
  // until both are known the composer shows (it is what most people see); once known and not
  // ready, the setup checklist replaces it
  if (agents !== undefined && providers !== undefined && !setupReady(agents, providers)) {
    return <SetupGuide agents={agents} providers={providers} />;
  }
  return <Composer orgId={orgId} preferredAgent={preferredAgent} />;
}

function Composer({ orgId, preferredAgent }: { orgId: string; preferredAgent: string | null }) {
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent)} />;
}
