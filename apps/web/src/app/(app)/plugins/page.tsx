import PluginsView from "./view";

/**
 * `/plugins` (members up; a setup step, web-order spec §3.8): the org's 插件 page. It reads
 * nothing: the layout prefetches the catalog (and for org admins the extensions and the
 * marketplace entries) on a first load (`lib/query/routes.ts`), and the view reads them from the
 * cache.
 */
export default async function PluginsPage({
  searchParams,
}: {
  searchParams?: Promise<{ staging?: string | string[] }>;
} = {}) {
  const staging = (await searchParams)?.staging;
  // `?staging=<id>`: an upload staged by the Platform tool; its review opens (org admins)
  const id = typeof staging === "string" && staging !== "" ? staging : null;
  // keyed by the staged upload: client navigation to another `?staging=` reopens the dialog
  return <PluginsView key={id ?? ""} staging={id} />;
}
