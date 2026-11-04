import AgentView from "./view";

/**
 * `/agents/[id]`: the agent page by section (`?s=<section>`, default `basics`; agent profile design
 * §3.1), a setup step (web-order spec §3.8). It reads nothing: the layout prefetches the agent,
 * and for a viewer who may change it every section's reads, on a first load
 * (`lib/query/routes.ts`); the view reads them from the cache.
 */
export default async function AgentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ s?: string | string[] }>;
}) {
  const { id } = await params;
  const raw = (await searchParams)?.s;
  const section = Array.isArray(raw) ? raw[0] : raw;
  return <AgentView agentId={id} {...(section === undefined ? {} : { section })} />;
}
