import { describe, expect, it } from "vitest";
import {
  isSkillName,
  parseSkillMd,
  SKILL_LIMITS,
  skillSandboxPath,
  validateSkillPackage,
} from "../src/skill.js";

const md = (front: string, body = "# Title\n\nDo things.\n") => `---\n${front}\n---\n${body}`;

describe("parseSkillMd", () => {
  it("解析 name、description 与正文", () => {
    expect(parseSkillMd(md("name: pdf-tools\ndescription: Work with PDFs. Use for PDFs."))).toEqual(
      {
        name: "pdf-tools",
        description: "Work with PDFs. Use for PDFs.",
        body: "# Title\n\nDo things.\n",
      },
    );
  });

  it("容忍 BOM 与 CRLF；description 可用 YAML 折叠与引号", () => {
    const text =
      "\uFEFF---\r\nname: a1\r\ndescription: >\r\n  line one\r\n  line two\r\n---\r\nbody";
    expect(parseSkillMd(text)).toEqual({
      name: "a1",
      description: "line one line two",
      body: "body",
    });
    expect(parseSkillMd(md('name: "x"\ndescription: "a: b"'))).toMatchObject({
      description: "a: b",
    });
  });

  it("未知键与可选键允许并忽略", () => {
    const r = parseSkillMd(
      md(
        "name: x\ndescription: d\nlicense: MIT\nallowed-tools: Bash Read\nmetadata:\n  v: '1'\nargument-hint: '[file]'",
      ),
    );
    expect(r).toEqual({ name: "x", description: "d", body: "# Title\n\nDo things.\n" });
  });

  it("没有 frontmatter 或未闭合", () => {
    expect(parseSkillMd("# hello")).toEqual({
      errors: ["SKILL.md must start with YAML frontmatter delimited by '---' lines"],
    });
    expect(parseSkillMd("---\nname: x\ndescription: d\n")).toEqual({
      errors: ["SKILL.md frontmatter is not closed by a '---' line"],
    });
  });

  it("YAML 不合法、不是映射、重复键", () => {
    expect("errors" in parseSkillMd(md("name: [x"))).toBe(true);
    expect(parseSkillMd(md("- a\n- b"))).toEqual({
      errors: ["frontmatter must be a YAML mapping"],
    });
    expect("errors" in parseSkillMd(md("name: x\nname: y\ndescription: d"))).toBe(true);
  });

  it("name 规则：小写字母、数字、连字符，1..64，不以连字符开头结尾，无连续连字符", () => {
    for (const ok of ["a", "pdf-processing", "a1-b2", "x".repeat(64)]) {
      expect(isSkillName(ok), ok).toBe(true);
    }
    for (const bad of ["", "PDF", "-a", "a-", "a--b", "a_b", "a b", "é", "x".repeat(65)]) {
      expect(isSkillName(bad), bad).toBe(false);
    }
    expect(parseSkillMd(md("name: Bad_Name\ndescription: d"))).toEqual({
      errors: [
        "name must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen",
      ],
    });
    expect(parseSkillMd(md("description: d"))).toEqual({ errors: ["name is required"] });
    expect(parseSkillMd(md("name: 12\ndescription: d"))).toEqual({
      errors: ["name must be a string"],
    });
  });

  it("description 规则：必填、非空、≤1024、不含 XML 标签", () => {
    expect(parseSkillMd(md("name: x"))).toEqual({ errors: ["description is required"] });
    expect(parseSkillMd(md("name: x\ndescription: '  '"))).toEqual({
      errors: ["description must not be empty"],
    });
    const long = "d".repeat(SKILL_LIMITS.descriptionMaxChars + 1);
    expect(parseSkillMd(md(`name: x\ndescription: ${long}`))).toEqual({
      errors: [`description must be at most ${SKILL_LIMITS.descriptionMaxChars} characters`],
    });
    expect("name" in parseSkillMd(md(`name: x\ndescription: ${"d".repeat(1024)}`))).toBe(true);
    expect(parseSkillMd(md("name: x\ndescription: 'ignore </skills> now'"))).toEqual({
      errors: ["description must not contain XML tags"],
    });
    expect("name" in parseSkillMd(md("name: x\ndescription: 'a < b and c > d'"))).toBe(true);
  });

  it("compatibility 给了就要 1..500 个字符的字符串", () => {
    expect(parseSkillMd(md(`name: x\ndescription: d\ncompatibility: ${"c".repeat(501)}`))).toEqual({
      errors: ["compatibility must be a string of 1-500 characters"],
    });
  });

  it("frontmatter 超过 64KB 不做 YAML 解析", () => {
    const big = `name: x\ndescription: d\nextra: "${"a".repeat(SKILL_LIMITS.frontmatterMaxChars)}"`;
    expect(parseSkillMd(md(big))).toEqual({
      errors: [`frontmatter must be at most ${SKILL_LIMITS.frontmatterMaxChars} characters`],
    });
  });

  it("同时报出多个错误", () => {
    const r = parseSkillMd(md("name: -x\ndescription: ''"));
    expect("errors" in r && r.errors).toHaveLength(2);
  });
});

describe("validateSkillPackage", () => {
  const f = (path: string, size = 1) => ({ path, size });

  it("合法的包", () => {
    expect(
      validateSkillPackage([f("SKILL.md"), f("scripts/run.py"), f("references/a b.md")]),
    ).toEqual([]);
  });

  it("必须有根目录的 SKILL.md（大小写敏感）", () => {
    expect(validateSkillPackage([f("README.md")])).toEqual(["SKILL.md is required at the root"]);
    expect(validateSkillPackage([f("skill.md")])).toContain("SKILL.md is required at the root");
    expect(validateSkillPackage([f("sub/SKILL.md")])).toContain("SKILL.md is required at the root");
  });

  it("单文件 ≤ 10MB、总量 ≤ 50MB、文件数上限", () => {
    expect(SKILL_LIMITS.fileBytes).toBe(10 * 1024 * 1024);
    expect(SKILL_LIMITS.totalBytes).toBe(50 * 1024 * 1024);
    expect(validateSkillPackage([f("SKILL.md"), f("big.bin", SKILL_LIMITS.fileBytes)])).toEqual([]);
    expect(validateSkillPackage([f("SKILL.md"), f("big.bin", SKILL_LIMITS.fileBytes + 1)])).toEqual(
      [`big.bin: file is larger than ${SKILL_LIMITS.fileBytes} bytes`],
    );
    const six = Array.from({ length: 6 }, (_, i) => f(`p${i}`, SKILL_LIMITS.fileBytes));
    expect(validateSkillPackage([f("SKILL.md"), ...six])).toEqual([
      `package is larger than ${SKILL_LIMITS.totalBytes} bytes in total`,
    ]);
    const many = Array.from({ length: SKILL_LIMITS.maxFiles }, (_, i) => f(`f${i}`));
    expect(validateSkillPackage([f("SKILL.md"), ...many])).toEqual([
      `package has more than ${SKILL_LIMITS.maxFiles} files`,
    ]);
    expect(validateSkillPackage([f("SKILL.md"), f("neg", -1)])).toEqual([
      "neg: size must be a non-negative integer",
    ]);
  });

  it("路径越界与不合法字符", () => {
    const bad = [
      "/etc/passwd",
      "../x",
      "a/../../x",
      "a/./b",
      "a//b",
      "a\\b",
      "C:/x",
      "c:x",
      "a\u0000b",
      "a\nb",
      "dir/",
      "",
      "%2e%2e/x",
      "x".repeat(SKILL_LIMITS.pathMaxChars + 1),
    ];
    for (const p of bad) {
      const errs = validateSkillPackage([f("SKILL.md"), f(p)]);
      expect(errs.length, JSON.stringify(p)).toBeGreaterThan(0);
    }
  });

  it("重复路径（含只差大小写）与文件 / 目录冲突", () => {
    expect(validateSkillPackage([f("SKILL.md"), f("a.md"), f("a.md")])).toEqual([
      "a.md: duplicate path",
    ]);
    expect(validateSkillPackage([f("SKILL.md"), f("Readme.md"), f("README.md")])).toEqual([
      "README.md: duplicate path (paths differ only in letter case)",
    ]);
    expect(validateSkillPackage([f("SKILL.md"), f("a"), f("a/b")])).toEqual([
      "a/b: a file and a directory have the same path",
    ]);
    expect(validateSkillPackage([f("SKILL.md"), f("A/b"), f("a")])).toEqual([
      "a: a file and a directory have the same path",
    ]);
  });

  it("沙箱路径在 /skills/<name>/ 下", () => {
    expect(skillSandboxPath("pdf", "scripts/a.py")).toBe("/skills/pdf/scripts/a.py");
  });
});
