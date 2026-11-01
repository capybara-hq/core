import { NoAccess } from "../../../../../components/RoleGate";
import { loadCatalogInstall } from "../../../../../lib/server/catalog";
import { workspace } from "../../../../../lib/server/session";
import CatalogInstallView from "./view";

/**
 * `/catalog/[itemId]/install` (org admins; a setup step, web-order spec §3.8): the item and the
 * org's extensions are read on the server.
 */
export default async function CatalogInstallPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const ws = await workspace({ min: "admin", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { itemId } = await params;
  return (
    <CatalogInstallView
      orgId={ws.orgId}
      itemId={itemId}
      initial={await loadCatalogInstall(ws.orgId, itemId)}
    />
  );
}
