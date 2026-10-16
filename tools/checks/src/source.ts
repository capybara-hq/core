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
const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__"]);

/** 递归列出目录下的源码文件，跳过 node_modules / dist / test 目录与 *.test.* 文件。结果有序。 */
export function listSourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(p);
      } else if (e.isFile() && SOURCE_EXT.test(e.name) && !TEST_FILE.test(e.name)) {
        out.push(p);
      }
    }
  };
  visit(dir);
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

/** 取字符串字面量（或无插值模板字符串）的值；其他表达式返回 undefined。 */
export function stringValue(n: unknown): string | undefined {
  if (!isNode(n)) return undefined;
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
