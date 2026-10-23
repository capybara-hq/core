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

const MARKER = "capybara:allow-dynamic-permission";

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

/** `x.name` / `x["name"]` 的属性名；动态属性返回 undefined。 */
function memberName(m: Node): string | undefined {
  const p = m.property as Node;
  if (!m.computed) return p.type === "Identifier" ? (p.name as string) : undefined;
  return stringValue(p);
}

const isFn = (n: Node): boolean =>
  n.type === "ArrowFunctionExpression" ||
  n.type === "FunctionExpression" ||
  n.type === "FunctionDeclaration";

/** 文件级环境：同文件的 const 与函数，用于把标识符追到定义处。 */
function buildDecls(f: ParsedFile): Map<string, Node> {
  const decls = new Map<string, Node>();
  walk(f.program, (n) => {
    if (n.type === "VariableDeclarator") {
      const id = n.id as Node;
      if (id.type === "Identifier" && n.init) decls.set(id.name as string, n.init as Node);
    } else if (n.type === "FunctionDeclaration") {
      const id = n.id as Node | null;
      if (id) decls.set(id.name as string, n);
    }
  });
  return decls;
}

/** 追到字面量节点：直接写，或经本文件的 const 引用。 */
function resolve(n: Node, decls: Map<string, Node>): Node {
  let e = unwrap(n);
  for (let i = 0; i < 5 && e.type === "Identifier"; i++) {
    const init = decls.get(e.name as string);
    if (!init) break;
    e = unwrap(init);
  }
  return e;
}

/** 找行尾或紧邻上一行（独占一行）的豁免注释。 */
function findMarker(f: ParsedFile, at: Node): { reason: string } | undefined {
  const first = f.lineOf(at.start);
  const last = f.lineOf(at.end);
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

interface Manifest {
  secrets: boolean;
  http: Set<string>;
  tools: Set<string>;
  /** permissions.ui.views：ctx.ui.view / action 只能用这些 id。 */
  uiViews: Set<string>;
  /** permissions.hooks: ctx.hooks.on may only use these mount points. */
  hooks: Set<string>;
  /** permissions.policyHooks: `mode: "policy"` only on these mount points (M-1). */
  policyHooks: Set<string>;
  caps: Set<string>;
  storage: boolean;
  models: boolean;
  setup: Node | undefined;
}

const strings = (n: Node | undefined, decls: Map<string, Node>): string[] => {
  if (!n) return [];
  const e = resolve(n, decls);
  if (e.type !== "ArrayExpression") return [];
  return (e.elements as (Node | null)[]).flatMap((x) => {
    const v = x ? stringValue(resolve(x, decls)) : undefined;
    return v === undefined ? [] : [v];
  });
};

/** Whether hook options are statically `{ mode: "policy" }` (object literal or same-file const). */
function policyMode(opts: Node | undefined, decls: Map<string, Node>): boolean {
  const o = opts ? resolve(opts, decls) : undefined;
  if (o?.type !== "ObjectExpression") return false;
  const mode = prop(o, "mode")?.value as Node | undefined;
  return mode !== undefined && stringValue(resolve(mode, decls)) === "policy";
}

function readManifest(obj: Node, decls: Map<string, Node>): Manifest {
  const m: Manifest = {
    secrets: false,
    http: new Set(),
    tools: new Set(),
    uiViews: new Set(),
    hooks: new Set(),
    policyHooks: new Set(),
    caps: new Set(),
    storage: false,
    models: false,
    setup: undefined,
  };
  for (const key of ["requires", "optional", "provides"]) {
    for (const s of strings(prop(obj, key)?.value as Node | undefined, decls)) m.caps.add(s);
  }
  const perm = prop(obj, "permissions");
  const pe = perm ? resolve(perm.value as Node, decls) : undefined;
  if (pe?.type === "ObjectExpression") {
    const secrets = prop(pe, "secrets");
    m.secrets = !!secrets && (resolve(secrets.value as Node, decls) as Node).value === true;
    const storage = prop(pe, "storage");
    m.storage = !!storage && (resolve(storage.value as Node, decls) as Node).value === true;
    m.models = !!prop(pe, "models");
    for (const t of strings(prop(pe, "tools")?.value as Node | undefined, decls)) m.tools.add(t);
    for (const h of strings(prop(pe, "hooks")?.value as Node | undefined, decls)) m.hooks.add(h);
    for (const h of strings(prop(pe, "policyHooks")?.value as Node | undefined, decls)) {
      m.policyHooks.add(h);
    }
    const ui = prop(pe, "ui");
    const ue = ui ? resolve(ui.value as Node, decls) : undefined;
    if (ue?.type === "ObjectExpression") {
      for (const v of strings(prop(ue, "views")?.value as Node | undefined, decls)) {
        m.uiViews.add(v);
      }
    }
    const http = prop(pe, "http");
    const arr = http ? resolve(http.value as Node, decls) : undefined;
    if (arr?.type === "ArrayExpression") {
      for (const el of arr.elements as (Node | null)[]) {
        const o = el ? resolve(el, decls) : undefined;
        if (o?.type !== "ObjectExpression") continue;
        const method = stringValue(prop(o, "method")?.value);
        const path = stringValue(prop(o, "path")?.value);
        if (method !== undefined && path !== undefined) m.http.add(`${method} ${path}`);
      }
    }
  }
  const setup = prop(obj, "setup");
  if (setup) {
    const v = resolve(setup.value as Node, decls);
    if (isFn(v)) m.setup = v;
  }
  return m;
}

interface Scope {
  fn: Node;
  /** 持有 ctx 的标识符名（参数名及其本地别名）。 */
  names: Set<string>;
}

function scanSetup(f: ParsedFile, m: Manifest, decls: Map<string, Node>): Finding[] {
  const out: Finding[] = [];
  /** 明确的违规：豁免注释不起作用。 */
  const add = (at: Node, rule: string, message: string): void => {
    out.push({ file: f.file, line: f.lineOf(at.start), rule, message });
  };
  /** 「无法静态确认」：只有这类可以用豁免注释放行（原因必填）。 */
  const dynamic = (at: Node, rule: string, what: string): void => {
    const marker = findMarker(f, at);
    if (marker?.reason) return;
    add(
      at,
      rule,
      marker
        ? `// ${MARKER} must be followed by a reason (not empty)`
        : `Cannot statically confirm ${what}. Use a string literal (or a same-file const), or add // ${MARKER} <reason>`,
    );
  };

  let first = (m.setup?.params as Node[] | undefined)?.[0];
  if (first?.type === "AssignmentPattern") first = first.left as Node;
  if (!m.setup || !first) return out;
  const queue: Scope[] = [];
  const seen = new Set<string>();
  const enqueue = (fn: Node, param: Node | undefined): void => {
    if (param?.type !== "Identifier") return;
    const key = `${fn.start}|${param.name as string}`;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ fn, names: new Set([param.name as string]) });
  };
  enqueue(m.setup, first);
  if (first.type === "ObjectPattern") {
    dynamic(first, "perm-reserved", "platform access through a destructured setup parameter");
  }

  while (queue.length > 0) {
    const { fn, names } = queue.shift() as Scope;
    const isCtx = (n: unknown): boolean => {
      const e = n ? unwrap(n as Node) : undefined;
      return e?.type === "Identifier" && names.has(e.name as string);
    };
    // 先收集本地别名：const c = ctx
    walk(fn.body, (n) => {
      if (n.type === "VariableDeclarator" && n.init && isCtx(n.init)) {
        const id = n.id as Node;
        if (id.type === "Identifier") names.add(id.name as string);
        else {
          dynamic(n, "perm-reserved", "platform access through a destructured ctx");
        }
      }
    });
    walk(fn.body, (n, parent) => {
      if (n.type === "CallExpression") {
        const callee = unwrap(n.callee as Node);
        const args = n.arguments as Node[];
        // 把 ctx 传给同文件函数：继续跟踪
        if (callee.type === "Identifier") {
          const target = decls.get(callee.name as string);
          const t = target ? unwrap(target) : undefined;
          if (t && isFn(t)) {
            args.forEach((a, i) => {
              if (isCtx(a)) enqueue(t, (t.params as Node[])[i]);
            });
          }
        }
        if (callee.type !== "MemberExpression") return;
        const method = memberName(callee);
        const obj = unwrap(callee.object as Node);
        if (obj.type !== "MemberExpression" || !isCtx(obj.object)) return;
        const area = memberName(obj);
        if (area === "http" && method === "route") {
          const verb = args[0] ? stringValue(resolve(args[0], decls)) : undefined;
          const path = args[1] ? stringValue(resolve(args[1], decls)) : undefined;
          if (verb === undefined || path === undefined) {
            return dynamic(n, "perm-http", "the route method and path");
          }
          if (!m.http.has(`${verb} ${path}`)) {
            add(
              n,
              "perm-http",
              `Route "${verb} ${path}" is not declared; add it to permissions.http in the plugin manifest`,
            );
          }
        } else if (area === "tools" && method === "register") {
          const spec = args[0] ? resolve(args[0], decls) : undefined;
          const nameProp = spec?.type === "ObjectExpression" ? prop(spec, "name") : undefined;
          const name = nameProp ? stringValue(resolve(nameProp.value as Node, decls)) : undefined;
          if (name === undefined) return dynamic(n, "perm-tools", "the tool name");
          if (!m.tools.has(name)) {
            add(
              n,
              "perm-tools",
              `Tool "${name}" is not declared; add it to permissions.tools in the plugin manifest`,
            );
          }
        } else if (area === "ui" && (method === "view" || method === "action")) {
          const id = args[0] ? stringValue(resolve(args[0], decls)) : undefined;
          if (id === undefined) return dynamic(n, "perm-ui", `the ctx.ui.${method} id`);
          if (!m.uiViews.has(id)) {
            add(
              n,
              "perm-ui",
              `UI view "${id}" is not declared; add it to permissions.ui.views (and ui) in the plugin manifest`,
            );
          }
        } else if (area === "hooks" && method === "on") {
          const mount = args[0] ? stringValue(resolve(args[0], decls)) : undefined;
          if (mount === undefined) return dynamic(n, "perm-hooks", "the hook mount point");
          if (!m.hooks.has(mount)) {
            add(
              n,
              "perm-hooks",
              `Hook "${mount}" is not declared; add it to permissions.hooks in the plugin manifest`,
            );
          } else if (policyMode(args[2], decls) && !m.policyHooks.has(mount)) {
            // a non-literal mode is left to the runtime check (PluginPermissionError)
            add(
              n,
              "perm-hooks",
              `Policy hook "${mount}" is not declared; add it to permissions.policyHooks in the plugin manifest`,
            );
          }
        } else if (area === "capabilities" && (method === "get" || method === "list")) {
          const ref = args[0] ? stringValue(resolve(args[0], decls)) : undefined;
          if (ref === undefined) return dynamic(n, "perm-capability", "the capability ref");
          if (!m.caps.has(ref)) {
            add(
              n,
              "perm-capability",
              `Capability "${ref}" is not declared; add it to requires or optional in the plugin manifest`,
            );
          }
        }
      } else if (n.type === "MemberExpression" && isCtx(n.object)) {
        const name = memberName(n);
        const unconfirmed = (rule: string, what: string) => dynamic(n, rule, what);
        if (name === undefined) return unconfirmed("perm-reserved", "a computed ctx member");
        if (name === "secrets" && !m.secrets) {
          add(
            n,
            "perm-secrets",
            "ctx.secrets is used but not declared; set permissions.secrets to true in the plugin manifest",
          );
        } else if (name === "storage") {
          if (!m.storage) {
            add(
              n,
              "perm-storage",
              "ctx.storage is used but not declared; set permissions.storage to true in the plugin manifest",
            );
          }
        } else if (name === "models") {
          add(
            n,
            "perm-reserved",
            "ctx.models is reserved and not provided in this release; remove the access",
          );
        } else if (
          name === "http" ||
          name === "tools" ||
          name === "capabilities" ||
          name === "ui" ||
          name === "hooks"
        ) {
          // 只有 ctx.http.route / ctx.tools.register / ctx.capabilities.get|list /
          // ctx.ui.view|action|invalidate|verifyEmbedToken 能被确认，其余写法无法确认
          // (likewise only ctx.hooks.on is confirmable)
          const rule =
            name === "http"
              ? "perm-http"
              : name === "tools"
                ? "perm-tools"
                : name === "ui"
                  ? "perm-ui"
                  : name === "hooks"
                    ? "perm-hooks"
                    : "perm-capability";
          const outer = parent;
          const ok =
            outer?.type === "MemberExpression" &&
            outer.object === n &&
            ((name === "http" && memberName(outer) === "route") ||
              (name === "tools" && memberName(outer) === "register") ||
              (name === "hooks" && memberName(outer) === "on") ||
              (name === "capabilities" && ["get", "list"].includes(memberName(outer) ?? "")) ||
              (name === "ui" &&
                ["view", "action", "invalidate", "verifyEmbedToken"].includes(
                  memberName(outer) ?? "",
                )));
          if (!ok) unconfirmed(rule, `how ctx.${name} is used`);
        }
      }
    });
  }
  return out;
}

function scanFile(f: ParsedFile): Finding[] {
  const decls = buildDecls(f);
  const out: Finding[] = [];
  walk(f.program, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = unwrap(n.callee as Node);
    if (callee.type !== "Identifier" || callee.name !== "definePlugin") return;
    const arg = (n.arguments as Node[])[0];
    const obj = arg ? resolve(arg, decls) : undefined;
    if (obj?.type !== "ObjectExpression") return;
    out.push(...scanSetup(f, readManifest(obj, decls), decls));
  });
  return out;
}

/**
 * 插件权限静态检查（AST）：把 setup(ctx) 里对平台能力的访问与 definePlugin 清单比对。规则：
 * - perm-secrets：用了 ctx.secrets 而 permissions.secrets 不是 true；
 * - perm-http：ctx.http.route(method, path) 不在 permissions.http 里；
 * - perm-tools：ctx.tools.register({ name }) 的名字不在 permissions.tools 里；
 * - perm-capability：ctx.capabilities.get|list(ref) 的 ref 不在 requires / optional / provides 里；
 * - perm-ui：ctx.ui.view|action(id) 的 id 不在 permissions.ui.views 里；
 * - perm-storage：用了 ctx.storage 而 permissions.storage 不是 true；
 * - perm-hooks: the mount point of ctx.hooks.on(mount, …) is not in permissions.hooks (the mount
 *   point must be a string literal or a same-file const, like the names below), or the options are
 *   `{ mode: "policy" }` and the mount point is not in permissions.policyHooks;
 * - perm-reserved：用了尚未提供的 ctx.models。
 * 路由路径、工具名、能力 ref、界面 id 须是字符串字面量或本文件的 const；动态的写法报「无法静态确认」，
 * 豁免：`// capybara:allow-dynamic-permission <原因>`（行尾或紧邻上一行，原因必填）。
 * ctx 会跟踪本地别名，以及按位置传给同文件函数的参数。
 * 已知缺口（靠评审与运行时 PluginPermissionError 兜底）：传给其他文件 / 方法的 ctx、闭包外的重新赋值、
 * 没有 definePlugin 的辅助文件、permissions 本身是运行时拼出的。
 * 扫描范围：传入目录下的非测试源码。
 */
export function checkPluginPermissions(pluginDirs: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const dir of pluginDirs) {
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
