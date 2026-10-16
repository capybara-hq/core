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

export type { Finding };

const TIMERS = new Set(["setTimeout", "setInterval", "setImmediate"]);
const TIMER_MODULES = new Set(["timers", "node:timers", "timers/promises", "node:timers/promises"]);
const STATE_CTORS = new Set(["Map", "Set", "WeakMap", "WeakSet"]);
const MARKER = "capybara:allow-module-state";

const FIX = "改用 ctx.kv（带 TTL 的共享状态）/ ctx.queue（延迟任务）/ ctx.bus（跨副本通知）";
const MSG_TIMER = `插件不得使用定时器：定时器只存在于创建它的那个进程，多副本下别的实例停不掉也看不到它。${FIX}`;
const MSG_STATE = `模块顶层的可变状态只存在于当前进程，多副本下各实例各存一份。${FIX}；确属只读常量请加 // ${MARKER} <原因>`;
const MSG_REASON = `// ${MARKER} 后必须写明原因（不能为空）`;

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

/** 初始化表达式是否是 new Map/Set/WeakMap/WeakSet(...)（含 new globalThis.Map）或数组字面量。 */
function isStateInit(init: Node | null): boolean {
  if (!init) return false;
  const e = unwrap(init);
  if (e.type === "ArrayExpression") return true;
  if (e.type !== "NewExpression") return false;
  const callee = unwrap(e.callee as Node);
  if (callee.type === "Identifier") return STATE_CTORS.has(callee.name as string);
  if (callee.type === "MemberExpression" && !callee.computed) {
    return STATE_CTORS.has((callee.property as Node).name as string);
  }
  return false;
}

/** 找声明上的豁免标记：声明首行/末行的行尾注释，或独占一行、紧邻声明上方的注释。 */
function findMarker(f: ParsedFile, decl: Node): { reason: string } | undefined {
  const first = f.lineOf(decl.start);
  const last = f.lineOf(decl.end);
  for (const c of f.comments) {
    if (c.type !== "Line") continue;
    const m = new RegExp(`^\\s*${MARKER}(?:\\s+(.*\\S))?\\s*$`).exec(c.value);
    if (!m) continue;
    const line = f.lineOf(c.start);
    const ownLine = f.lineText(line).trimStart().startsWith("//");
    if (line === first || line === last || (line === first - 1 && ownLine)) {
      return { reason: m[1] ?? "" };
    }
  }
  return undefined;
}

function moduleStateFindings(f: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const body = (f.program.body as Node[]) ?? [];
  for (const stmt of body) {
    const decl =
      stmt.type === "ExportNamedDeclaration" && stmt.declaration
        ? (stmt.declaration as Node)
        : stmt;
    if (decl.type !== "VariableDeclaration") continue;
    const kind = decl.kind as string;
    for (const d of decl.declarations as Node[]) {
      const flagged =
        kind === "let" ||
        kind === "var" ||
        (kind === "const" && isStateInit(d.init as Node | null));
      if (!flagged) continue;
      const marker = findMarker(f, stmt);
      const line = f.lineOf(d.start);
      if (marker?.reason) continue;
      out.push({
        file: f.file,
        line,
        rule: "plugin-module-state",
        message: marker ? MSG_REASON : MSG_STATE,
      });
    }
  }
  return out;
}

function timerFindings(f: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const add = (n: Node) =>
    out.push({ file: f.file, line: f.lineOf(n.start), rule: "plugin-timer", message: MSG_TIMER });

  for (const { spec, start } of collectImports(f.program)) {
    if (TIMER_MODULES.has(spec)) {
      out.push({ file: f.file, line: f.lineOf(start), rule: "plugin-timer", message: MSG_TIMER });
    }
  }
  walk(f.program, (n, parent, key) => {
    if (n.type === "Identifier" && TIMERS.has(n.name as string)) {
      if (!parent) return;
      const p = parent;
      if (p.type === "MemberExpression" && key === "property" && !p.computed) return;
      if (
        (p.type === "Property" ||
          p.type === "PropertyDefinition" ||
          p.type === "MethodDefinition") &&
        key === "key" &&
        !p.computed
      ) {
        return;
      }
      if (p.type.startsWith("TS")) return;
      if (/^(Import|Export)/.test(p.type)) return; // 从 timers 导入的写法由上面的 import 检查报
      add(n);
    } else if (n.type === "ObjectPattern") {
      // const { setTimeout: st } = globalThis：键名指向定时器，改名后就认不出了。
      for (const prop of n.properties as Node[]) {
        const k = prop.type === "Property" ? (prop.key as Node) : undefined;
        if (k && !prop.computed && k.type === "Identifier" && TIMERS.has(k.name as string)) add(k);
      }
    } else if (
      n.type === "Literal" ||
      n.type === "TemplateLiteral" ||
      (n.type === "BinaryExpression" && n.operator === "+")
    ) {
      // 任何恰好等于定时器名的字符串（Reflect.get(globalThis, "setInterval")、globalThis["setTimeout"]），
      // 含字符串字面量 / 无插值模板的 `+` 拼接（globalThis["set" + "Immediate"]），由 stringValue 求值。
      // 刻意保守：误报用豁免之外的办法解决——换个写法。
      const v = stringValue(n);
      if (v !== undefined && TIMERS.has(v)) add(n);
    } else if (n.type === "MemberExpression" && !n.computed) {
      const prop = n.property as Node;
      if (prop.type === "Identifier" && TIMERS.has(prop.name as string)) add(n);
    }
  });
  return out;
}

/**
 * 插件状态检查（AST）。规则：
 * - plugin-timer：setTimeout / setInterval / setImmediate（含 globalThis.x、别名、timers 模块导入）；
 * - plugin-module-state：模块顶层 let / var，或 const 初始化为 new Map/Set/WeakMap/WeakSet 或数组字面量。
 * 豁免：`// capybara:allow-module-state <原因>`（行尾或紧邻上一行，原因必填）。
 * 定时器识别：标识符引用（含别名赋值）、`x.setTimeout` / `x["setTimeout"]`、解构键
 * `{ setTimeout: st }`、任何恰好等于定时器名的字符串字面量（含字面量之间的 `+` 拼接，如
 * `g["set" + "Timeout"]`）、timers 模块导入（import/require/动态 import）。
 * 扫描范围：插件目录下所有源码，node_modules 任何深度都跳过；dist 与 test/tests/__tests__ 只在插件根跳过
 * （更深处同名目录照常扫描，否则 `src/test/impl.ts` 就能绕过）；*.test.* / *.spec.* 不扫。
 *
 * 已知缺口（M0 不做，靠评审与双副本测试兜底）：顶层对象字面量（`const x = {}`）、`Array.from(...)` /
 * `Object.create(...)` 等工厂调用、`export default new Map()`、IIFE 闭包里的状态、namespace 内的 let、
 * 类静态可变字段、块内 `var` 提升、`queueMicrotask` / `process.nextTick` 递归循环、
 * 含非字面量成分的运行时拼接（变量、函数调用、带插值的模板）与非字面量动态 import。
 */
export function checkPluginState(pluginDirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
    for (const { file, isTest } of listSourceFiles(dir)) {
      if (isTest) continue;
      const parsed = parseFile(file);
      if (isParseError(parsed)) {
        findings.push(parsed);
        continue;
      }
      const all = [...moduleStateFindings(parsed), ...timerFindings(parsed)];
      all.sort((a, b) => a.line - b.line);
      const seen = new Set<string>();
      for (const x of all) {
        const k = `${x.line}|${x.rule}`;
        if (!seen.has(k)) findings.push(x);
        seen.add(k);
      }
    }
  }
  return findings;
}
