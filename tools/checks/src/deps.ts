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
const DEP_FIELDS = [
  "dependencies",
  "peerDependencies",
  "devDependencies",
  "optionalDependencies",
] as const;
const SCOPED_RE = /@capybara-hq\/([A-Za-z0-9._-]+)/g;
const PATH_PROTOCOL_RE = /^(?:link|file|portal):/;

interface Rules {
  /** 引用了不该引用的 @capybara-hq/* 包时的 rule。 */
  pkgRule: string;
  /** 路径逃出包目录时的 rule。 */
  outsideRule: string;
  pkgMessage: (what: string) => string;
  outsideMessage: (what: string) => string;
  /** 允许的 @capybara-hq/* 包全名；field 为引用所在位置（devDependencies / source / test）。 */
  allowed: (pkg: string, where: string) => boolean;
}

const PLUGIN_RULES: Rules = {
  pkgRule: "plugin-imports-kernel",
  outsideRule: "plugin-imports-outside",
  pkgMessage: (what) =>
    `插件只能依赖 ${SDK} 与第三方 npm 包，不能依赖 ${what}；需要的能力应通过 ctx 提供（缺了就扩 plugin-sdk 的契约）`,
  outsideMessage: (what) =>
    `${what} 指向插件目录之外，等于绕过包名检查直接依赖内核源码；插件只能引用自己目录内的文件`,
  allowed: (pkg, where) =>
    pkg === SDK ||
    ((pkg === TESTING || pkg === MODEL_FAKE) && (where === "devDependencies" || where === "test")),
};

const SDK_RULES: Rules = {
  pkgRule: "sdk-imports-internal",
  outsideRule: "sdk-imports-internal",
  pkgMessage: (what) =>
    `packages/plugin-sdk 只含类型与纯函数，不得依赖其他 @capybara-hq/* 包（出现 ${what}）`,
  outsideMessage: (what) => `packages/plugin-sdk 不得引用包目录之外的文件（${what}）`,
  allowed: () => false,
};

/** 一个引用字符串（包名 / 相对路径 / file: URL / 带协议的依赖值）对应的违规类型。 */
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

/** 收集 JSON 子树里的所有字符串叶子。 */
function leaves(v: Json): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(leaves);
  if (typeof v === "object" && v !== null) return Object.values(v).flatMap(leaves);
  return [];
}

/** 读 package.json；不存在返回 undefined。 */
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
      message: `${where} 中的 ${name}：${kind === "pkg" ? rules.pkgMessage(what) : rules.outsideMessage(what)}`,
    });

  for (const field of DEP_FIELDS) {
    const deps = (pkg[field] ?? {}) as Record<string, string>;
    for (const [name, value] of Object.entries(deps)) {
      // 名字与值都要看：别名写法 `"x": "npm:@capybara-hq/kernel@*"` 名字里没有作用域。
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

/** 解析源码里的 `#xxx` 子路径：经 package.json imports 映射展开成目标字符串（找不到映射返回空）。 */
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
  // 依赖别名：名字里没有作用域、值指向 @capybara-hq/* 的依赖，源码里 import 别名等于 import 内核。
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
 * 依赖边界检查。
 * - pluginDirs：每个插件目录（扫描源码 import 与 package.json），违规 rule 为 plugin-imports-kernel
 *   （路径逃出插件目录为 plugin-imports-outside）；
 * - sdkDirs：packages/plugin-sdk 包目录，出现任何 @capybara-hq/* 或逃出包目录的路径为 sdk-imports-internal。
 *
 * 覆盖：import / export from / export * / import type / 动态 import("字面量或字面量拼接") / require("…") /
 * import x = require() / import("x") 类型；package.json 的 dependencies / peerDependencies /
 * devDependencies / optionalDependencies（名字与值都看，覆盖 npm: / workspace: 别名）/ bundleDependencies /
 * link:|file:|portal: 出目录 / imports 与 exports 映射值；源码里的 `#xxx` 经 imports 映射展开后再判，
 * 依赖别名同样判；file: URL 与绝对路径按逃出目录处理。
 * devDependencies 与 test 文件里的 @capybara-hq/testing 放行。
 * Also allowed there: `@capybara-hq/plugin-model-fake` (plugin tests drive agent runs with it).
 *
 * 已知缺口（M0 不做）：非字面量的动态 specifier（`import(x)`）；经变量别名、`module.require`、
 * `createRequire(...)` 的间接 require；`import.meta.resolve`；运行时拼路径读文件；
 * 嵌套 package.json 与 TS `paths` 映射。
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
