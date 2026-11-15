import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSkillMd } from "@capybara-hq/plugin-sdk";
import { parse } from "yaml";
import type { Finding } from "./source.js";

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/** The Agent Skills spec caps `description` at 1024 characters; spec-validating loaders skip longer. */
export const MAX_DESCRIPTION = 1024;

/**
 * Skill frontmatter (`name`, `description`) decides when an agent loads a skill, so it must stay in
 * English (AGENTS.md, "Rules by area", Language). Flags CJK characters in the frontmatter block of every
 * `<skillsDir>/<skill>/SKILL.md`, frontmatter that is not valid YAML (strict loaders reject the skill;
 * the usual cause is an unquoted `: ` inside a plain value), a `description` longer than the Agent
 * Skills limit of 1024 characters, and a SKILL.md with no frontmatter at all. Frontmatter must also
 * pass the runtime parser, so repository skills cannot silently disappear from project context.
 */
export function checkSkillsFrontmatter(skillsDir: string): Finding[] {
  if (!existsSync(skillsDir)) return [];
  const findings: Finding[] = [];
  const names = readdirSync(skillsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const name of names) {
    const file = join(skillsDir, name, "SKILL.md");
    if (!existsSync(file)) continue;
    const firstFinding = findings.length;
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    const end = lines[0]?.trim() === "---" ? lines.indexOf("---", 1) : -1;
    if (end === -1) {
      findings.push({
        file,
        line: 1,
        rule: "skills-frontmatter-missing",
        message: "SKILL.md must start with a frontmatter block delimited by `---` lines.",
      });
      continue;
    }
    for (let i = 1; i < end; i++) {
      if (CJK.test(lines[i] ?? "")) {
        findings.push({
          file,
          line: i + 1,
          rule: "skills-frontmatter-cjk",
          message:
            "Skill frontmatter must be English: it decides when the skill loads. Translate it.",
        });
      }
    }
    let data: unknown;
    try {
      data = parse(lines.slice(1, end).join("\n"));
    } catch (err) {
      findings.push({
        file,
        line: 1,
        rule: "skills-frontmatter-yaml",
        message:
          `The frontmatter is not valid YAML (${(err as Error).message.split("\n")[0]}); strict ` +
          "loaders skip the skill. Quote a value that contains `: ` (single quotes, `''` inside).",
      });
      continue;
    }
    const desc = (data as { description?: unknown } | null)?.description;
    const length = typeof desc === "string" ? [...desc].length : 0;
    if (length > MAX_DESCRIPTION) {
      const line = lines.findIndex((l, i) => i < end && l.startsWith("description:"));
      findings.push({
        file,
        line: line + 1,
        rule: "skills-frontmatter-length",
        message:
          `The description is ${length} characters; the Agent Skills limit is ${MAX_DESCRIPTION}, ` +
          "and loaders that validate it skip the skill. Keep the trigger keywords and move the " +
          "detailed enumerations into the body.",
      });
    }
    if (findings.length === firstFinding) {
      const parsed = parseSkillMd(lines.join("\n"));
      const errors =
        "errors" in parsed
          ? parsed.errors
          : parsed.name === name
            ? []
            : [`name must match its directory ${name}`];
      if (errors.length > 0) {
        findings.push({
          file,
          line: 1,
          rule: "skills-frontmatter-invalid",
          message:
            `The runtime cannot load this skill: ${errors.join("; ")}. ` +
            "Fix the frontmatter; use plain words for placeholders in the description.",
        });
      }
    }
  }
  return findings;
}
