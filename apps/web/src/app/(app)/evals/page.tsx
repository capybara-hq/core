import EvalSets from "./view";

/**
 * `/evals` (org admins): the eval sets and the agents for their names. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function EvalsPage() {
  return <EvalSets />;
}
