import NewAutomationView from "./view";

/**
 * `/automations/new`: a new automation. It reads nothing: the layout prefetches the agents and
 * the models on a first load (`lib/query/routes.ts`).
 */
export default function NewAutomationPage() {
  return <NewAutomationView />;
}
