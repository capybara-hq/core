import { channelFormPreset } from "../../../../lib/channels-preset";
import NewChannelView from "./view";

/**
 * `/channels/new` (org admins; a setup step, web-order spec §3.8). It reads nothing: the layout
 * prefetches the org's extensions (its channel plugins) and agents on a first load
 * (`lib/query/routes.ts`); `?agentId=&returnTo=` come from `searchParams`.
 */
export default async function NewChannelPage({
  searchParams,
}: {
  searchParams: Promise<{ agentId?: string | string[]; returnTo?: string | string[] }>;
}) {
  return <NewChannelView preset={channelFormPreset(await searchParams)} />;
}
