import EvalCaseView from "./view";

/**
 * `/evals/[setId]/cases/[caseId]` (org admins): the case's snapshot trajectory, the set's name and
 * the members. It reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default async function EvalCasePage({
  params,
}: {
  params: Promise<{ setId: string; caseId: string }>;
}) {
  const p = await params;
  return <EvalCaseView setId={decodeURIComponent(p.setId)} caseId={decodeURIComponent(p.caseId)} />;
}
