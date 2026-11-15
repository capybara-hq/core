import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { checkSkillsFrontmatter } from "../src/skills-frontmatter.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];

function skills(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-fm-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, name, "SKILL.md"), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("checkSkillsFrontmatter", () => {
  it("flags CJK characters in the frontmatter description", () => {
    const dir = skills({
      a: "---\nname: a\ndescription: 给内核新增配置\n---\n\n# A\n",
    });
    const findings = checkSkillsFrontmatter(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      rule: "skills-frontmatter-cjk",
      file: join(dir, "a", "SKILL.md"),
      line: 3,
    });
  });

  it("flags CJK characters in the frontmatter name", () => {
    const dir = skills({ a: "---\nname: 技能\ndescription: ok\n---\n" });
    const findings = checkSkillsFrontmatter(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("skills-frontmatter-cjk");
    expect(findings[0]?.line).toBe(2);
  });

  it("ignores CJK characters in the body", () => {
    const dir = skills({ a: "---\nname: a\ndescription: ok\n---\n\n正文是中文\n" });
    expect(checkSkillsFrontmatter(dir)).toEqual([]);
  });

  it("flags a SKILL.md without frontmatter", () => {
    const dir = skills({ a: "# A\n\nno frontmatter\n" });
    const findings = checkSkillsFrontmatter(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe("skills-frontmatter-missing");
  });

  it("flags a description longer than 1024 characters", () => {
    const dir = skills({ a: `---\nname: a\ndescription: ${"x".repeat(1025)}\n---\n` });
    const findings = checkSkillsFrontmatter(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "skills-frontmatter-length", line: 3 });
    expect(findings[0]?.message).toContain("1025");
  });

  it("accepts a description of exactly 1024 characters", () => {
    const dir = skills({ a: `---\nname: a\ndescription: ${"x".repeat(1024)}\n---\n` });
    expect(checkSkillsFrontmatter(dir)).toEqual([]);
  });

  it("counts a folded multi-line description as one value", () => {
    const long = `${"x".repeat(600)}\n  ${"y".repeat(600)}`;
    const dir = skills({ a: `---\nname: a\ndescription: >-\n  ${long}\n---\n` });
    expect(checkSkillsFrontmatter(dir).map((f) => f.rule)).toEqual(["skills-frontmatter-length"]);
  });

  it("flags frontmatter that is not valid YAML (an unquoted ': ' in a plain value)", () => {
    const dir = skills({
      a: "---\nname: a\ndescription: Use when adding tools: names and keys\n---\n",
    });
    const findings = checkSkillsFrontmatter(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: "skills-frontmatter-yaml", line: 1 });
  });

  it("accepts a quoted value that contains ': '", () => {
    const dir = skills({ a: "---\nname: a\ndescription: 'Use when adding tools: names'\n---\n" });
    expect(checkSkillsFrontmatter(dir)).toEqual([]);
  });

  it("rejects descriptions the runtime cannot load, including XML-shaped placeholders", () => {
    const dir = skills({
      a: "---\nname: a\ndescription: 'Use the <plugin>:<name> skill'\n---\n",
    });
    expect(checkSkillsFrontmatter(dir)).toEqual([
      expect.objectContaining({
        rule: "skills-frontmatter-invalid",
        message: expect.stringContaining("description must not contain XML tags"),
      }),
    ]);
  });

  it("allows placeholders in the skill body and comparison operators in its description", () => {
    const dir = skills({
      a: "---\nname: a\ndescription: 'Use when a < b and c > d'\n---\n\nUse <plugin>:<name>.\n",
    });
    expect(checkSkillsFrontmatter(dir)).toEqual([]);
  });

  it("rejects a name that differs from the project skill directory", () => {
    const dir = skills({ a: "---\nname: b\ndescription: A skill\n---\n" });
    expect(checkSkillsFrontmatter(dir)).toEqual([
      expect.objectContaining({
        rule: "skills-frontmatter-invalid",
        message: expect.stringContaining("name must match its directory a"),
      }),
    ]);
  });

  it("passes on the repository skills", () => {
    expect(checkSkillsFrontmatter(join(repoRoot, ".agents/skills"))).toEqual([]);
  });
});
