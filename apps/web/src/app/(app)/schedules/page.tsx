import { SCHEDULES_VIEW_COOKIE, schedulesUrlOf } from "../../../lib/schedule-calendar";
import { currentCookie } from "../../../lib/server/page";
import SchedulesView from "./view";

/**
 * `/schedules`: my scheduled tasks, as a calendar (`?range=&date=&scope=`, the default) or a list (`?view=list`).
 * It reads no kernel data: the layout prefetches the list (and the calendar range the view will
 * ask for) on a first load (`lib/query/routes.ts`), and the view reads them from the cache. It
 * reads the address and the `cap_schedules_view` cookie, so a remembered calendar paints first
 * (calendar spec §4.1).
 */
export default async function SchedulesPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}) {
  const search = (await searchParams) ?? {};
  return (
    <SchedulesView initial={schedulesUrlOf(search, await currentCookie(SCHEDULES_VIEW_COOKIE))} />
  );
}
