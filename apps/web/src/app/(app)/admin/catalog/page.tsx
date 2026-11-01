import { NoAccess } from "../../../../components/RoleGate";
import { listCatalogItems, listMarketplaces } from "../../../../lib/catalog";
import { read, section } from "../../../../lib/server/page";
import { admin } from "../../../../lib/server/session";
import AdminDirectory from "./view";

/**
 * `/admin/catalog` (enterprise admins): the catalog items (required) and the marketplaces that name
 * their sources (a section: a failure only drops the source labels), read on the server.
 */
export default async function AdminCatalogPage() {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const [catalog, marketplaces] = await Promise.all([
    read(listCatalogItems()),
    section(listMarketplaces()),
  ]);
  return (
    <AdminDirectory initial={{ items: catalog.items, marketplaces: marketplaces?.items ?? [] }} />
  );
}
