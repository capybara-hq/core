import { NoAccess } from "../../../../components/NoAccess";
import { loadConversationSnapshot } from "../../../../lib/server/conversation";
import { workspace } from "../../../../lib/server/session";
import ChatView from "./view";

/**
 * `/chat/[conversationId]`: a conversation of the current org, read on the server in one snapshot
 * (web-SSR spec §6.2): the conversation, every event, the agents and models, the queue, the
 * sub-agents and usage, the tool info, the UI contributions, the files, the sandbox and the
 * composer's skills. A conversation the caller cannot read is the not-found page. The right panel
 * (the URL hash) is not seen by the server and loads in the browser.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { conversationId } = await params;
  const snapshot = await loadConversationSnapshot(ws.orgId, conversationId, {
    accountId: ws.me.account.id,
  });
  return <ChatView orgId={ws.orgId} conversationId={conversationId} initial={snapshot} />;
}
