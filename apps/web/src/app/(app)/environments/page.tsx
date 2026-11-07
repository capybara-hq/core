import EnvironmentsView from "./view";

/**
 * `/environments`: the person's environments. It reads nothing: the layout prefetches the list on a
 * first load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function EnvironmentsPage() {
  return <EnvironmentsView />;
}
