import { NoAccess } from "../../../../components/NoAccess";
import { listAgents } from "../../../../lib/agents";
import { channelFormPreset } from "../../../../lib/channels-preset";
import { listOrgExtensions, provides } from "../../../../lib/extensions";
import { read } from "../../../../lib/server/page";
import { workspace } from "../../../../lib/server/session";
import NewChannelView from "./view";

/**
 * `/channels/new` (org admins; a setup step, web-order spec §3.8): the org's enabled channel
 * plugins and its agents are read on the server; `?agentId=&returnTo=` come from `searchParams`.
 */
export default async function NewChannelPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string | string[]; returnTo?: string | string[] }>;
}) {
  const ws = await workspace({ min: "admin", setup: "step" });
  if (ws.kind === "noOrg") return null;
  if (ws.kind === "noAccess") return <NoAccess need={ws.need} />;
  const [{ extensions }, { agents }, query] = await Promise.all([
    read(listOrgExtensions(ws.orgId)),
    read(listAgents(ws.orgId)),
    searchParams,
  ]);
  return (
    <NewChannelView
      orgId={ws.orgId}
      initial={{
        plugins: extensions
          .filter((p) => p.enabled && provides(p, "channel"))
          .map((p) => ({ name: p.plugin, displayName: p.displayName ?? null })),
        agents,
        preset: channelFormPreset(query),
      }}
    />
  );
}
