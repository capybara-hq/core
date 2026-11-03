import { getAgent, listAgents } from "../agents";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's agents list. */
export const agentsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).agents(),
    fn: () => listAgents(orgId),
    freshness: "orgConfig",
  });

/** One agent (a 404 is the page's not-found). */
export const agentQuery = (orgId: string, agentId: string) =>
  defineQuery({
    key: keys.org(orgId).agent(agentId),
    fn: () => getAgent(orgId, agentId).then((r) => r.agent),
    freshness: "orgConfig",
  });
