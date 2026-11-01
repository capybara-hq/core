import { NoAccess } from "../../../../components/RoleGate";
import { getOrgSettings } from "../../../../lib/org-settings";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import OrganizationSettings from "./view";

/** `/settings/organization` (members and up): the org's settings (required), read on the server. */
export default async function OrganizationSettingsPage() {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <OrganizationSettings orgId={ws.orgId} initial={await read(getOrgSettings(ws.orgId))} />;
}
