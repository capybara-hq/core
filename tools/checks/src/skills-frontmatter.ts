import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./source.js";

const CJK = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/**
 * Skill frontmatter (`name`, `description`) decides when an agent loads a skill, so it must stay in
 * English (AGENTS.md "Language"). Flags CJK characters in the frontmatter block of every
 * `<skillsDir>/<skill>/SKILL.md`, and a SKILL.md with no frontmatter at all. The body is not checked.
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
  }
  return findings;
}
