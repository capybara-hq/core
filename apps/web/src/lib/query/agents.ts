import { listAgents } from "../agents";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's agents list. */
export const agentsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).agents(),
    fn: () => listAgents(orgId),
    freshness: "orgConfig",
  });
