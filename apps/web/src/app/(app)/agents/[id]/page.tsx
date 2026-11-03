import AgentView from "./view";

/**
 * `/agents/[id]`: a setup step (web-order spec §3.8). It reads nothing: the layout prefetches the
 * agent, and for a viewer who may change it the form's reads and the channel connections, on a
 * first load (`lib/query/routes.ts`); the view reads them from the cache.
 */
export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AgentView agentId={id} />;
}
