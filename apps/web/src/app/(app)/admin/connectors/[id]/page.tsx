import AdminConnectorView from "./view";

/**
 * `/admin/connectors/[id]` (super admins): one connector of any org, read-only, with 停用 / 启用
 * and 删除. It reads nothing: the layout prefetches the connector on a first load
 * (`lib/query/routes.ts`).
 */
export default async function AdminConnectorPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <AdminConnectorView id={id} />;
}
