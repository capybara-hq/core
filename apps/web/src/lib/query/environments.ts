import { getEnvironment, listEnvironments } from "../environments";
import { defineQuery } from "./define";
import { keys } from "./keys";

/**
 * The person's environments in the org (`{ items, defaultId, lastUsedId, cloudAvailable }`): the 环境
 * page, and the composer's picker and the properties panel read it too.
 */
export const environmentsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).environments(),
    fn: () => listEnvironments(orgId),
    freshness: "live",
  });

/** One environment (a 404 is the page's not-found). */
export const environmentQuery = (orgId: string, id: string) =>
  defineQuery({
    key: keys.org(orgId).environment(id),
    fn: () => getEnvironment(orgId, id),
    freshness: "live",
  });
