import SharesSettingsView from "./view";

/**
 * `/settings/shares` (org admins): every shared file link of the org, revocable. It reads nothing:
 * the layout prefetches the list on a first load (`lib/query/routes.ts`).
 */
export default function SharesSettingsPage() {
  return <SharesSettingsView />;
}
