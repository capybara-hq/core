import { listSkillFilePreviewers, renderSkillFilePreview } from "../previewers";
import { getSkill, listSkillFiles, listSkills, previewSkillDelete, skillFileText } from "../skills";
import type { UiLocale } from "../ui";
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

/** A version's files (`null`: the current version; the answer names the version). */
export const skillFilesQuery = (orgId: string, skillId: string, version: number | null) =>
  defineQuery({
    key: keys.org(orgId).skillFiles(skillId, version),
    fn: () => listSkillFiles(orgId, skillId, version),
    freshness: "orgConfig",
  });

/** The extension previewers that take a skill file, in the org's order. */
export const skillFilePreviewersQuery = (
  orgId: string,
  skillId: string,
  version: number,
  path: string,
) =>
  defineQuery({
    key: keys.org(orgId).skillFile(skillId, version, path, "previewers"),
    fn: () => listSkillFilePreviewers(orgId, skillId, version, path).then((r) => r.previewers),
    freshness: "orgConfig",
  });

/** A skill file's render by a view previewer. */
export const skillFilePreviewQuery = (
  orgId: string,
  skillId: string,
  version: number,
  path: string,
  p: { plugin: string; id: string },
  locale: UiLocale,
) =>
  defineQuery({
    key: keys.org(orgId).skillFile(skillId, version, path, `${p.plugin}/${p.id}`, locale),
    fn: () => renderSkillFilePreview(orgId, skillId, version, path, p, locale).then((r) => r.view),
    freshness: "live",
  });

/** A skill file's text for the built-in previews (the first 1 MiB; `truncated` past it). */
export const skillFileTextQuery = (orgId: string, skillId: string, version: number, path: string) =>
  defineQuery({
    key: keys.org(orgId).skillFile(skillId, version, path, "builtin"),
    fn: ({ signal }) => skillFileText(orgId, skillId, version, path, signal),
    freshness: "live",
  });
