import ScheduleSettingsView from "./view";

/**
 * `/settings/schedules` (org admins): the scheduled-task settings and every task of the org. It
 * reads nothing: the layout prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function ScheduleSettingsPage() {
  return <ScheduleSettingsView />;
}
