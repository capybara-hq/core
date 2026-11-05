import EvalSetView from "./view";

/**
 * `/evals/[setId]` (org admins): the set with its cases, its runs and its agent. It reads nothing:
 * the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default async function EvalSetPage({ params }: { params: Promise<{ setId: string }> }) {
  return <EvalSetView setId={decodeURIComponent((await params).setId)} />;
}
