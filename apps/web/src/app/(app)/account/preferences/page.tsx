import Preferences from "./view";

/**
 * `/account/preferences` (any signed-in person; no org needed, so no readiness gate). It reads
 * nothing: the layout prefetches the preferences on a first load (`lib/query/routes.ts`), and the
 * view reads them from the cache.
 */
export default function PreferencesPage() {
  return <Preferences />;
}
