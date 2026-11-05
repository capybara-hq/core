import ExtensionInstall from "./view";

/**
 * `/admin/extensions/install` (enterprise admins): the `?upgrade=<name>` target, from the query.
 * It reads nothing: the layout prefetches the installed extensions (to detect a name clash or an
 * upgrade) on a first load (`lib/query/routes.ts`).
 */
export default async function ExtensionInstallPage({
  searchParams,
}: {
  searchParams: Promise<{ upgrade?: string | string[] }>;
}) {
  const { upgrade } = await searchParams;
  const target = typeof upgrade === "string" && upgrade !== "" ? upgrade : null;
  return <ExtensionInstall target={target} />;
}
