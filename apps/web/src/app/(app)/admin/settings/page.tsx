import { NoAccess } from "../../../../components/RoleGate";
import { getDeploymentSettings } from "../../../../lib/admin";
import { read } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminSettings from "./view";

/** `/admin/settings` (enterprise admins): the deployment settings, read on the server. */
export default async function AdminSettingsPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  return <AdminSettings initial={await read(getDeploymentSettings())} />;
}
