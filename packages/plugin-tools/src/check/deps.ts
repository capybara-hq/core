import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectImports,
  type Finding,
  isParseError,
  listSourceFiles,
  parseFile,
} from "./source.js";

export type { Finding };

const SCOPE = "@capybara-hq/";
const SDK = "@capybara-hq/plugin-sdk";
const TESTING = "@capybara-hq/testing";
/** The scripted model provider that stays in core: plugin tests load it to drive agent runs. */
const MODEL_FAKE = "@capybara-hq/plugin-model-fake";
/** The plugin toolchain (`capybara-plugin`): a plugin repository's devDependency. */
const PLUGIN_TOOLS = "@capybara-hq/plugin-tools";
const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const SCOPED_RE = /@capybara-hq\/([A-Za-z0-9._-]+)/g;
const PATH_PROTOCOL_RE = /^(?:link|file|portal):/;

interface Rules {
  /** Rule for a reference to an `@capybara-hq/*` package that is not allowed. */
  pkgRule: string;
  /** Rule for a path that leaves the package directory. */
  outsideRule: string;
  pkgMessage: (what: string) => string;
  outsideMessage: (what: string) => string;
  /** Allowed `@capybara-hq/*` package names; `where` is where the reference is (devDependencies / source / test). */
  allowed: (pkg: string, where: string) => boolean;
}

const PLUGIN_RULES: Rules = {
  pkgRule: "plugin-imports-kernel",
  outsideRule: "plugin-imports-outside",
  pkgMessage: (what) =>
    `a plugin may depend only on ${SDK} and third-party npm packages, not on ${what}; what it needs comes through ctx (extend the plugin-sdk contract if it is missing)`,
  outsideMessage: (what) =>
    `${what} points outside the plugin directory, which bypasses the package check and depends on kernel sources directly; a plugin may reference only files inside its own directory`,
  allowed: (pkg, where) =>
    pkg === SDK ||
    ((pkg === TESTING || pkg === MODEL_FAKE || pkg === PLUGIN_TOOLS) &&
      (where === "devDependencies" || where === "test")),
};

const SDK_RULES: Rules = {
  pkgRule: "sdk-imports-internal",
  outsideRule: "sdk-imports-internal",
  pkgMessage: (what) =>
    `packages/plugin-sdk holds only types and pure functions and must not depend on any other @capybara-hq/* package (found ${what})`,
  outsideMessage: (what) =>
    `packages/plugin-sdk must not reference files outside its package directory (${what})`,
  allowed: () => false,
};

/** The violation a reference string (package name / relative path / file: URL / protocol dependency value) makes, if any. */
function judge(
  value: string,
  baseDir: string,
  rootDir: string,
  rules: Rules,
  where: string,
): "pkg" | "outside" | undefined {
  const pkgs = [...value.matchAll(SCOPED_RE)].map((m) => `${SCOPE}${m[1]}`);
  if (pkgs.some((p) => !rules.allowed(p, where))) return "pkg";
  let path: string | undefined;
  if (value.startsWith("file:///")) path = fileURLToPath(value);
  else if (PATH_PROTOCOL_RE.test(value))
    path = resolve(baseDir, value.replace(PATH_PROTOCOL_RE, ""));
  else if (value.startsWith(".") || isAbsolute(value)) path = resolve(baseDir, value);
  if (path !== undefined && relative(resolve(rootDir), path).startsWith("..")) return "outside";
  return undefined;
}

type Json = unknown;

/** Every string leaf of a JSON subtree. */
function leaves(v: Json): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(leaves);
  return [];
}

/** Reads package.json; undefined when there is none. */
function readPackage(
  dir: string,
): { file: string; lines: string[]; pkg: Record<string, Json> } | undefined {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return undefined;
  const text = readFileSync(file, "utf8");
  return { file, lines: text.split("\n"), pkg: JSON.parse(text) as Record<string, Json> };
}

function packageFindings(dir: string, rules: Rules): Finding[] {
  const loaded = readPackage(dir);
  if (!loaded) return [];
  const { file, lines, pkg } = loaded;
  const out: Finding[] = [];
  const lineOf = (needle: string) =>
    Math.max(lines.findIndex((l) => l.includes(`"${needle}"`)) + 1, 1);
  const add = (kind: "pkg" | "outside", where: string, name: string, what: string) =>
    out.push({
      file,
      line: lineOf(name),
      rule: kind === "pkg" ? rules.pkgRule : rules.outsideRule,
      message: `${name} in ${where}: ${kind === "pkg" ? rules.pkgMessage(what) : rules.outsideMessage(what)}`,
    });

  for (const field of DEP_FIELDS) {
    const deps = (pkg[field] ?? {}) as Record<string, string>;
    for (const [name, value] of Object.entries(deps)) {
      // Both the name and the value: an alias `"x": "npm:@capybara-hq/kernel@*"` has no scope in its name.
      const kind =
        judge(name, dir, dir, rules, field) ?? judge(String(value), dir, dir, rules, field);
      if (kind) add(kind, field, name, `${name}@${value}`);
    }
  }
  for (const field of ["bundleDependencies", "bundledDependencies"]) {
    const list = pkg[field];
    if (!Array.isArray(list)) continue;
    for (const name of list as string[]) {
      if (judge(name, dir, dir, rules, field) === "pkg") add("pkg", field, name, name);
    }
  }
  for (const field of ["imports", "exports"]) {
    const map = pkg[field];
    if (typeof map !== "object" || map === null) continue;
    for (const [key, v] of Object.entries(map)) {
      for (const target of leaves(v)) {
        const kind = judge(target, dir, dir, rules, field);
        if (kind) add(kind, field, key, target);
      }
    }
  }
  return out;
}

/** Expands a `#xxx` subpath import of the sources through the package.json imports map (empty when unmapped). */
function resolveHashImport(spec: string, imports: Record<string, Json>): string[] {
  const direct = imports[spec];
  if (direct !== undefined) return leaves(direct);
  for (const [key, v] of Object.entries(imports)) {
    const star = key.indexOf("*");
    if (star === -1) continue;
    const head = key.slice(0, star);
    const tail = key.slice(star + 1);
    if (spec.startsWith(head) && spec.endsWith(tail) && spec.length >= head.length + tail.length) {
      const mid = spec.slice(head.length, spec.length - tail.length);
      return leaves(v).map((t) => t.replace("*", mid));
    }
  }
  return [];
}

function sourceFindings(dir: string, rules: Rules, srcDir: string): Finding[] {
  const out: Finding[] = [];
  const loaded = readPackage(dir);
  const imports = (loaded?.pkg.imports ?? {}) as Record<string, Json>;
  // Dependency aliases: a dependency without a scope whose value is an @capybara-hq/* package; importing
  // the alias in the sources is importing that package.
  const aliases: string[] = [];
  for (const field of DEP_FIELDS) {
    for (const [name, value] of Object.entries(
      (loaded?.pkg[field] ?? {}) as Record<string, string>,
    )) {
      if (!name.startsWith(SCOPE) && judge(String(value), dir, dir, rules, field) === "pkg") {
        aliases.push(name);
      }
    }
  }

  for (const { file, isTest } of listSourceFiles(srcDir)) {
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      out.push(parsed);
      continue;
    }
    const where = isTest ? "test" : "source";
    for (const { spec, start } of collectImports(parsed.program)) {
      const line = parsed.lineOf(start);
      let kind = judge(spec, join(file, ".."), dir, rules, where);
      let shown = spec;
      if (!kind && aliases.some((a) => spec === a || spec.startsWith(`${a}/`))) kind = "pkg";
      if (!kind && spec.startsWith("#")) {
        for (const target of resolveHashImport(spec, imports)) {
          kind = judge(target, dir, dir, rules, where);
          if (kind) {
            shown = `${spec} -> ${target}`;
            break;
          }
        }
      }
      if (kind === "pkg")
        out.push({ file, line, rule: rules.pkgRule, message: rules.pkgMessage(shown) });
      else if (kind === "outside") {
        out.push({ file, line, rule: rules.outsideRule, message: rules.outsideMessage(shown) });
      }
    }
  }
  return out;
}

/**
 * The dependency boundary check.
 * - pluginDirs: each plugin directory (source imports and package.json); a violation is
 *   plugin-imports-kernel (a path leaving the plugin directory: plugin-imports-outside);
 * - sdkDirs: the packages/plugin-sdk directory; any @capybara-hq/* package or path leaving the
 *   package directory is sdk-imports-internal.
 *
 * Covers: import / export from / export * / import type / dynamic import("literal or concatenated
 * literals") / require("…") / import x = require() / import("x") types; package.json dependencies /
 * peerDependencies / devDependencies / optionalDependencies (name and value, so npm: / workspace:
 * aliases too) / bundleDependencies / link:|file:|portal: leaving the directory / imports and exports
 * map values; `#xxx` imports in the sources after expanding the imports map, and dependency aliases;
 * file: URLs and absolute paths count as leaving the directory.
 * Allowed in devDependencies and test files: @capybara-hq/testing and @capybara-hq/plugin-tools.
 * Also allowed there: `@capybara-hq/plugin-model-fake` (plugin tests drive agent runs with it).
 *
 * Known gaps: non-literal dynamic specifiers (`import(x)`); indirect require through a variable,
 * `module.require` or `createRequire(...)`; `import.meta.resolve`; paths built at run time to read
 * files; nested package.json files and TS `paths` mappings.
 */
export function checkDeps(pluginDirs: string[], sdkDirs: string[] = []): Finding[] {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    findings.push(...packageFindings(dir, PLUGIN_RULES), ...sourceFindings(dir, PLUGIN_RULES, dir));
  }
  for (const dir of sdkDirs) {
    findings.push(
      ...packageFindings(dir, SDK_RULES),
      ...sourceFindings(dir, SDK_RULES, join(dir, "src")),
    );
  }
  return findings;
}
