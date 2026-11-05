import AdminModelsView from "./view";

/**
 * `/admin/models` (enterprise admins): the providers with their models and prices, and the
 * purposes' default mapping. It reads nothing: the layout prefetches both on a first load
 * (`lib/query/routes.ts`).
 */
export default function AdminModelsPage() {
  return <AdminModelsView />;
}
