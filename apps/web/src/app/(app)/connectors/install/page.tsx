import InstallConnectorView from "./view";

/**
 * `/connectors/install` (org admins): the install-connector wizard, or with
 * `?template=<catalog item id>` the catalog install wizard for that template. It reads nothing: the
 * layout prefetches the template's item and the org's extensions on a first load
 * (`lib/query/routes.ts`).
 */
export default async function InstallConnectorPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string | string[] }>;
}) {
  const raw = (await searchParams).template;
  const itemId = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  return <InstallConnectorView template={itemId === "" ? null : itemId} />;
}
