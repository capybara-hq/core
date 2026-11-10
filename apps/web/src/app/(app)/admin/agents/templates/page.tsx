import AdminAgentTemplatesView from "./view";

/**
 * `/admin/agents/templates` (super admins): the deployment's platform agent templates. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminAgentTemplatesPage() {
  return <AdminAgentTemplatesView />;
}
