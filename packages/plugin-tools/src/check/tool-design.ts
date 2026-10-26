import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
  stringValue,
  walk,
} from "./source.js";

export type { Finding };

const MIN_DESCRIPTION = 20;
const CJK = /[㐀-鿿豈-﫿　-〿＀-￯]/;
/** 可执行的建议动词：错误信息里至少出现其一（整词、不分大小写）。 */
const ACTION_VERB = /\b(?:use|call|retry|check|ask|pass|provide)\b/i;

const WRAPPERS = new Set([
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSNonNullExpression",
  "TSTypeAssertion",
]);

function unwrap(n: Node): Node {
  let cur = n;
  while (WRAPPERS.has(cur.type)) cur = cur.expression as Node;
  return cur;
}

const propName = (p: Node): string | undefined => {
  if (p.type !== "Property" || p.computed) return undefined;
  const k = p.key as Node;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return undefined;
};

function prop(obj: Node, name: string): Node | undefined {
  for (const p of obj.properties as Node[]) if (propName(p) === name) return p;
  return undefined;
}

/** 文件级环境：本地声明（const / function）与导入绑定，用于把标识符追到定义处。 */
interface Env {
  decls: Map<string, Node>;
  imported: Set<string>;
}

function buildEnv(f: ParsedFile): Env {
  const decls = new Map<string, Node>();
  const imported = new Set<string>();
  walk(f.program, (n) => {
    if (n.type === "VariableDeclarator") {
      const id = n.id as Node;
      if (id.type === "Identifier" && n.init) decls.set(id.name as string, n.init as Node);
    } else if (n.type === "FunctionDeclaration") {
      const id = n.id as Node | null;
      if (id) decls.set(id.name as string, n);
    } else if (n.type === "ImportDeclaration") {
      for (const s of n.specifiers as Node[])
        imported.add(((s.local as Node).name as string) ?? "");
    }
  });
  return { decls, imported };
}

type Resolved =
  /** 能静态得到的文本（动态插值部分略去）。 */
  | { kind: "text"; text: string }
  /** 引用了别处导入的定义，本检查不跨文件追踪。 */
  | { kind: "imported" }
  | { kind: "dynamic" };

/** 把消息表达式尽量还原成静态文本：字面量、模板、`+` 拼接、本地常量、本地函数的返回值。 */
function resolveText(n: Node, env: Env, depth = 0): Resolved {
  if (depth > 5) return { kind: "dynamic" };
  const e = unwrap(n);
  const lit = stringValue(e);
  if (lit !== undefined) return { kind: "text", text: lit };
  if (e.type === "TemplateLiteral") {
    const quasis = e.quasis as { value: { cooked: string | null } }[];
    return { kind: "text", text: quasis.map((q) => q.value.cooked ?? "").join(" ") };
  }
  if (e.type === "BinaryExpression" && e.operator === "+") {
    const parts = [
      resolveText(e.left as Node, env, depth + 1),
      resolveText(e.right as Node, env, depth + 1),
    ];
    if (parts.some((p) => p.kind === "dynamic")) {
      // 拼接里夹着动态片段：静态部分仍可检查，片段本身不算
      return {
        kind: "text",
        text: parts.map((p) => (p.kind === "text" ? p.text : "")).join(" "),
      };
    }
    if (parts.some((p) => p.kind === "imported")) return { kind: "imported" };
    return { kind: "text", text: parts.map((p) => (p.kind === "text" ? p.text : "")).join(" ") };
  }
  if (e.type === "Identifier") {
    const name = e.name as string;
    if (env.imported.has(name)) return { kind: "imported" };
    const init = env.decls.get(name);
    return init ? resolveText(init, env, depth + 1) : { kind: "dynamic" };
  }
  if (e.type === "CallExpression") {
    const callee = unwrap(e.callee as Node);
    if (callee.type !== "Identifier") return { kind: "dynamic" };
    const name = callee.name as string;
    if (env.imported.has(name)) return { kind: "imported" };
    const fn = env.decls.get(name);
    if (!fn) return { kind: "dynamic" };
    return resolveFnReturn(fn, env, depth + 1);
  }
  return { kind: "dynamic" };
}

function resolveFnReturn(fn: Node, env: Env, depth: number): Resolved {
  const f = unwrap(fn);
  if (
    f.type !== "ArrowFunctionExpression" &&
    f.type !== "FunctionExpression" &&
    f.type !== "FunctionDeclaration"
  ) {
    return { kind: "dynamic" };
  }
  const body = f.body as Node;
  if (body.type !== "BlockStatement") return resolveText(body, env, depth);
  const texts: string[] = [];
  let bad = false;
  walk(body, (n) => {
    if (n.type !== "ReturnStatement" || !n.argument) return;
    const r = resolveText(n.argument as Node, env, depth + 1);
    if (r.kind === "text") texts.push(r.text);
    else bad = true;
  });
  return bad || texts.length === 0 ? { kind: "dynamic" } : { kind: "text", text: texts.join(" ") };
}

const MSG_DESC_MISSING =
  "工具缺少 description，或它不是字符串字面量。给模型的描述必须写成可静态检查的英文字符串字面量（可用 + 拼接）";
const MSG_DESC_SHORT = `工具 description 至少 ${MIN_DESCRIPTION} 个字符：说清工具做什么、何时该用、何时不该用`;
const MSG_DESC_CJK = "工具 description 是模型可见文案，必须是英文，不得含中文字符";
const MSG_ERR_DYNAMIC =
  "ToolError 的消息必须是字符串字面量或模板（或指向本文件内的此类常量 / 函数），否则无法检查是否可执行";
const MSG_ERR_ACTION =
  "ToolError 的消息要让模型知道下一步怎么做：必须含建议动词之一（use / call / retry / check / ask / pass / provide）";

/** 取一个 spec 表达式对应的对象字面量（直接写，或经本文件内的常量引用）。 */
function specObject(n: Node, env: Env): Node | undefined {
  let e = unwrap(n);
  for (let i = 0; i < 5 && e.type === "Identifier"; i++) {
    const init = env.decls.get(e.name as string);
    if (!init) return undefined;
    e = unwrap(init);
  }
  return e.type === "ObjectExpression" ? e : undefined;
}

function checkSpec(f: ParsedFile, at: Node, spec: Node | undefined, out: Finding[]): void {
  const add = (node: Node, message: string): void => {
    out.push({ file: f.file, line: f.lineOf(node.start), rule: "tool-description", message });
  };
  const p = spec ? prop(spec, "description") : undefined;
  const value = p ? stringValue(unwrap(p.value as Node)) : undefined;
  if (value === undefined) add(at, MSG_DESC_MISSING);
  else if (value.trim().length < MIN_DESCRIPTION) add(at, MSG_DESC_SHORT);
  else if (CJK.test(value)) add(at, MSG_DESC_CJK);
}

function scanFile(f: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const env = buildEnv(f);
  walk(f.program, (n) => {
    // ctx.tools.register(spec, handler)
    if (n.type === "CallExpression") {
      const c = unwrap(n.callee as Node);
      if (
        c.type === "MemberExpression" &&
        !c.computed &&
        (c.property as Node).name === "register"
      ) {
        const o = unwrap(c.object as Node);
        const isTools =
          (o.type === "MemberExpression" && !o.computed && (o.property as Node).name === "tools") ||
          (o.type === "Identifier" && o.name === "tools");
        if (isTools) {
          const first = (n.arguments as Node[])[0];
          checkSpec(f, n, first ? specObject(first, env) : undefined, out);
        }
      }
    }
    // BuiltinTool 对象字面量：同时有 spec 与 run
    if (n.type === "ObjectExpression" && prop(n, "spec") && prop(n, "run")) {
      const sp = prop(n, "spec") as Node;
      checkSpec(f, sp, specObject(sp.value as Node, env), out);
    }
    // throw new ToolError(...)，也包括 return new ToolError(...)
    if (n.type === "NewExpression") {
      const callee = unwrap(n.callee as Node);
      if (callee.type !== "Identifier" || callee.name !== "ToolError") return;
      const arg = (n.arguments as Node[])[0];
      const line = f.lineOf(n.start);
      const add = (message: string) =>
        out.push({ file: f.file, line, rule: "tool-error-actionable", message });
      if (!arg) return add(MSG_ERR_ACTION);
      const r = resolveText(arg, env);
      if (r.kind === "imported") return; // 定义在别处，不跨文件追踪（已知缺口）
      if (r.kind === "dynamic") return add(MSG_ERR_DYNAMIC);
      if (!ACTION_VERB.test(r.text)) add(MSG_ERR_ACTION);
    }
  });
  return out;
}

/**
 * 工具设计检查（AST）。规则：
 * - tool-description：`ctx.tools.register(spec, …)` 与 `BuiltinTool` 字面量（有 spec 与 run）里的 spec
 *   必须有字符串字面量 description（可 `+` 拼接）、不少于 20 字符、不含中文（模型可见文案一律英文）；
 * - tool-error-actionable：`new ToolError(msg)` 的 msg 是字符串字面量 / 模板（或本文件内的常量、函数返回值），
 *   且含建议动词 use / call / retry / check / ask / pass / provide 之一，让模型知道下一步做什么。
 * spec 可以直接写对象字面量，也可以引用本文件内的 const；其他写法（跨文件、动态构造）报 tool-description。
 * 已知缺口：从别的文件导入的消息常量 / 函数不追踪；非 ToolError 类的错误不查；运行时拼出的 spec 不查。
 * 扫描：传入目录下的非测试源码。
 */
export function checkToolDesign(dirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of dirs) {
    for (const { file, isTest } of listSourceFiles(dir)) {
      if (isTest) continue;
      const parsed = parseFile(file);
      if (isParseError(parsed)) {
        findings.push(parsed);
        continue;
      }
      findings.push(...scanFile(parsed).sort((a, b) => a.line - b.line));
    }
  }
  return findings;
}
