import { getSkill, listSkills, previewSkillDelete } from "../skills";
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

/** What deleting the org's skill does (read when the delete is asked for; it moves on its own). */
export const skillDeletePreviewQuery = (orgId: string, skillId: string) =>
  defineQuery({
    key: keys.org(orgId).skillDeletePreview(skillId),
    fn: () => previewSkillDelete(orgId, skillId),
    freshness: "live",
  });
