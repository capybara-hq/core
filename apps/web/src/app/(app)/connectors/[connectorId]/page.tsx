import ConnectorView from "./view";

/**
 * `/connectors/[connectorId]` (guests read it too). It reads nothing: the layout prefetches the
 * connector on a first load (`lib/query/routes.ts`); a missing one is the not-found state in the
 * shell.
 */
export default async function ConnectorPage({
  params,
}: {
  params: Promise<{ connectorId: string }>;
}) {
  const { connectorId } = await params;
  return <ConnectorView connectorId={connectorId} />;
}
