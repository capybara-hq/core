import { parseLinkError } from "../../../../lib/identities";
import Identities from "./view";

/**
 * `/account/identities` (any signed-in person; no org needed, so no readiness gate). It reads
 * nothing: the layout prefetches the linked identities on a first load (`lib/query/routes.ts`),
 * and the view reads them from the cache. `?error=` is a link intent's failure code.
 */
export default async function IdentitiesPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string | string[] }>;
}) {
  const { error } = await searchParams;
  return <Identities error={parseLinkError(typeof error === "string" ? error : undefined)} />;
}
