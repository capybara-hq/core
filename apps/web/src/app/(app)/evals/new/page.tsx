import NewEvalSet from "./view";

/**
 * `/evals/new` (org admins): the agents to choose from; `?agentId=` (from a trajectory's 加入评测集
 * with no eval set yet) presets the agent when it is one of them. It reads nothing: the layout
 * prefetches the agents on a first load (`lib/query/routes.ts`).
 */
export default async function NewEvalSetPage({
  searchParams,
}: {
  searchParams?: Promise<{ agentId?: string | string[] }>;
} = {}) {
  const raw = (await searchParams)?.agentId;
  const wanted = Array.isArray(raw) ? raw[0] : raw;
  return <NewEvalSet wanted={wanted ?? ""} />;
}
