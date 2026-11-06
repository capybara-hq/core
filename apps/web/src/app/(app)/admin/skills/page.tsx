import AdminSkillsView from "./view";

/**
 * `/admin/skills` (super admins): the deployment's platform skills. It reads
 * nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function AdminSkillsPage() {
  return <AdminSkillsView />;
}
