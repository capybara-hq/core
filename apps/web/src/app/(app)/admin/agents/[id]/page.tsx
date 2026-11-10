import AdminAgentView from "./view";

/**
 * `/admin/agents/[id]` (super admins): one agent of any org, read-only, with 转移负责人 and 删除.
 * It reads nothing: the layout prefetches the agent on a first load (`lib/query/routes.ts`).
 */
export default async function AdminAgentPage({ params }: { params: Promise<{ id: string }> }) {
  const id = decodeURIComponent((await params).id);
  return <AdminAgentView id={id} />;
}
