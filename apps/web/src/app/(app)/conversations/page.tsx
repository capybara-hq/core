import Conversations from "./view";

/**
 * `/conversations` (the compact class's 会话 tab; every role in an org): my conversations grouped by
 * agent. It reads nothing: the layout prefetches the first page of the groups on a first load
 * (`lib/query/routes.ts`).
 */
export default function ConversationsPage() {
  return <Conversations />;
}
