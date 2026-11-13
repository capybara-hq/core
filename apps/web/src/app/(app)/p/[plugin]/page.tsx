import PluginRootPageView from "./view";

/**
 * `/p/[plugin]` (anyone in the org): a plugin's page, the short form of `/p/[plugin]/[id]` for a
 * plugin that has one page (the sidebar links it that way). Reads nothing itself: the layout
 * prefetches the org's UI contributions and the page's view on a first load (`lib/query/routes.ts`).
 */
export default async function PluginRootPage({ params }: { params: Promise<{ plugin: string }> }) {
  const p = await params;
  return <PluginRootPageView plugin={decodeURIComponent(p.plugin)} />;
}
