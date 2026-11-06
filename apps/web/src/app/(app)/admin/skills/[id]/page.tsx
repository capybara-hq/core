import AdminSkillView from "./view";

/**
 * `/admin/skills/[id]` (super admins): one platform skill. It reads nothing: the
 * layout prefetches the list, its versions and the orgs on a first load (`lib/query/routes.ts`).
 */
export default async function AdminSkillPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <AdminSkillView id={id} />;
}
