import ExtensionDetail from "./view";

/**
 * `/admin/extensions/[name]` (super admins): the extension list (the extension is found in it)
 * and the deployment config for the Config tab. It reads nothing: the layout prefetches both on a
 * first load (`lib/query/routes.ts`).
 */
export default async function ExtensionDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const name = decodeURIComponent((await params).name);
  return <ExtensionDetail name={name} />;
}
