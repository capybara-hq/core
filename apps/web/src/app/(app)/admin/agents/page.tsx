import AdminAgentsView from "./view";

const one = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/admin/agents` (super admins): every org's agents under the address's `?orgId=&q=`. It reads
 * nothing: the layout prefetches the first page and the orgs on a first load
 * (`lib/query/routes.ts`); each filter is its own cache entry.
 */
export default async function AdminAgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ orgId?: string | string[]; q?: string | string[] }>;
}) {
  const q = await searchParams;
  return <AdminAgentsView filter={{ orgId: one(q.orgId), q: one(q.q).trim() }} />;
}
