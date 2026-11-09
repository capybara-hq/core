import ConnectorView from "./view";

/**
 * `/connectors/[connectorId]` (guests read it too; `?tab=guide` opens 接入指南 for org admins). It
 * reads nothing: the layout prefetches the connector on a first load (`lib/query/routes.ts`); a
 * missing one is the not-found state in the shell.
 */
export default async function ConnectorPage({
  params,
  searchParams,
}: {
  params: Promise<{ connectorId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { connectorId } = await params;
  const tab = (await searchParams).tab;
  return <ConnectorView connectorId={connectorId} tab={Array.isArray(tab) ? tab[0] : tab} />;
}
