import NewScheduleView from "./view";

/**
 * `/schedules/new`: a new scheduled task. It reads nothing: the layout prefetches the agents and
 * the models on a first load (`lib/query/routes.ts`).
 */
export default function NewSchedulePage() {
  return <NewScheduleView />;
}
