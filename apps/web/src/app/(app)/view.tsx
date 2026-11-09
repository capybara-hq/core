"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useQuery } from "@tanstack/react-query";
import { useNewConversationPage } from "../../components/conversation/NewConversation";
import { NoAccess } from "../../components/NoAccess";
import { setupReady } from "../../lib/agents";
import { readinessQuery } from "../../lib/query/shell";
import { useWorkspace } from "../../lib/query/workspace";

/**
 * `/` (`?agent=<id>`, `?draft=<text>`): a new conversation, the workspace home. Only the composer:
 * the agent can be picked here, and the conversation is created on the first send (spec §5.2),
 * never before. A `draft` is the composer's first text, read once and never sent on its own. Until
 * a model and an agent exist the app frame draws the setup home here instead (web-order spec
 * §3.8), so the view renders nothing then.
 */
type Props = { preferredAgent: string | null; draft?: string | null };

export default function NewChatView({ preferredAgent, draft = null }: Props) {
  const ws = useWorkspace({ setup: "home" });
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <NewChat orgId={ws.orgId} preferredAgent={preferredAgent} draft={draft} />;
}

function NewChat({ orgId, ...props }: Props & { orgId: string }) {
  const readiness = useQuery(readinessQuery(orgId)).data;
  if (readiness === undefined || !setupReady(readiness)) return null;
  return <Composer orgId={orgId} {...props} />;
}

function Composer({ orgId, preferredAgent, draft = null }: Props & { orgId: string }) {
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent, draft)} />;
}
