import { NoAccess } from "../../../components/NoAccess";
import { listOrgCatalog } from "../../../lib/catalog";
import { read } from "../../../lib/server/page";
import { workspace } from "../../../lib/server/session";
import CatalogView from "./view";

/** `/catalog` (members up; a setup step, web-order spec §3.8): the org's catalog, read on the server. */
export default async function CatalogPage() {
  const ws = await workspace({ min: "member", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const { items } = await read(listOrgCatalog(ws.orgId));
  return <CatalogView initial={items} />;
}
