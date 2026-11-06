import AgentTemplatesView from "./view";

/**
 * `/agent-templates`: the agent templates the org can use and the platform ones offered to it
 * (members up). It reads nothing: the layout prefetches the lists on a first load
 * (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default function AgentTemplatesPage() {
  return <AgentTemplatesView />;
}
