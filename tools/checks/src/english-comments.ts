import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Finding, isParseError, listSourceFiles, parseFile } from "./source.js";

/** Han, kana, hangul, CJK punctuation and full-width forms. */
const CJK = /[　-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/;

/** The one directory scanned in full on every run. */
export const SDK_SRC_DIR = "packages/plugin-sdk/src";

/**
 * Marker for a comment that must quote CJK text (for example a comment showing what a term check
 * matches). It exempts every CJK line of its own comment and of the comment ending on the line
 * after it. Write the reason next to it.
 */
export const EXEMPT_MARKER = "english-comments-ok";

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/**
 * Paths whose CJK is data or a deliberate fixture, never prose: the check's own red fixtures and
 * the web message catalogs (the UI is localized there; `check:i18n` owns them).
 */
const EXEMPT_PATH = /^(?:tools\/checks\/fixtures\/|apps\/web\/messages\/)/;

const RULE = "cjk-comment";
const MESSAGE =
  "CJK in a comment: write comments in English (AGENTS.md, Language). Translate it (or quote CJK text in a comment marked english-comments-ok with a reason).";

/**
 * Lines of `file` whose comments contain CJK. Strings and template literals are never comments, so
 * test strings, message catalogs and the zh half of a bilingual `{ en, zh }` literal are exempt by
 * construction. `only`, when given, restricts the result to those 1-based lines.
 */
export function cjkCommentLines(file: string, only?: ReadonlySet<number>): Finding[] {
  const parsed = parseFile(file);
  if (isParseError(parsed)) return [parsed];
  const exemptLines = new Set<number>();
  for (const c of parsed.comments) {
    if (!c.value.includes(EXEMPT_MARKER)) continue;
    const first = parsed.lineOf(c.start);
    const last = parsed.lineOf(Math.max(c.start, c.end - 1));
    for (let l = first; l <= last + 1; l++) exemptLines.add(l);
  }
  const findings: Finding[] = [];
  const seen = new Set<number>();
  for (const c of parsed.comments) {
    const first = parsed.lineOf(c.start);
    c.value.split("\n").forEach((text, i) => {
      const line = first + i;
      if (!CJK.test(text) || seen.has(line)) return;
      if (exemptLines.has(line) || (only !== undefined && !only.has(line))) return;
      seen.add(line);
      findings.push({ file, line, rule: RULE, message: MESSAGE });
    });
  }
  return findings.sort((a, b) => a.line - b.line);
}

/** The SDK's source in full: every CJK comment line of `<root>/packages/plugin-sdk/src`. */
export function checkSdkComments(root: string): Finding[] {
  return listSourceFiles(join(root, SDK_SRC_DIR)).flatMap((f) => cjkCommentLines(f.file));
}

/** Added line numbers per file of a `git diff -U0` output (new-side numbers; deleted files skipped). */
export function addedLines(diff: string): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  let current: Set<number> | undefined;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4);
      if (path === "/dev/null") current = undefined;
      else {
        current = new Set();
        out.set(path.replace(/^b\//, ""), current);
      }
      continue;
    }
    const m = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (m && current !== undefined) {
      const start = Number(m[1]);
      const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let l = start; l < start + count; l++) current.add(l);
    }
  }
  return out;
}

/**
 * The comments a diff adds, anywhere in the repository: a CJK line of a comment on an added line
 * is reported (a pre-existing one is not, so nothing needs bulk translation; a comment edited
 * gets translated). `diff` is `git diff -U0` output against the merge base.
 */
export function checkAddedComments(root: string, diff: string): Finding[] {
  const findings: Finding[] = [];
  for (const [path, lines] of addedLines(diff)) {
    if (!SOURCE_EXT.test(path) || EXEMPT_PATH.test(path)) continue;
    if (path.split("/").includes("node_modules")) continue;
    const file = join(root, path);
    if (!existsSync(file)) continue;
    findings.push(...cjkCommentLines(file, lines));
  }
  return findings;
}

/** `git diff -U0 <base>...HEAD`: the merge-base diff of the checked-out branch. */
export function diffAgainstBase(root: string, base: string): string {
  return execFileSync("git", ["diff", "-U0", "--no-color", "--no-ext-diff", `${base}...HEAD`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}
