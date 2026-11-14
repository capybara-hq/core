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
 * - `test-timeout-override`: a `timeout:` property of the options object of `it` / `test` /
 *   `describe` / `before*` / `after*` (the argument before the test function, or the second
 *   argument of a hook), or a numeric timeout argument to those calls (third argument for the
 *   first three, second for the hooks, as Vitest defines them). A `timeout:` key elsewhere (a
 *   tool input such as Bash `{ timeout: 5000 }`, an expected literal) is not reported.
 * - `test-small-app-file`: a file with at most 5 `it` / `test` calls that boots an app: an import
 *   of `helpers/http-app`, a `buildKernel` / `startKernel` call, or a call to an exported helper
 *   that boots (scanned below).
 * - `test-double-boot`: more than one `buildKernel(` / `startKernel(` call in one file.
 * - `test-portfolio-list-overlap`: a path listed twice (the second occurrence is reported).
 * - `test-portfolio-missing-file`: a listed path with no file (reported on the list file).
 * - `test-portfolio-baseline-unjustified`: a grandfather entry (the baseline's `files` object
 *   maps a repo-relative path to the reason it stays) with an empty reason.
 * - `test-portfolio-baseline-removed-claim`: a grandfather entry whose reason says the file was
 *   removed (`removed`, `deleted`, `gone`) while the file still exists: a batch that only removed
 *   the file's violations must drop the entry, and one that removed the file must not leave a
 *   reason behind.
 * - `test-portfolio-baseline-stale`: a grandfather entry whose file no longer violates (or no
 *   longer exists); it is removed together with its batch, so it must not linger.
 *
 * The wait rules match numeric literals only, so `sleep(TIMEOUT)` or a computed delay is not
 * reported; the app rules judge the import path and identifier calls textually, so an aliased
 * helper is not seen. The README states these blind spots.
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
  unjustified: "test-portfolio-baseline-unjustified",
  removedClaim: "test-portfolio-baseline-removed-claim",
  stale: "test-portfolio-baseline-stale",
} as const;

/** A grandfather reason that claims its file was removed; its file must therefore be gone. */
const REMOVED_CLAIM = /removed|deleted|gone/i;

const TEST_FILE = /\.test\.ts$/;
const APP_IMPORT = /(?:^|\/)helpers\/http-app(?:\.[cm]?[jt]s)?$/;
const ENV_FILE = /-env\.ts$/;
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

const isHook = (name: string): boolean => name.startsWith("before") || name.startsWith("after");

/** A node that can be the test function argument: an arrow, a function expression or an identifier. */
const isFunctionArgument = (n: unknown): boolean =>
  isNode(n) &&
  (n.type === "ArrowFunctionExpression" ||
    n.type === "FunctionExpression" ||
    n.type === "Identifier");

/**
 * The options object of a Vitest call: the argument before its test function (`it(name, options,
 * fn)`), or the second argument of a hook (`beforeAll(fn, options)`).
 */
function optionsObject(name: string, args: unknown[]): Node | undefined {
  let candidate: unknown;
  if (isHook(name)) {
    candidate = args[1];
  } else {
    const fn = args.findIndex(isFunctionArgument);
    candidate = fn > 1 ? args[fn - 1] : undefined;
  }
  return isNode(candidate) && candidate.type === "ObjectExpression" ? candidate : undefined;
}

/** The `timeout:` property of an options object, when it has one. */
function timeoutProperty(options: Node): Node | undefined {
  for (const prop of options.properties as Node[]) {
    if (prop.type !== "Property" || prop.computed) continue;
    const key = prop.key as Node;
    const name = key.type === "Identifier" ? (key.name as string) : stringValue(key);
    if (name === "timeout") return prop;
  }
  return undefined;
}

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

/** The exported functions of a module and their bodies (declarations and const arrows). */
function exportedFunctions(parsed: ParsedFile): { name: string; body: unknown }[] {
  const out: { name: string; body: unknown }[] = [];
  for (const statement of parsed.program.body as Node[]) {
    if (statement.type !== "ExportNamedDeclaration") continue;
    const declaration = statement.declaration as Node | null | undefined;
    if (!isNode(declaration)) continue;
    if (declaration.type === "FunctionDeclaration") {
      const id = declaration.id as Node | null;
      if (id?.type === "Identifier" && typeof id.name === "string") {
        out.push({ name: id.name, body: declaration.body });
      }
    } else if (declaration.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations as Node[]) {
        const id = declarator.id as Node;
        const init = declarator.init as unknown;
        if (id.type !== "Identifier" || typeof id.name !== "string" || !isNode(init)) continue;
        if (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression") continue;
        out.push({ name: id.name, body: init.body });
      }
    }
  }
  return out;
}

/** Whether a function body calls one of `symbols` (by name). */
const callsAny = (body: unknown, symbols: Set<string>): boolean => {
  let found = false;
  walk(body, (n) => {
    if (found || n.type !== "CallExpression") return;
    const name = callName(n.callee);
    if (name !== undefined && symbols.has(name)) found = true;
  });
  return found;
};

/**
 * The exported helpers that boot the kernel app: `buildKernel` / `startKernel` themselves, plus
 * every exported function in `helpers/*.ts` or `*-env.ts` whose body calls one of them or another
 * such helper (transitively). A test file calling one of these names boots an app.
 */
export function bootingSymbols(root: string): Set<string> {
  const testDir = join(root, KERNEL_TEST_DIR);
  const files = [...listSourceFiles(join(testDir, "helpers")), ...listSourceFiles(testDir)]
    .map((s) => s.file)
    .filter((f) => f.startsWith(join(testDir, "helpers") + sep) || ENV_FILE.test(f))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort();
  const defined: { name: string; body: unknown }[] = [];
  for (const file of files) {
    const parsed = parseFile(file);
    if (isParseError(parsed)) continue;
    defined.push(...exportedFunctions(parsed));
  }
  const boots = new Set<string>(BOOT_CALL);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { name, body } of defined) {
      if (boots.has(name) || !callsAny(body, boots)) continue;
      boots.add(name);
      grew = true;
    }
  }
  return boots;
}

/** Reports the problems of one parsed test file, per-file rules last. */
function analyze(parsed: ParsedFile, file: string, bootSymbols: Set<string>): Finding[] {
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
      } else if (bootSymbols.has(name)) {
        const line = parsed.lineOf(n.start);
        appEvidence = appEvidence === undefined ? line : Math.min(appEvidence, line);
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
        const options = optionsObject(name, args);
        const property = options === undefined ? undefined : timeoutProperty(options);
        if (property !== undefined) {
          add(
            property,
            RULE.timeout,
            "a `timeout:` option overrides the project's timeout for this test",
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

/** One grandfather entry: the repo-relative test path and why it still violates. */
export interface BaselineEntry {
  path: string;
  reason: string;
}

/** The grandfather list: a checked-in `{ "files": { "<path>": "<reason>" } }` object. */
export function readBaseline(root: string): BaselineEntry[] {
  const file = join(root, PORTFOLIO_BASELINE_FILE);
  if (!existsSync(file)) return [];
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { files?: unknown };
  const files = parsed.files;
  if (typeof files !== "object" || files === null || Array.isArray(files)) return [];
  return Object.entries(files).map(([path, reason]) => ({
    path,
    reason: typeof reason === "string" ? reason.trim() : "",
  }));
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
function checkFiles(root: string, paths: string[], bootSymbols: Set<string>): Finding[] {
  const out: Finding[] = [];
  for (const path of paths) {
    const file = join(root, path);
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      out.push(parsed);
      continue;
    }
    out.push(...analyze(parsed, file, bootSymbols));
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
  baseline?: BaselineEntry[];
  /** Repo-relative files to scan (diff mode); absent scans the whole tree. */
  changed?: Set<string>;
}

export function checkTestPortfolio({ root, baseline, changed }: TestPortfolioOptions): Finding[] {
  const entries = baseline ?? readBaseline(root);
  // Only a justified entry grants the file-level skip; an unjustified one is itself a finding.
  const skipped = new Set(entries.filter((e) => e.reason !== "").map((e) => e.path));
  const paths =
    changed === undefined
      ? allTestFiles(root)
      : [...changed]
          .filter((p) => p.startsWith(`${KERNEL_TEST_DIR}/`) && TEST_FILE.test(p))
          .filter((p) => existsSync(join(root, p)))
          .sort();
  const scanned = new Set(paths);
  const findings = checkFiles(root, paths, bootingSymbols(root));

  // Count findings per file so the baseline rules can tell a justified entry from a stale one.
  const perFile = new Map<string, number>();
  const out: Finding[] = [];
  for (const finding of findings) {
    const path = repoPath(root, finding.file);
    perFile.set(path, (perFile.get(path) ?? 0) + 1);
    if (!skipped.has(path)) out.push(finding);
  }

  const baselineFile = join(root, PORTFOLIO_BASELINE_FILE);
  const lines = existsSync(baselineFile) ? readFileSync(baselineFile, "utf8").split("\n") : [];
  let line = 1;
  for (const entry of entries) {
    line = entryLine(lines, entry.path, line);
    if (entry.reason === "") {
      out.push({
        file: baselineFile,
        line,
        rule: RULE.unjustified,
        message: `"${entry.path}" is grandfathered without a reason; say why it stays or run its T1/T2 batch`,
      });
    }
    const fileExists = existsSync(join(root, entry.path));
    if (entry.reason !== "" && REMOVED_CLAIM.test(entry.reason) && fileExists) {
      out.push({
        file: baselineFile,
        line,
        rule: RULE.removedClaim,
        message: `"${entry.path}" says it was removed, but the file still exists; drop the entry or rewrite the reason`,
      });
    }
    // In diff mode only a changed file can be judged stale; a full run judges every entry.
    const judgeable = changed === undefined || scanned.has(entry.path);
    if (judgeable && (perFile.get(entry.path) ?? 0) === 0) {
      out.push({
        file: baselineFile,
        line,
        rule: RULE.stale,
        message: `"${entry.path}" is grandfathered but no longer violates; remove it`,
      });
    }
  }

  return [...out, ...checkLists(root)];
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
  const bootSymbols = bootingSymbols(root);
  for (const path of files) {
    const file = join(root, path);
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      findings.push(parsed);
      continue;
    }
    findings.push(...analyze(parsed, file, bootSymbols));
  }
  const small = findings.filter((f) => f.rule === RULE.smallApp);
  const rest = findings.filter((f) => f.rule !== RULE.smallApp);
  return [...small, ...rest].map((f) => `${repoPath(root, f.file)}\t${f.rule}`);
}
