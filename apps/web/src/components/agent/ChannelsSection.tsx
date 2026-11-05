"use client";

import { useQuery } from "@tanstack/react-query";
import { channelsQuery } from "../../lib/query/channels";
import { retryOnMountOf } from "../../lib/query/client";
import { AgentChannels } from "../AgentChannels";
import { AgentSectionFrame, useAgentPage } from "./frame";

/**
 * 渠道 Channels (agent profile design §3.2): the IM connections bound to this agent, as today.
 * Bindings are saved on their own channel pages, so the section has no save of its own.
 */
export function ChannelsSection() {
  const { orgId, agent } = useAgentPage();
  const q = channelsQuery(orgId);
  const channels = useQuery({ ...q, retryOnMount: retryOnMountOf(q.queryKey) });
  if (channels.data === undefined && channels.error === null) {
    return <AgentSectionFrame loading />;
  }
  return (
    <AgentSectionFrame>
      <AgentChannels
        agentId={agent.id}
        channels={channels.data?.channels.filter((c) => c.agentId === agent.id) ?? null}
      />
    </AgentSectionFrame>
  );
}
