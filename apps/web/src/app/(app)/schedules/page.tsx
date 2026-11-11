import SchedulesView from "./view";

/**
 * `/schedules`: my scheduled tasks. It reads nothing: the layout prefetches the list on a first
 * load (`lib/query/routes.ts`), and the view reads it from the cache.
 */
export default function SchedulesPage() {
  return <SchedulesView />;
}
