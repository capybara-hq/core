import AdminConnectorTemplatesView from "./view";

/**
 * `/admin/connector-templates` (super admins): the deployment's platform connector templates. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminConnectorTemplatesPage() {
  return <AdminConnectorTemplatesView />;
}
