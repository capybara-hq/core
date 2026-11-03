"use client";

import { ConversationPage } from "@capybara-hq/design";
import { useConversationPage } from "../../../../components/conversation/ConversationView";
import { ErrorFrame } from "../../../../components/ErrorFrame";
import { NoAccess } from "../../../../components/NoAccess";
import { conversationQuery } from "../../../../lib/query/conversation";
import { usePageQuery } from "../../../../lib/query/page-query";
import { useWorkspace } from "../../../../lib/query/workspace";
import NotFound from "../../not-found";

/**
 * `/chat/[conversationId]`: a conversation of the current org (ConversationPage), from the query
 * cache. A conversation the caller cannot read is the not-found state in the shell (HTTP 200,
 * spec §3.3). Keyed by the conversation id, so nothing of one conversation (panel, queue, drafts,
 * picks) shows under another.
 */
export default function ChatView({ conversationId }: { conversationId: string }) {
  const ws = useWorkspace();
  if (ws.kind === "pending" || ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <Conversation key={conversationId} orgId={ws.orgId} conversationId={conversationId} />;
}

function Conversation({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const row = usePageQuery(conversationQuery(orgId, conversationId));
  if (row.kind === "notFound") return <NotFound />;
  if (row.kind === "error") return <ErrorFrame reset={row.retry} />;
  return <Loaded orgId={orgId} conversationId={conversationId} />;
}

function Loaded({ orgId, conversationId }: { orgId: string; conversationId: string }) {
  const { page, dialogs } = useConversationPage(orgId, conversationId);
  return (
    <>
      <ConversationPage {...page} />
      {dialogs}
    </>
  );
}
