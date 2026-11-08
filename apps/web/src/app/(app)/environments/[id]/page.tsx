import EnvironmentView from "./view";

/**
 * `/environments/[id]`: one of the person's environments. It reads nothing: the layout prefetches it
 * on a first load (`lib/query/routes.ts`); a missing one is the not-found state in the shell.
 */
export default async function EnvironmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EnvironmentView id={id} />;
}
