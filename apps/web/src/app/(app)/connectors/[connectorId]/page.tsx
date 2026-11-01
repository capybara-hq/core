import { NoAccess } from "../../../../components/RoleGate";
import { getConnector } from "../../../../lib/connectors";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import ConnectorView from "./view";

/** `/connectors/[connectorId]`: a connector, read on the server; a missing one is not found. */
export default async function ConnectorPage({
  params,
}: {
  params: Promise<{ connectorId: string }>;
}) {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { connectorId } = await params;
  const { connector } = await read(getConnector(ws.orgId, connectorId));
  return <ConnectorView orgId={ws.orgId} initial={connector} />;
}
