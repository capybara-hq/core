import { MAX_DRAFT_PARAM } from "../../lib/routes";
import NewChatView from "./view";

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * `/` (`?agent=<id>`, `?draft=<text>`: the composer's text to start with, never sent on its own,
 * e.g. a setup guide's 让智能体协助): a new conversation, the workspace home (`/chat` redirects here, maintainer
 * decision 2026-11-07). It reads nothing: the layout prefetches the route's queries on a first
 * load (the agents, the sidebar's groups for the agent most recently talked to, the models and the
 * attachment limits), and the view reads them from the cache.
 */
export default async function NewChatPage({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string | string[]; draft?: string | string[] }>;
}) {
  const { agent, draft } = await searchParams;
  const text = first(draft)?.slice(0, MAX_DRAFT_PARAM);
  return (
    <NewChatView preferredAgent={first(agent) ?? null} draft={text?.trim() ? text : null} />
  );
}
