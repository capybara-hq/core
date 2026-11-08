import { parseModelsTab } from "../../../../lib/models";
import OrgModels from "./view";

/**
 * `/settings/models` (org admins; a setup step): the tabs 模型 (the org's catalog, the providers
 * beside the open one's models, `?provider=<plugin>`) and 用途默认 (`?tab=purposes`, the org's
 * model purposes). It reads nothing: the layout prefetches them on a first load
 * (`lib/query/routes.ts`).
 */
export default async function OrgModelsPage({
  searchParams,
}: {
  searchParams?: Promise<{ tab?: string | string[]; provider?: string | string[] }>;
} = {}) {
  const sp = await searchParams;
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
  return <OrgModels tab={parseModelsTab(first(sp?.tab))} provider={first(sp?.provider) ?? ""} />;
}
