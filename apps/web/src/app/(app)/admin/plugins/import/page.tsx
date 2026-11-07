import PluginImportView from "./view";

/**
 * `/admin/plugins/import` (super admins): `?staging=<id>` names a staged import (opened from
 * the marketplace entries, or a reload). It reads nothing: the layout prefetches the staged review
 * on a first load (`lib/query/routes.ts`). A staged import the kernel refuses (expired, already
 * confirmed) is shown as the page's own problem, never a not-found page.
 */
export default async function PluginImportPage({
  searchParams,
}: {
  searchParams: Promise<{ staging?: string | string[] }>;
}) {
  const { staging } = await searchParams;
  const id = typeof staging === "string" && staging !== "" ? staging : null;
  // Keyed by the staged import: back / forward between two `?staging=` values remounts the wizard.
  return <PluginImportView key={id ?? ""} staging={id} />;
}
