import AgentsView from "./view";

/**
 * `/agents`: the current org's agents (guests read them too). It reads nothing: the layout
 * prefetches the list on a first load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function AgentsPage() {
  return <AgentsView />;
}
