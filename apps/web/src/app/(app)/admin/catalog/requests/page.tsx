import { NoAccess } from "../../../../../components/RoleGate";
import { listDeploymentRequests } from "../../../../../lib/catalog";
import { read } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import Requests from "./view";

/** `/admin/catalog/requests` (enterprise admins): the pending deployment requests, read on the server. */
export default async function CatalogRequestsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const { requests } = await read(listDeploymentRequests());
  return <Requests initial={requests} />;
}
