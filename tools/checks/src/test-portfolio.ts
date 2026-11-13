import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  collectImports,
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
  stringValue,
  walk,
} from "./source.js";

/**
 * Test portfolio check (design `docs/superpowers/specs/2026-11-14-test-portfolio-design.md` §6):
 * the kernel test suite does not regrow its slow habits. Scans `packages/kernel/test/**\/*.test.ts`
 * only; a `changed` set narrows it to those files (the diff mode), and the checked-in grandfather
 * list (`tools/checks/test-portfolio-baseline.json`) skips a whole file until its T1/T2 batch
 * removes it.
 *
 * Rules:
 *
 * - `test-fixed-sleep`: a call to `sleep` with a numeric literal argument.
 * - `test-fixed-settimeout`: a `new Promise(…)` whose executor calls `setTimeout` with a numeric
 *   literal delay.
 * - `test-timeout-override`: a `timeout:` property of an options object, or a numeric timeout
 *   argument to `it` / `test` / `describe` / `before*` / `after*` (third argument for the first
 *   three, second for the hooks, as Vitest defines them).
 * - `test-small-app-file`: a file that imports `helpers/runs` or `helpers/http-app`, or calls
 *   `buildKernel` / `startKernel`, with at most 5 `it` / `test` calls.
 * - `test-double-boot`: more than one `buildKernel(` / `startKernel(` call in one file.
 * - `test-portfolio-list-overlap`: a path listed twice (the second occurrence is reported).
 * - `test-portfolio-missing-file`: a listed path with no file (reported on the list file).
 *
 * The wait rules match numeric literals only, so `sleep(TIMEOUT)` or a computed delay is not
 * reported; the app rules judge the import path and identifier calls textually, so an aliased
 * helper or a wrapper that boots is not seen. The README states these blind spots.
 */
export const KERNEL_TEST_DIR = "packages/kernel/test";
export const PORTFOLIO_BASELINE_FILE = "tools/checks/test-portfolio-baseline.json";
export const UNIT_LIST = "unit-tests.json";
export const CONTAINER_LIST = "container-tests.json";

const RULE = {
  sleep: "test-fixed-sleep",
  setTimeout: "test-fixed-settimeout",
  timeout: "test-timeout-override",
  smallApp: "test-small-app-file",
  doubleBoot: "test-double-boot",
  overlap: "test-portfolio-list-overlap",
  missing: "test-portfolio-missing-file",
} as const;

const TEST_FILE = /\.test\.ts$/;
const APP_IMPORT = /(?:^|\/)helpers\/(?:runs|http-app)(?:\.[cm]?[jt]s)?$/;
const TEST_CALL = new Set(["it", "test"]);
const TIMEOUT_CALL = new Set([
  "it",
  "test",
  "describe",
  "beforeAll",
  "beforeEach",
  "afterAll",
  "afterEach",
]);
const BOOT_CALL = new Set(["buildKernel", "startKernel"]);
/** The most `it` / `test` calls an app-booting file may have before it is merged into a bigger one. */
const SMALL_APP_TESTS = 5;

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** The numeric value of a number literal (`50`, `30_000`), else undefined. */
const numeric = (n: unknown): number | undefined =>
  isNode(n) && n.type === "Literal" && typeof n.value === "number" ? n.value : undefined;

/**
 * The base identifier of a call's callee: `it`, `test`, `startKernel`, also through a modifier
 * (`it.skip(…)`, `describe.each(…)(…)` is a call on a call and stays unrecognized).
 */
const callName = (callee: unknown): string | undefined => {
  if (!isNode(callee)) return undefined;
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && !callee.computed) {
    const object = callee.object as Node;
    if (object.type === "Identifier") return object.name as string;
  }
  return undefined;
};

/** The timeout argument position Vitest uses: `it(name, fn, timeout)` vs `beforeAll(fn, timeout)`. */
const timeoutIndex = (name: string): number =>
  name.startsWith("before") || name.startsWith("after") ? 1 : 2;

/** Whether a `new Promise(…)` executor calls `setTimeout` with a numeric literal delay. */
function fixedSetTimeout(executor: unknown): number | undefined {
  let delay: number | undefined;
  walk(executor, (n) => {
    if (delay !== undefined || n.type !== "CallExpression") return;
    if (callName(n.callee) !== "setTimeout") return;
    delay = numeric((n.arguments as unknown[])[1]);
  });
  return delay;
}

/** Reports the problems of one parsed test file, per-file rules last. */
function analyze(parsed: ParsedFile, file: string): Finding[] {
  const out: Finding[] = [];
  const add = (at: Node, rule: string, message: string) =>
    out.push({ file, line: parsed.lineOf(at.start), rule, message });

  let tests = 0;
  let boots = 0;
  let secondBootLine: number | undefined;
  /** The first line where the file shows it uses the kernel app (an import or a boot call). */
  let appEvidence: number | undefined;

  for (const ref of collectImports(parsed.program)) {
    if (!APP_IMPORT.test(ref.spec)) continue;
    const line = parsed.lineOf(ref.start);
    appEvidence = appEvidence === undefined ? line : Math.min(appEvidence, line);
  }

  walk(parsed.program, (n) => {
    if (n.type === "CallExpression") {
      const name = callName(n.callee);
      const args = n.arguments as unknown[];
      if (name === undefined) return;
      if (name === "sleep" && numeric(args[0]) !== undefined) {
        add(
          n,
          RULE.sleep,
          `fixed sleep of ${numeric(args[0])} ms; wait for the condition (waitFor) instead`,
        );
      }
      if (BOOT_CALL.has(name)) {
        boots += 1;
        const line = parsed.lineOf(n.start);
        appEvidence = appEvidence === undefined ? line : Math.min(appEvidence, line);
        if (boots === 2) secondBootLine = line;
      }
      if (TEST_CALL.has(name)) tests += 1;
      if (TIMEOUT_CALL.has(name)) {
        const index = timeoutIndex(name);
        const timeout = numeric(args[index]);
        if (timeout !== undefined) {
          add(
            n,
            RULE.timeout,
            `${name}(…) raises its timeout to ${timeout} ms; the project's timeout is the upper bound`,
          );
        }
      }
      return;
    }
    if (n.type === "NewExpression") {
      if (callName(n.callee) !== "Promise") return;
      const delay = fixedSetTimeout((n.arguments as unknown[])[0]);
      if (delay !== undefined) {
        add(
          n,
          RULE.setTimeout,
          `new Promise(…) waiting on a fixed setTimeout of ${delay} ms; wait for the condition instead`,
        );
      }
      return;
    }
    if (n.type === "Property" && !n.computed) {
      const key = n.key as Node;
      const name = key.type === "Identifier" ? (key.name as string) : stringValue(key);
      if (name === "timeout") {
        add(n, RULE.timeout, "a `timeout:` option overrides the project's timeout for this test");
      }
    }
  });

  if (appEvidence !== undefined && tests <= SMALL_APP_TESTS) {
    out.push({
      file,
      line: appEvidence,
      rule: RULE.smallApp,
      message: `boots the kernel app with only ${tests} it/test call(s) (at most ${SMALL_APP_TESTS}); merge it into a larger test file`,
    });
  }
  if (secondBootLine !== undefined) {
    out.push({
      file,
      line: secondBootLine,
      rule: RULE.doubleBoot,
      message: `boots the kernel ${boots} times (buildKernel/startKernel); boot it once and share it`,
    });
  }
  return out;
}

/** The repo-relative path of a file, always with forward slashes. */
const repoPath = (root: string, file: string): string => relative(root, file).split(sep).join("/");

/** Every kernel test file in the tree, repo-relative and sorted. */
function allTestFiles(root: string): string[] {
  return listSourceFiles(join(root, KERNEL_TEST_DIR))
    .map((s) => repoPath(root, s.file))
    .filter((p) => TEST_FILE.test(p))
    .sort();
}

/** The grandfather list: a checked-in `{ "files": string[] }` of repo-relative test paths. */
export function readBaseline(root: string): string[] {
  const file = join(root, PORTFOLIO_BASELINE_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown };
  if (!Array.isArray(parsed.files)) return [];
  return parsed.files.filter((f): f is string => typeof f === "string");
}

/**
 * The kernel test files `base...HEAD` changes, repo-relative; undefined when `base` does not
 * resolve (a non-merge checkout, e.g. a push to `main`), the caller then skips the check.
 */
export function changedTestFiles(cwd: string, base: string): Set<string> | undefined {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], {
      cwd,
      stdio: "pipe",
    });
  } catch {
    return undefined;
  }
  const out = execFileSync(
    "git",
    ["diff", "--name-only", "--no-ext-diff", "--relative", `${base}...HEAD`],
    { cwd, encoding: "utf8" },
  );
  return new Set(
    out
      .split("\n")
      .map((line) => line.trim())
      .filter((p) => p.startsWith(`${KERNEL_TEST_DIR}/`) && TEST_FILE.test(p)),
  );
}

/** One finding per problem in the test files, in path order. */
function checkFiles(root: string, paths: string[]): Finding[] {
  const out: Finding[] = [];
  for (const path of paths) {
    const file = join(root, path);
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      out.push(parsed);
      continue;
    }
    out.push(...analyze(parsed, file));
  }
  return out;
}

/** The `NNNN` line of one JSON string entry, searching from `fromLine` (1-based). */
function entryLine(lines: string[], entry: string, fromLine: number): number {
  const needle = JSON.stringify(entry);
  for (let i = Math.max(0, fromLine - 1); i < lines.length; i += 1) {
    if (lines[i]?.includes(needle)) return i + 1;
  }
  return fromLine;
}

/** A list file's entries, or empty when the list does not exist. */
function readList(
  root: string,
  name: string,
): { file: string; lines: string[]; entries: string[] } | undefined {
  const file = join(root, KERNEL_TEST_DIR, name);
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  const parsed = JSON.parse(text) as unknown;
  const entries = Array.isArray(parsed)
    ? parsed.filter((e): e is string => typeof e === "string")
    : [];
  return { file, lines: text.split("\n"), entries };
}

/** The list rules: no path listed twice, and every listed path exists. */
function checkLists(root: string): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, { file: string; line: number }>();
  const missing = new Set<string>();
  for (const name of [UNIT_LIST, CONTAINER_LIST]) {
    const list = readList(root, name);
    if (list === undefined) continue;
    let line = 1;
    for (const entry of list.entries) {
      line = entryLine(list.lines, entry, line);
      const previous = seen.get(entry);
      if (previous !== undefined) {
        out.push({
          file: list.file,
          line,
          rule: RULE.overlap,
          message: `"${entry}" is listed twice (first at ${repoPath(root, previous.file)}:${previous.line})`,
        });
      } else {
        seen.set(entry, { file: list.file, line });
      }
      if (!existsSync(join(root, KERNEL_TEST_DIR, entry)) && !missing.has(entry)) {
        missing.add(entry);
        out.push({
          file: list.file,
          line,
          rule: RULE.missing,
          message: `"${entry}" is listed but ${KERNEL_TEST_DIR}/${entry} does not exist`,
        });
      }
    }
  }
  return out;
}

export interface TestPortfolioOptions {
  root: string;
  /** The grandfather list; defaults to {@link PORTFOLIO_BASELINE_FILE} under `root`. */
  baseline?: string[];
  /** Repo-relative files to scan (diff mode); absent scans the whole tree. */
  changed?: Set<string>;
}

export function checkTestPortfolio({ root, baseline, changed }: TestPortfolioOptions): Finding[] {
  const skipped = new Set(baseline ?? readBaseline(root));
  const paths =
    changed === undefined
      ? allTestFiles(root)
      : [...changed]
          .filter((p) => p.startsWith(`${KERNEL_TEST_DIR}/`) && TEST_FILE.test(p))
          .filter((p) => existsSync(join(root, p)))
          .sort();
  const scanned = paths.filter((p) => !skipped.has(p));
  return [...checkFiles(root, scanned), ...checkLists(root)];
}

/**
 * The T1 candidate list: every problem in the kernel test files under `area` (a path under
 * `packages/kernel/test`, a repo-relative path, or an absolute one), ignoring the grandfather
 * list. The small app-booting files come first. One `<repo-relative path>\t<rule>` line per
 * problem; for humans, so it never fails.
 */
export function listCandidates(root: string, area: string): string[] {
  const dir = isAbsolute(area)
    ? area
    : area === KERNEL_TEST_DIR || area.startsWith(`${KERNEL_TEST_DIR}/`)
      ? join(root, area)
      : join(root, KERNEL_TEST_DIR, area);
  const files = listSourceFiles(dir)
    .map((s) => repoPath(root, s.file))
    .filter((p) => TEST_FILE.test(p))
    .sort();
  const findings: Finding[] = [];
  for (const path of files) {
    const file = join(root, path);
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      findings.push(parsed);
      continue;
    }
    findings.push(...analyze(parsed, file));
  }
  const small = findings.filter((f) => f.rule === RULE.smallApp);
  const rest = findings.filter((f) => f.rule !== RULE.smallApp);
  return [...small, ...rest].map((f) => `${repoPath(root, f.file)}\t${f.rule}`);
}
