import ScheduleView from "./view";

/**
 * `/schedules/[id]`: one scheduled task. It reads nothing: the layout prefetches it, its runs and
 * approved tools on a first load (`lib/query/routes.ts`); a missing one is the not-found state in
 * the shell.
 */
export default async function SchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ScheduleView id={id} />;
}
