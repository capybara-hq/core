import { listSkills } from "../skills";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org skill library (`{ skills }`, as the kernel answers). */
export const skillsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).skills(),
    fn: () => listSkills(orgId),
    freshness: "orgConfig",
  });
