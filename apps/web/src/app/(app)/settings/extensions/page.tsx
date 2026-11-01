import { NoAccess } from "../../../../components/NoAccess";
import { listOrgExtensions } from "../../../../lib/extensions";
import { getOrgFilePreviewers } from "../../../../lib/previewers";
import { read, section } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import Plugins from "./view";

/**
 * `/settings/extensions` (org admins): the org's extensions (required) and the file previewers (a
 * section: the block is hidden when they can't be read), read on the server.
 */
export default async function ExtensionsPage() {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ extensions }, previewers] = await Promise.all([
    read(listOrgExtensions(ws.orgId)),
    section(getOrgFilePreviewers(ws.orgId)),
  ]);
  return (
    <Plugins orgId={ws.orgId} initial={{ extensions, previewers: previewers?.items ?? null }} />
  );
}
