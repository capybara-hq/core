import { NoAccess } from "../../../../../components/NoAccess";
import { getCatalogItem, listCatalogItems, listMarketplaces } from "../../../../../lib/catalog";
import { read, section } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import DirectoryItemView from "./view";

/**
 * `/admin/catalog/[itemId]` (enterprise admins): the item (required: a missing one is not found),
 * the marketplaces that name its sources and the catalog items its dependencies are looked up in
 * (sections: a failure drops the source labels, and leaves the dependencies unchecked), read on the
 * server.
 */
export default async function AdminCatalogItemPage({
  params,
}: {
  params: Promise<{ itemId: string }>;
}) {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const itemId = decodeURIComponent((await params).itemId);
  const [detail, marketplaces, catalog] = await Promise.all([
    read(getCatalogItem(itemId)),
    section(listMarketplaces()),
    section(listCatalogItems()),
  ]);
  return (
    <DirectoryItemView
      initial={{
        detail,
        marketplaces: marketplaces?.items ?? [],
        catalog: catalog?.items ?? null,
      }}
    />
  );
}
