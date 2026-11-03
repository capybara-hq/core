import Requests from "./view";

/**
 * `/admin/catalog/requests` (enterprise admins): the pending deployment requests. It reads nothing:
 * the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function CatalogRequestsPage() {
  return <Requests />;
}
