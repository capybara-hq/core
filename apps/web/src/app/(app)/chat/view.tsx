"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  type NewConversationData,
  useNewConversationPage,
} from "../../../components/conversation/NewConversation";
import { attachmentLimitsQuery } from "../../../lib/query/conversation";

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
  // The server's limits go into the cache (until the route table prefetches them).
  const qc = useQueryClient();
  useState(() => {
    const key = attachmentLimitsQuery(orgId).queryKey;
    if (initial.limits !== null && qc.getQueryData(key) === undefined)
      qc.setQueryData(key, initial.limits);
  });
  return <ConversationPage {...useNewConversationPage(orgId, preferredAgent, initial)} />;
}
