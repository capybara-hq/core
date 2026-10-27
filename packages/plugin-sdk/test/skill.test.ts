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
        frontmatter: { name: "pdf-tools", description: "Work with PDFs. Use for PDFs." },
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
      frontmatter: { name: "a1", description: "line one line two\n" },
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
    expect(r).toMatchObject({ name: "x", description: "d", body: "# Title\n\nDo things.\n" });
  });

  it("parseSkillMd returns the whole frontmatter", () => {
    const front =
      "name: x\ndescription: d\ndisable-model-invocation: true\ncontext: fork\nallowed-tools: [Bash, Read]\nmodel: opus";
    const r = parseSkillMd(md(front));
    if ("errors" in r) throw new Error(r.errors.join("; "));
    expect(r.frontmatter).toEqual({
      name: "x",
      description: "d",
      "disable-model-invocation": true,
      context: "fork",
      "allowed-tools": ["Bash", "Read"],
      model: "opus",
    });
    expect(r.name).toBe("x");
    expect(r.description).toBe("d");
    expect(r.body).toBe("# Title\n\nDo things.\n");
    // A file with errors still returns only the errors.
    expect(parseSkillMd(md("name: Bad\ncontext: fork"))).toEqual({
      errors: [
        "name must be 1-64 lowercase letters, digits and single hyphens, not starting or ending with a hyphen",
        "description is required",
      ],
    });
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

  it("checks the types of the invocation keys", () => {
    const err = (front: string) => parseSkillMd(md(`name: x\ndescription: d\n${front}`));
    expect(err('disable-model-invocation: "yes"')).toEqual({
      errors: ["disable-model-invocation must be a boolean"],
    });
    expect(err("user-invocable: 1")).toEqual({ errors: ["user-invocable must be a boolean"] });
    expect(err("context: inline")).toEqual({ errors: ['context must be "fork"'] });
    expect(err(`agent: ""`)).toEqual({ errors: ["agent must be a string of 1-130 characters"] });
    expect(err(`agent: ${"a".repeat(131)}`)).toEqual({
      errors: ["agent must be a string of 1-130 characters"],
    });
    expect(err(`argument-hint: ${"h".repeat(201)}`)).toEqual({
      errors: ["argument-hint must be a string of at most 200 characters"],
    });
    expect(err("argument-hint: {a: 1}")).toEqual({
      errors: ["argument-hint must be a string of at most 200 characters"],
    });
    expect(err("arguments: issue")).toEqual({
      errors: ["arguments must be a list of at most 20 names"],
    });
    expect(err("arguments: [1bad]")).toEqual({
      errors: ["arguments must be a list of at most 20 names"],
    });
    const many = Array.from({ length: 21 }, (_, i) => `a${i}`).join(", ");
    expect(err(`arguments: [${many}]`)).toEqual({
      errors: ["arguments must be a list of at most 20 names"],
    });
    // Valid values, including Claude Code's unquoted `argument-hint: [issue-number]`.
    const ok = err(
      "disable-model-invocation: true\nuser-invocable: true\ncontext: fork\nagent: superpowers:code-reviewer\nargument-hint: [issue-number]\narguments: [issue, branch]",
    );
    expect("errors" in ok).toBe(false);
  });

  it("refuses a skill neither the model nor a person can invoke", () => {
    expect(
      parseSkillMd(
        md("name: x\ndescription: d\ndisable-model-invocation: true\nuser-invocable: false"),
      ),
    ).toEqual({
      errors: [
        "a skill with disable-model-invocation: true and user-invocable: false cannot be used",
      ],
    });
    expect("errors" in parseSkillMd(md("name: x\ndescription: d\nuser-invocable: false"))).toBe(
      false,
    );
  });

  it("skips the invocation key checks for stored files when asked", () => {
    const text = md("name: x\ndescription: d\ncontext: inline\ndisable-model-invocation: 1");
    expect("errors" in parseSkillMd(text)).toBe(true);
    expect(parseSkillMd(text, { invocationKeys: false })).toMatchObject({ name: "x" });
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
