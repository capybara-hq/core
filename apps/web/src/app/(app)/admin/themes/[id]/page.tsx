import AdminThemeView from "./view";

/**
 * `/admin/themes/[id]` (super admins): one theme. It reads nothing: the layout prefetches the list,
 * its versions, the orgs and the settings on a first load (`lib/query/routes.ts`).
 */
export default async function AdminThemePage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <AdminThemeView id={id} />;
}
