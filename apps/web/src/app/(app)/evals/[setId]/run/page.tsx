import RunWizard from "./view";

/**
 * `/evals/[setId]/run` (org admins): the set, its agent, the models and the model purposes. It
 * reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default async function RunWizardPage({ params }: { params: Promise<{ setId: string }> }) {
  return <RunWizard setId={decodeURIComponent((await params).setId)} />;
}
