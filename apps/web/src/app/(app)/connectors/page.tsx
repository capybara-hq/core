import { NoAccess } from "../../../components/RoleGate";
import { listConnectors } from "../../../lib/connectors";
import { read } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import ConnectorsView from "./view";

/** `/connectors`: the org's connectors, read on the server (guests read them too). */
export default async function ConnectorsPage() {
  const ws = await workspace();
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { connectors } = await read(listConnectors(ws.orgId));
  return <ConnectorsView initial={connectors} />;
}
