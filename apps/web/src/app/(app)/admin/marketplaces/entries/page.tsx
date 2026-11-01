import { NoAccess } from "../../../../../components/RoleGate";
import { listMarketplaceEntries, listMarketplaces } from "../../../../../lib/catalog";
import { read, section } from "../../../../../lib/server/page";
import { admin } from "../../../../../lib/server/session";
import Catalog from "./view";

const first = (v: string | string[] | undefined): string => (typeof v === "string" ? v : "");

/**
 * `/admin/marketplaces/entries` (enterprise admins): the entries for the initial
 * `?sourceId=&q=` (required) and the marketplaces that become the source tabs (a section: a failure
 * drops the tabs), read on the server. Typing in the search and switching the source read in the
 * browser (user-triggered).
 */
export default async function MarketplaceEntriesPage({
  searchParams,
}: {
  searchParams: Promise<{ sourceId?: string | string[]; q?: string | string[] }>;
}) {
  const gate = await admin();
  if (gate.kind === "noAccess") return <NoAccess need={gate.need} />;
  const params = await searchParams;
  const sourceId = first(params.sourceId);
  const q = first(params.q).trim();
  const [entries, sources] = await Promise.all([
    read(listMarketplaceEntries({ ...(sourceId !== "" && { sourceId }), ...(q !== "" && { q }) })),
    section(listMarketplaces()),
  ]);
  return <Catalog initial={{ entries, sources: sources?.items ?? [], sourceId, q }} />;
}
