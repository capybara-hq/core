import { parseModelsTab } from "../../../../lib/models";
import AdminModelsView from "./view";

/**
 * `/admin/models` (super admins): the tabs 模型 (the providers beside the open one's models and
 * prices, `?provider=<plugin>`) and 用途默认 (`?tab=purposes`, the purposes' default mapping). It
 * reads nothing: the layout prefetches both reads on a first load (`lib/query/routes.ts`).
 */
export default async function AdminModelsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[]; provider?: string | string[] }>;
} = {}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return (
    <AdminModelsView tab={parseModelsTab(first(sp?.tab))} provider={first(sp?.provider) ?? ""} />
  );
}
