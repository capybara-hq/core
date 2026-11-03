import AdminDirectory from "./view";

/**
 * `/admin/catalog` (enterprise admins): the catalog items and the marketplaces that name their
 * sources. It reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminCatalogPage() {
  return <AdminDirectory />;
}
