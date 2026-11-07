import NewChatView from "./view";

/**
 * `/` (`?agent=<id>`): a new conversation, the workspace home (`/chat` redirects here, maintainer
 * decision 2026-11-07). It reads nothing: the layout prefetches the route's queries on a first
 * load (the agents, the sidebar's groups for the agent most recently talked to, the models and the
 * attachment limits), and the view reads them from the cache.
 */
export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[] }>;
}) {
  const { agent } = await searchParams;
  return <NewChatView preferredAgent={(Array.isArray(agent) ? agent[0] : agent) ?? null} />;
}
