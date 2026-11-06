import { parseAgentsTab } from "../../../lib/agents";
import AgentsView from "./view";

/**
 * `/agents`: the current org's agents (guests read them too) and, for members up, the agent
 * templates (`?tab=templates`, ruling P4-14). It reads nothing: the layout prefetches both tabs'
 * lists on a first load (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default async function AgentsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[] }>;
} = {}) {
  const raw = (await searchParams)?.tab;
  return <AgentsView tab={parseAgentsTab(Array.isArray(raw) ? raw[0] : raw)} />;
}
