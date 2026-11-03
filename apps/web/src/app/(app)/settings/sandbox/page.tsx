import SandboxSettings from "./view";

/**
 * `/settings/sandbox` (members and up): the org's settings. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`).
 */
export default function SandboxSettingsPage() {
  return <SandboxSettings />;
}
