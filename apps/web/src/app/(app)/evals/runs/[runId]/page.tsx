import EvalRunPageView from "./view";

/**
 * `/evals/runs/[runId]` (org admins): the run with the first page of its results, and its set (for
 * the case titles and the path). It reads nothing: the layout prefetches them on a first load
 * (`lib/query/routes.ts`); the polling while the run is active and the pages after the first
 * continue in the browser.
 */
export default async function EvalRunPage({ params }: { params: Promise<{ runId: string }> }) {
  return <EvalRunPageView runId={decodeURIComponent((await params).runId)} />;
}
