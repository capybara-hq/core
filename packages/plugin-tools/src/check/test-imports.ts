import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
  collectImports,
  type Finding,
  isParseError,
  type Node,
  parseFile,
  stringValue,
  walk,
} from "./source.js";

/**
 * `@capybara-hq/*` packages a plugin test may use besides the plugin itself: the SDK, the test
 * helpers, and model-fake (the scripted model provider published from core), which a test loads by
 * package name to drive agent runs.
 */
export const PLUGIN_TEST_PACKAGES = [
  "@capybara-hq/plugin-sdk",
  "@capybara-hq/testing",
  "@capybara-hq/plugin-model-fake",
];

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** A relative path in a string or template literal (`./x`, `../x`). */
const RELATIVE_STRING = /(["'`])(\.{1,2}\/[^"'`$]*)/g;
/** A repo-root path into core: `"packages/…"`, `"apps/…"`, or after an interpolation `${root}/apps/…`. */
const ROOTED_STRING = /(?:["'`]|\}\/?)((?:packages|apps)\/[a-z0-9][^"'`$]*)/g;
/** An `@capybara-hq/<name>` package name (with an optional subpath); group 1 is the package. */
const SCOPED_NAME = /^(@capybara-hq\/[^/\s]+)(?:\/\S*)?$/;
/** The path functions whose `..` segments are followed: `join`, `resolve`, `path.join`, `posix.resolve`… */
const PATH_CALL = new Set(["join", "resolve"]);

const lineAt = (source: string, offset: number) => source.slice(0, offset).split("\n").length;

function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p));
    else if (e.isFile() && SOURCE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

const calleeName = (callee: Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name as string;
  if (callee.type === "MemberExpression" && !callee.computed) {
    return ((callee.property as Node).name as string | undefined) ?? undefined;
  }
  return undefined;
};

/**
 * Where a `join(...)` / `resolve(...)` call whose literal arguments hold a bare `..` segment points,
 * when that can be told: the first argument is taken as the file's own directory when it is not a
 * literal (`here`, `__dirname`, `import.meta.dirname`), then the literal arguments are applied in
 * order until a non-literal one. `undefined` when no literal argument has a `..` segment.
 */
function pathCallTarget(call: Node, file: string): string | undefined {
  const args = call.arguments as Node[];
  const values = args.map((a) => stringValue(a));
  const hasDotDot = values.some((v) => v?.split(/[\\/]/).includes("..") === true);
  if (!hasDotDot) return undefined;
  // A first literal argument is relative to the process's directory: a `..` there leaves anything.
  let at = values[0] === undefined ? dirname(file) : resolve(dirname(file), "/");
  for (const [i, v] of values.entries()) {
    if (v === undefined) {
      if (i === 0) continue;
      break;
    }
    at = resolve(at, v);
  }
  return at;
}

/**
 * `plugin-test-imports`: a test of a plugin (any file under `<plugin>/test`) reaches nothing outside
 * the plugin, so it keeps working in a repository of its own (the official plugins live in
 * `capybara-hq/plugins`; package ecosystem spec §6.2):
 * - no import of an `@capybara-hq/*` package other than {@link PLUGIN_TEST_PACKAGES} and the plugin
 *   itself, nor such a package name written as a string (a name in a kernel `extensions` list,
 *   `require.resolve`);
 * - no relative import or path string (`../x`) that leaves the plugin directory, and no `join` /
 *   `resolve` whose bare `..` arguments leave it (taken from the file's directory);
 * - no repo-root path into `packages/` or `apps/` (core's layout).
 * A kernel facility a plugin test needs is exported by `@capybara-hq/testing`.
 */
export function checkPluginTestImports(pluginDirs: string[]): Finding[] {
  const out: Finding[] = [];
  for (const pluginDir of pluginDirs) {
    const pkgFile = join(pluginDir, "package.json");
    const name = existsSync(pkgFile)
      ? (JSON.parse(readFileSync(pkgFile, "utf8")) as { name?: unknown }).name
      : undefined;
    const own = typeof name === "string" ? name : undefined;
    const allowed = new Set([...PLUGIN_TEST_PACKAGES, ...(own === undefined ? [] : [own])]);
    for (const file of listFiles(join(pluginDir, "test"))) {
      out.push(...fileFindings(file, pluginDir, allowed));
    }
  }
  return out;
}

function fileFindings(file: string, pluginDir: string, allowed: Set<string>): Finding[] {
  const out: Finding[] = [];
  const source = readFileSync(file, "utf8");
  const inside = (p: string) => !relative(pluginDir, p).startsWith("..");
  const seen = new Set<number>();
  const add = (offset: number, what: string) => {
    const line = lineAt(source, offset);
    if (seen.has(line)) return;
    seen.add(line);
    out.push({
      file,
      line,
      rule: "plugin-test-imports",
      message:
        `${what}: a plugin test may use only ${[...allowed].join(", ")} and files inside its ` +
        "plugin directory (it must keep working in its own repository); export a missing kernel " +
        "facility from @capybara-hq/testing",
    });
  };
  const parsed = parseFile(file);
  if (isParseError(parsed)) {
    out.push(parsed);
  } else {
    const imports = new Set<number>();
    for (const { spec, start } of collectImports(parsed.program)) {
      imports.add(start);
      const scoped = SCOPED_NAME.exec(spec)?.[1];
      if (scoped !== undefined && !allowed.has(scoped)) add(start, `imports ${spec}`);
    }
    walk(parsed.program, (n) => {
      if (n.type === "Literal" || n.type === "TemplateLiteral") {
        const v = stringValue(n);
        const scoped = v === undefined ? undefined : SCOPED_NAME.exec(v)?.[1];
        if (scoped !== undefined && !allowed.has(scoped)) {
          add(n.start, `names the package ${v}`);
        }
      }
      if (n.type === "CallExpression") {
        const callee = calleeName(n.callee as Node);
        if (callee === undefined || !PATH_CALL.has(callee)) return;
        const target = pathCallTarget(n, file);
        if (target !== undefined && !inside(target)) {
          add(n.start, `the ".." segments of this ${callee}() leave the plugin directory`);
        }
      }
    });
  }
  for (const m of source.matchAll(RELATIVE_STRING)) {
    const p = m[2] ?? "";
    if (!inside(resolve(dirname(file), p))) {
      add(m.index ?? 0, `${p} leaves the plugin directory`);
    }
  }
  for (const m of source.matchAll(ROOTED_STRING)) {
    add(m.index ?? 0, `${m[1] ?? ""} is a path into core`);
  }
  return out;
}
