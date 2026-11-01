import { NoAccess } from "../../../../components/NoAccess";
import { getOrgSettings } from "../../../../lib/org-settings";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import SandboxSettings from "./view";

/** `/settings/sandbox` (members and up): the org's settings (required), read on the server. */
export default async function SandboxSettingsPage() {
  const ws = await workspace({ min: "member" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  return <SandboxSettings orgId={ws.orgId} initial={await read(getOrgSettings(ws.orgId))} />;
}
