import ChatView from "./view";

/**
 * `/chat/[conversationId]`: a conversation of the current org. It reads nothing: the layout
 * prefetches the route's queries on a first load (`lib/query/routes.ts`: the row, the log, the
 * agents and models, the queue, contributions, files, sandbox, connectors and limits, then what
 * the log names), and the view reads them from the cache.
 */
export default async function ChatPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  return <ChatView conversationId={conversationId} />;
}
