import { NoAccess } from "../../../../components/RoleGate";
import { getOrgCatalogItem } from "../../../../lib/catalog";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import CatalogItemView from "./view";

/**
 * `/catalog/[itemId]` (members up; a setup step, web-order spec §3.8): a catalog item from the
 * org's view, read on the server; a missing one is not found.
 */
export default async function CatalogItemPage({ params }: { params: Promise<{ itemId: string }> }) {
  const ws = await workspace({ min: "member", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { itemId } = await params;
  return (
    <CatalogItemView orgId={ws.orgId} initial={await read(getOrgCatalogItem(ws.orgId, itemId))} />
  );
}
