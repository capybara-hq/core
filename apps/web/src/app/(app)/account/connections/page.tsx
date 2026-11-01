import { type ConnectorDetail, getConnector, listConnectors } from "../../../../lib/connectors";
import { optional, read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Connections from "./view";

/**
 * `/account/connections` (a setup step): the connectors that need each person's own credential. The
 * list is required; each personal connector's detail (with this person's credential status) is read
 * in parallel, and one the kernel no longer lets the person see is left out.
 */
export default async function ConnectionsPage() {
  const ws = await workspace({ setup: "step" });
  if (ws.kind !== "ok") return null;
  const { connectors } = await read(listConnectors(ws.orgId));
  const personal = connectors.filter(
    (a) => a.auth.type !== "none" && a.auth.ownership === "personal",
  );
  const details = await Promise.all(
    personal.map((a) => optional(getConnector(ws.orgId, a.id).then((r) => r.connector))),
  );
  return (
    <Connections
      orgId={ws.orgId}
      initial={details.filter((d): d is ConnectorDetail => d !== null)}
    />
  );
}
