import Identities from "./view";

/**
 * `/account/identities` (any signed-in person; no org needed, so no readiness gate). It reads
 * nothing: the layout prefetches the linked identities and the sign-in sources on a first load
 * (`lib/query/routes.ts`), and the view reads them from the cache.
 */
export default function IdentitiesPage() {
  return <Identities />;
}
