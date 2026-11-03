import { listChannels } from "../channels";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org's channel connections (`{ channels }`, as the kernel answers). */
export const channelsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).channels(),
    fn: () => listChannels(orgId),
    freshness: "orgConfig",
  });
