import { getSkill, listSkills } from "../skills";
import { defineQuery } from "./define";
import { keys } from "./keys";

/** The org skill library (`{ skills }`, as the kernel answers). */
export const skillsQuery = (orgId: string) =>
  defineQuery({
    key: keys.org(orgId).skills(),
    fn: () => listSkills(orgId),
    freshness: "orgConfig",
  });

/** One org skill with its versions (a 404 is the page's not-found). */
export const skillQuery = (orgId: string, skillId: string) =>
  defineQuery({
    key: keys.org(orgId).skill(skillId),
    fn: () => getSkill(orgId, skillId),
    freshness: "orgConfig",
  });
