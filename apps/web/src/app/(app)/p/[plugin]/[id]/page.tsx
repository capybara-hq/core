import { pageParamsOf } from "../../../../../lib/page-params";
import PluginPageView from "./view";

/**
 * `/p/[plugin]/[id]` (anyone in the org): an extension's org page. It reads nothing: the layout
 * prefetches the org's UI contributions and, for a view, the view itself on a first load
 * (`lib/query/routes.ts`); an embed's token request stays in the browser. The query string is the
 * page's params (plugin full pages spec §5), a component page's `params` prop.
 */
export default async function PluginPage({
  params,
  searchParams,
}: {
  params: Promise<{ plugin: string; id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [p, search] = await Promise.all([params, searchParams]);
  return (
    <PluginPageView
      plugin={decodeURIComponent(p.plugin)}
      id={decodeURIComponent(p.id)}
      params={pageParamsOf(search)}
    />
  );
}
