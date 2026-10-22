import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Comment, parseSync } from "oxc-parser";

export type Finding = { file: string; line: number; rule: string; message: string };

/** ESTree 节点（oxc-parser 的输出）。只声明本检查用到的公共字段。 */
export interface Node {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** 只在插件根目录下才有特殊含义的目录名（更深处同名目录是普通源码目录，必须扫描）。 */
const ROOT_TEST_DIRS = new Set(["test", "tests", "__tests__"]);

export interface SourceFile {
  file: string;
  /** 测试文件：插件根的 test/ 目录下的文件，或 *.test.* / *.spec.* 文件。 */
  isTest: boolean;
}

/**
 * 递归列出目录下的源码文件。node_modules 与 pack-plugin 的临时目录 `.capybara-pack-*` 在任何深度都跳过；
 * dist 只在根目录跳过（构建产物），
 * test / tests / __tests__ 目录只在根目录算测试（标 isTest），更深处同名目录照常当源码扫描，
 * 否则 `src/test/impl.ts` 再 re-export 就能绕过全部检查。结果有序。
 */
export function listSourceFiles(dir: string): SourceFile[] {
  if (!existsSync(dir)) return [];
  const out: SourceFile[] = [];
  const visit = (d: string, depth: number, inTestRoot: boolean) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === "node_modules") continue;
        // pack-plugin 的临时目录（旧版本建在插件目录里，崩溃后可能残留）：里面是打包产物，不是插件源码
        if (e.name.startsWith(".capybara-pack-")) continue;
        if (depth === 0 && e.name === "dist") continue;
        visit(p, depth + 1, inTestRoot || (depth === 0 && ROOT_TEST_DIRS.has(e.name)));
      } else if (e.isFile() && SOURCE_EXT.test(e.name)) {
        out.push({ file: p, isTest: inTestRoot || TEST_FILE.test(e.name) });
      }
    }
  };
  visit(dir, 0, false);
  return out;
}

export interface ParsedFile {
  file: string;
  source: string;
  program: Node;
  comments: Comment[];
  /** 偏移量 -> 1 基行号。 */
  lineOf(offset: number): number;
  /** 取 1 基行号的原文。 */
  lineText(line: number): string;
}

/** 解析一个文件；语法错误时返回 Finding（rule: parse-error），检查不能因解析失败而静默放过。 */
export function parseFile(file: string): ParsedFile | Finding {
  const source = readFileSync(file, "utf8");
  const result = parseSync(file, source);
  const first = result.errors[0];
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  const lineOf = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const lines = source.split("\n");
  if (first) {
    const label = first.labels?.[0];
    return {
      file,
      line: label ? lineOf(label.start) : 1,
      rule: "parse-error",
      message: `无法解析，检查无法进行：${first.message}`,
    };
  }
  return {
    file,
    source,
    program: result.program as unknown as Node,
    comments: result.comments,
    lineOf,
    lineText: (n) => lines[n - 1] ?? "",
  };
}

/** 判断 parseFile 的结果是不是解析失败。 */
export function isParseError(x: ParsedFile | Finding): x is Finding {
  return "rule" in x;
}

const isNode = (v: unknown): v is Node =>
  typeof v === "object" && v !== null && typeof (v as Node).type === "string";

/** 深度优先遍历 AST；visit 收到节点、父节点与它在父节点上的属性名。 */
export function walk(
  node: unknown,
  visit: (n: Node, parent: Node | null, key: string) => void,
  parent: Node | null = null,
  key = "",
): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit, parent, key);
    return;
  }
  if (!isNode(node)) return;
  visit(node, parent, key);
  for (const [k, v] of Object.entries(node)) {
    if (k === "type" || k === "start" || k === "end") continue;
    if (typeof v === "object" && v !== null) walk(v, visit, node, k);
  }
}

/** 取字符串字面量、无插值模板字符串、或它们的 `+` 拼接的值；其他表达式返回 undefined。 */
export function stringValue(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
  if (n.type === "BinaryExpression" && n.operator === "+") {
    const l = stringValue(n.left);
    const r = stringValue(n.right);
    return l !== undefined && r !== undefined ? l + r : undefined;
  }
  if (n.type === "Literal" && typeof n.value === "string") return n.value;
  if (n.type === "TemplateLiteral") {
    const quasis = n.quasis as { value: { cooked: string | null } }[];
    const exprs = n.expressions as unknown[];
    if (exprs.length === 0 && quasis.length === 1) return quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

export interface ImportRef {
  spec: string;
  start: number;
}

/**
 * 收集文件里所有模块引用：import / export … from / export * / import type / 动态 import() /
 * require() / import x = require() / import("x") 类型。非字面量的动态 import 无法静态判定，被忽略。
 */
export function collectImports(program: Node): ImportRef[] {
  const out: ImportRef[] = [];
  const add = (n: unknown, at: Node) => {
    const spec = stringValue(n);
    if (spec !== undefined) out.push({ spec, start: at.start });
  };
  walk(program, (n) => {
    switch (n.type) {
      case "ImportDeclaration":
      case "ExportNamedDeclaration":
      case "ExportAllDeclaration":
      case "ImportExpression":
      case "TSImportType":
        add(n.source, n);
        break;
      case "TSExternalModuleReference":
        add(n.expression, n);
        break;
      case "CallExpression": {
        const callee = n.callee as Node;
        const args = n.arguments as unknown[];
        if (callee.type === "Identifier" && callee.name === "require") add(args[0], n);
        break;
      }
    }
  });
  return out;
}
