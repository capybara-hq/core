import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  addedLines,
  checkAddedComments,
  checkSdkComments,
  cjkCommentLines,
} from "../src/english-comments.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "english-comments-"));
  dirs.push(dir);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SOURCE = [
  "/** 渠道中立的卡片。 */",
  "export const a = 1; // 行尾注释",
  "/**",
  " * English line",
  " * 第二行是中文",
  " */",
  'export const b = "字符串里的中文不是注释";',
  "export const c = `模板 ${a} 字符串`;",
  "export const d = { en: 'ok', zh: '中文' };",
  "// plain English",
  "",
].join("\n");

describe("cjkCommentLines", () => {
  it("flags CJK in line, block and trailing comments, with the right lines", () => {
    const dir = repo({ "x.ts": SOURCE });
    const findings = cjkCommentLines(join(dir, "x.ts"));
    expect(findings.map((f) => [f.line, f.rule])).toEqual([
      [1, "cjk-comment"],
      [2, "cjk-comment"],
      [5, "cjk-comment"],
    ]);
  });

  it("does not flag strings, template literals or bilingual literals", () => {
    const dir = repo({ "x.ts": SOURCE.split("\n").slice(6, 9).join("\n") });
    expect(cjkCommentLines(join(dir, "x.ts"))).toEqual([]);
  });

  it("an english-comments-ok comment exempts itself and the comment on the next line", () => {
    const dir = repo({
      "x.ts": "// english-comments-ok: quotes the term 企业\n// 企业 again\nconst a = 1; // 企业\n",
    });
    expect(cjkCommentLines(join(dir, "x.ts")).map((f) => f.line)).toEqual([3]);
  });

  it("restricts to the given lines", () => {
    const dir = repo({ "x.ts": SOURCE });
    expect(cjkCommentLines(join(dir, "x.ts"), new Set([5])).map((f) => f.line)).toEqual([5]);
  });
});

describe("checkSdkComments", () => {
  it("reports a CJK comment under packages/plugin-sdk/src and ignores other directories", () => {
    const dir = repo({
      "packages/plugin-sdk/src/a.ts": "/** 中文注释 */\nexport const a = 1;\n",
      "packages/plugin-sdk/src/b.ts": "/** English */\nexport const b = '中文';\n",
      "packages/kernel/src/c.ts": "/** 中文注释 */\nexport const c = 1;\n",
    });
    expect(checkSdkComments(dir).map((f) => [f.file.slice(dir.length), f.line])).toEqual([
      ["/packages/plugin-sdk/src/a.ts", 1],
    ]);
  });
});

const DIFF = [
  "diff --git a/packages/kernel/src/c.ts b/packages/kernel/src/c.ts",
  "--- a/packages/kernel/src/c.ts",
  "+++ b/packages/kernel/src/c.ts",
  "@@ -1,0 +2,2 @@",
  "+// 新增的中文注释",
  "+const x = 1;",
  "diff --git a/old.ts b/old.ts",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-gone",
  "",
].join("\n");

describe("added lines", () => {
  it("reads new-side line numbers from a -U0 diff", () => {
    const lines = addedLines(DIFF);
    expect([...(lines.get("packages/kernel/src/c.ts") ?? [])]).toEqual([2, 3]);
    expect(lines.has("old.ts")).toBe(false);
  });

  it("reports an added CJK comment but not an old one, a string, an exempt path or a non-source file", () => {
    const dir = repo({
      "packages/kernel/src/c.ts": "// 旧的中文注释\n// 新增的中文注释\nconst x = '中文';\n",
      "apps/web/messages/zh.ts": "// 新增的中文注释\n",
      "tools/checks/fixtures/f/a.ts": "// 新增的中文注释\n",
      "docs/a.md": "新增\n",
    });
    const diff = [
      DIFF,
      "+++ b/apps/web/messages/zh.ts",
      "@@ -0,0 +1 @@",
      "+++ b/tools/checks/fixtures/f/a.ts",
      "@@ -0,0 +1 @@",
      "+++ b/docs/a.md",
      "@@ -0,0 +1 @@",
    ].join("\n");
    expect(checkAddedComments(dir, diff).map((f) => [f.file.slice(dir.length), f.line])).toEqual([
      ["/packages/kernel/src/c.ts", 2],
    ]);
  });
});

describe("the repository", () => {
  it("has no CJK comment in packages/plugin-sdk/src", () => {
    expect(checkSdkComments(repoRoot)).toEqual([]);
  });
});
