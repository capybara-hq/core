import AdminConnectorTemplateView from "./view";

/**
 * `/admin/connectors/templates/[id]` (super admins): one platform connector template. It reads nothing: the
 * layout prefetches the list, its versions and the orgs on a first load (`lib/query/routes.ts`).
 */
export default async function AdminConnectorTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = decodeURIComponent((await params).id);
  return <AdminConnectorTemplateView id={id} />;
}
