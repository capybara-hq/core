"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useNewConversationPage } from "../../components/conversation/NewConversation";
import { NoAccess } from "../../components/NoAccess";
import { setupReady } from "../../lib/agents";
import { readinessQuery } from "../../lib/query/shell";
import { useWorkspace } from "../../lib/query/workspace";

/**
 * `/` (`?agent=<id>`): a new conversation, the workspace home. Only the composer: the agent can be
 * picked here, and the conversation is created on the first send (spec §5.2), never before. Until
 * a model and an agent exist the app frame draws the setup home here instead (web-order spec
 * §3.8), so the view renders nothing then.
 */
export default function NewChatView({ preferredAgent }: { preferredAgent: string | null }) {
  const ws = useWorkspace({ setup: "home" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewChat orgId={ws.orgId} preferredAgent={preferredAgent} />;
}

function NewChat({ orgId, preferredAgent }: { orgId: string; preferredAgent: string | null }) {
  const readiness = useQuery(readinessQuery(orgId)).data;
  if (readiness === undefined || !setupReady(readiness)) return null;
  return <Composer orgId={orgId} preferredAgent={preferredAgent} />;
}

function Composer({ orgId, preferredAgent }: { orgId: string; preferredAgent: string | null }) {
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent)} />;
}
