import { trajectoryFilters } from "../../../lib/query/trajectories";
import Trajectories from "./view";

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/trajectories` (members; the kernel shows an agent owner only their agents' conversations): the
 * first page under the query's filters (`?agentId=`, `?status=`) and the agents for the filter. It
 * reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`); each set of
 * filters is its own cache entry.
 */
export default async function TrajectoriesPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string | string[]; status?: string | string[] }>;
}) {
  const q = await searchParams;
  return <Trajectories filters={trajectoryFilters(one(q.agentId), one(q.status))} />;
}
