import { parseAllowHostParam } from "../../../../lib/network-hosts";
import SandboxSettings from "./view";

/**
 * `/settings/sandbox` (members and up): the org's settings. It reads nothing: the layout
 * prefetches them on a first load (`lib/query/routes.ts`). `?allowHost=<host>[,<host>…]` (from a
 * blocked command's 「去组织设置添加」, network ask spec §5.3) prefills the cloud network's
 * allowlist draft for an org admin with the hosts appended, saved only by the person.
 */
export default async function SandboxSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ allowHost?: string | string[] }>;
}) {
  const { allowHost } = await searchParams;
  return <SandboxSettings allowHosts={parseAllowHostParam(allowHost)} />;
}
