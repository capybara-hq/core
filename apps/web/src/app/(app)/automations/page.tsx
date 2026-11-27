import { AUTOMATIONS_VIEW_COOKIE, automationsUrlOf } from "../../../lib/automation-calendar";
import { currentCookie } from "../../../lib/server/page";
import AutomationsView from "./view";

/**
 * `/automations`: my automations, as a calendar (`?range=&date=&scope=`, the default) or a list (`?view=list`).
 * It reads no kernel data: the layout prefetches the list (and the calendar range the view will
 * ask for) on a first load (`lib/query/routes.ts`), and the view reads them from the cache. It
 * reads the address and the `cap_automations_view` cookie, so a remembered calendar paints first
 * (calendar spec §4.1).
 */
export default async function AutomationsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const search = (await searchParams) ?? {};
  return (
    <AutomationsView
      initial={automationsUrlOf(search, await currentCookie(AUTOMATIONS_VIEW_COOKIE))}
    />
  );
}
