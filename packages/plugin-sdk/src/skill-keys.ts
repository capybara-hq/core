/** Helpers shared by `skill.ts` and `skill-invocation.ts`. Not exported from the package. */

/** A name in a SKILL.md's `arguments` (referenced as `$name` in the body). */
export const SKILL_ARGUMENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * `argument-hint` as text. Claude Code's docs write it unquoted (`argument-hint: [issue-number]`),
 * which YAML reads as a list: a list of strings and numbers is written back as `[a, b]`.
 * Undefined for any other value.
 */
export function argumentHintText(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
    return `[${v.join(", ")}]`;
  }
  return undefined;
}
