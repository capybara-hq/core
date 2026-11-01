import { NoAccess } from "../../../../components/RoleGate";
import { getDeploymentSettings, listAdminOrgs } from "../../../../lib/admin";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminOrgs from "./view";

/** `/admin/orgs` (enterprise admins): the orgs and the deployment settings, read on the server. */
export default async function AdminOrgsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const [{ orgs }, settings] = await Promise.all([
    read(listAdminOrgs()),
    read(getDeploymentSettings()),
  ]);
  return <AdminOrgs initial={{ orgs, settings }} />;
}
