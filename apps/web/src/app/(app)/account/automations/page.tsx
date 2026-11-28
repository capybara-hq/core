import AccountAutomationsView from "./view";

/**
 * `/account/automations`: how work that sources assign to me and my agents is accepted. It reads
 * nothing: the layout prefetches my rules on a first load (`lib/query/routes.ts`).
 */
export default function AccountAutomationsPage() {
  return <AccountAutomationsView />;
}
