import { NoAccess } from "../../../../components/NoAccess";
import { listPluginInstalls } from "../../../../lib/catalog";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Apps from "./view";

/** `/settings/plugins` (org admins): the org's plugin installs (required), read on the server. */
export default async function PluginsPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { installs } = await read(listPluginInstalls(ws.orgId));
  return <Apps orgId={ws.orgId} initial={installs} />;
}
