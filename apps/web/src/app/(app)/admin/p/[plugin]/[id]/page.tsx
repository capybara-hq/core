import PlatformPageView from "./view";

/**
 * `/admin/p/[plugin]/[id]` (super admins): an extension's platform page. It reads nothing: the
 * layout prefetches the platform's UI contributions and, for a view, the view itself on a first
 * load (`lib/query/routes.ts`); an embed's token request stays in the browser.
 */
export default async function PlatformPage({
  params,
}: {
  params: Promise<{ plugin: string; id: string }>;
}) {
  const p = await params;
  return <PlatformPageView plugin={decodeURIComponent(p.plugin)} id={decodeURIComponent(p.id)} />;
}
