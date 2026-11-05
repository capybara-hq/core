import NewAgentView from "./view";

/**
 * `/agents/new`: a setup step (web-order spec §3.8) for members up. It reads nothing: the layout
 * prefetches the form's reads on a first load (models, connectors, skills and the sub-agent
 * options; `lib/query/routes.ts`), and the view reads them from the cache.
 */
export default function NewAgentPage() {
  return <NewAgentView />;
}
