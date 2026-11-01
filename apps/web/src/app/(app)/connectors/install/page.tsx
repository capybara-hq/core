import { NoAccess } from "../../../../components/RoleGate";
import { loadCatalogInstall } from "../../../../lib/server/catalog";
import { workspace } from "../../../../lib/server/session";
import InstallConnectorView from "./view";

/**
 * `/connectors/install` (org admins): the install-connector wizard, or with
 * `?template=<catalog item id>` the catalog install wizard for that template, whose item is read on
 * the server.
 */
export default async function InstallConnectorPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const ws = await workspace({ min: "admin" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const raw = (await searchParams).template;
  const itemId = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return (
    <InstallConnectorView
      orgId={ws.orgId}
      template={
        itemId === "" ? null : { itemId, initial: await loadCatalogInstall(ws.orgId, itemId) }
      }
    />
  );
}
