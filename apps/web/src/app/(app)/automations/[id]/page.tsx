import AutomationView from "./view";

/**
 * `/automations/[id]`: one automation. It reads nothing: the layout prefetches it, its runs and
 * approved tools on a first load (`lib/query/routes.ts`); a missing one is the not-found state in
 * the shell.
 */
export default async function AutomationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <AutomationView id={id} />;
}
