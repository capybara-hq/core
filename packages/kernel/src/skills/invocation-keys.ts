import { parseSkillMd } from "@capybara-hq/plugin-sdk";

/**
 * The SKILL.md invocation keys (package ecosystem phase D) and their lenient reading: readers of
 * stored files (catalog install and upgrade) and the Claude Code translation drop a key the strict
 * `parseSkillMd` checks would refuse, with the reason, instead of refusing the skill or storing an
 * invocation nobody can use. Uploads, native imports and `skill_write` stay strict.
 */

/** The frontmatter keys that make up a skill's invocation metadata. */
export const INVOCATION_KEYS = [
  "disable-model-invocation",
  "user-invocable",
  "context",
  "agent",
  "argument-hint",
  "arguments",
] as const;

const NOBODY =
  "a skill with disable-model-invocation: true and user-invocable: false cannot be used";

/** One dropped key (or `a, b` for a pair) and the strict check's reason (English). */
export interface DroppedInvocationKey {
  key: string;
  problem: string;
}

/**
 * The frontmatter without the invocation keys the strict checks refuse (each checked on its own by
 * `parseSkillMd`, so the rules stay in one place), and what was dropped. When both
 * `disable-model-invocation: true` and `user-invocable: false` remain, both go: the skill is then an
 * ordinary one, as it was before phase D. Other keys are untouched.
 */
export function cleanInvocationKeys(fm: Readonly<Record<string, unknown>>): {
  frontmatter: Record<string, unknown>;
  dropped: DroppedInvocationKey[];
} {
  const frontmatter: Record<string, unknown> = { ...fm };
  const dropped: DroppedInvocationKey[] = [];
  for (const key of INVOCATION_KEYS) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    const probe = JSON.stringify({ name: "x", description: "x", [key]: value });
    const r = parseSkillMd(`---\n${probe}\n---\n`);
    if ("errors" in r) {
      dropped.push({ key, problem: r.errors.join("; ") });
      delete frontmatter[key];
    }
  }
  if (frontmatter["disable-model-invocation"] === true && frontmatter["user-invocable"] === false) {
    delete frontmatter["disable-model-invocation"];
    delete frontmatter["user-invocable"];
    dropped.push({ key: "disable-model-invocation, user-invocable", problem: NOBODY });
  }
  return { frontmatter, dropped };
}
