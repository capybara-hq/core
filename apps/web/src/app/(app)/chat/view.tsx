"use client";

import { ConversationPage } from "@capybara-hq/design";
import {
  type NewConversationData,
  useNewConversationPage,
} from "../../../components/conversation/NewConversation";

/**
 * `/chat` (`?agent=<id>`): a new conversation. Only the composer: the agent can be picked here, and
 * the conversation is created on the first send (spec §5.2), never before. The agents, the most
 * recent agent and the models come from the server (`page.tsx`).
 */
export default function NewChatView({
  orgId,
  preferredAgent,
  initial,
}: {
  orgId: string;
  preferredAgent: string | null;
  initial: NewConversationData;
}) {
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent, initial)} />;
}
