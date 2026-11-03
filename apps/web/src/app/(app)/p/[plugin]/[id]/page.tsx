import PluginPageView from "./view";

/**
 * `/p/[plugin]/[id]` (anyone in the org): an extension's org page. It reads nothing: the layout
 * prefetches the org's UI contributions and, for a view, the view itself on a first load
 * (`lib/query/routes.ts`); an embed's token request stays in the browser.
 */
export default async function PluginPage({
  params,
}: {
  params: Promise<{ plugin: string; id: string }>;
}) {
  const p = await params;
  return <PluginPageView plugin={decodeURIComponent(p.plugin)} id={decodeURIComponent(p.id)} />;
}
