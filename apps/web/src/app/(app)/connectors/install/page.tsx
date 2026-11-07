import InstallConnectorView from "./view";

/**
 * `/connectors/install` (org admins): the install-connector wizard, or with
 * `?template=<catalog item id>` the catalog install wizard for that template, or with
 * `?kind=&endpoint=&name=` the install wizard prefilled. It reads nothing: the
 * layout prefetches the template's item and the org's extensions on a first load
 * (`lib/query/routes.ts`).
 */
export default async function InstallConnectorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return (Array.isArray(v) ? v[0] : v) ?? "";
  };
  const itemId = one("template");
  // `?kind=&endpoint=&name=&pending=1`: prefilled for an agent's pending connector (ruling P4-7)
  const kind = one("kind");
  const prefill =
    kind === "mcp" || kind === "openapi"
      ? {
          kind: kind as "mcp" | "openapi",
          endpoint: one("endpoint"),
          name: one("name"),
          pending: one("pending") === "1",
        }
      : null;
  return <InstallConnectorView template={itemId === "" ? null : itemId} prefill={prefill} />;
}
