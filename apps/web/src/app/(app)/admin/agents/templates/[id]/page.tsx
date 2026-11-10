import AdminAgentTemplateView from "./view";

/**
 * `/admin/agents/templates/[id]` (super admins): one platform agent template. It reads nothing: the
 * layout prefetches the list, its versions and the orgs on a first load (`lib/query/routes.ts`).
 */
export default async function AdminAgentTemplatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const id = decodeURIComponent((await params).id);
  return <AdminAgentTemplateView id={id} />;
}
