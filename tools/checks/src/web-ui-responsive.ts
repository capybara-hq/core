import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
  walk,
} from "./source.js";

/**
 * The responsive rules of `check:web-ui` (responsive system spec §5.3, §7): apps/web draws no
 * size-class logic (`web-ui-size-branch`), keeps view choices out of `ListPage.filters`
 * (`web-ui-filters-scope`) and passes no template-only prop (`web-ui-template-only-props`).
 */
export const SIZE_BRANCH_RULE = "web-ui-size-branch";
export const SIZE_BRANCH_STALE_RULE = "web-ui-size-branch-stale";
export const FILTERS_SCOPE_RULE = "web-ui-filters-scope";
export const FILTERS_SCOPE_STALE_RULE = "web-ui-filters-scope-stale";
export const TEMPLATE_ONLY_RULE = "web-ui-template-only-props";

// --- shared helpers --------------------------------------------------------------------------

const SOURCE_EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];

function resolveModule(spec: string, fromFile: string, webSrcDir: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = join(webSrcDir, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return undefined;
  if (/\.[jt]sx?$/.test(base) && existsSync(base)) return base;
  for (const ext of SOURCE_EXTS) if (existsSync(base + ext)) return base + ext;
  return undefined;
}

function propKey(prop: Node): string | undefined {
  if (prop.type !== "Property") return undefined;
  const k = prop.key as Node;
  if (prop.computed) return undefined;
  return (k.name ?? k.value) as string | undefined;
}

function jsxName(opening: Node): string | undefined {
  const name = opening.name as Node;
  return name.type === "JSXIdentifier" ? (name.name as string) : undefined;
}

function attrNamed(opening: Node, name: string): Node | undefined {
  return (opening.attributes as Node[]).find(
    (a) => a.type === "JSXAttribute" && (a.name as Node).name === name,
  );
}

/** A file's tree rule: per-file findings, then the allowlist / ratchet by path. */
interface PathEntry {
  path: string;
}

function applyPathRatchet(
  raw: Finding[],
  entries: readonly PathEntry[],
  srcDir: string,
  staleRule: string,
  what: string,
  where: string,
): Finding[] {
  const rel = (f: string) => relative(srcDir, f).split(sep).join("/");
  const covered = new Set(entries.map((e) => e.path));
  const hit = new Set<string>();
  const out: Finding[] = [];
  for (const f of raw) {
    if (covered.has(rel(f.file))) hit.add(rel(f.file));
    else out.push(f);
  }
  for (const e of entries) {
    if (hit.has(e.path)) continue;
    const file = join(srcDir, ...e.path.split("/"));
    out.push({
      file,
      line: 1,
      rule: staleRule,
      message: !existsSync(file)
        ? `"${e.path}": the file does not exist; remove the entry from ${where}`
        : `no ${what} left in "${e.path}": remove the entry from ${where} (the list only shrinks)`,
    });
  }
  return out;
}

// --- web-ui-size-branch ----------------------------------------------------------------------

const SIZE_NAMES = new Set([
  "useSizeClass",
  "useMediaQuery",
  "useTouch",
  "SIZE_CLASS_QUERIES",
  "TOUCH_QUERY",
]);
const WINDOW_GLOBALS = new Set(["window", "globalThis", "self"]);
/** Nodes whose `key` is a name, not a reference. */
const KEY_PARENTS = new Set([
  "Property",
  "MethodDefinition",
  "PropertyDefinition",
  "TSPropertySignature",
  "TSMethodSignature",
]);
const WINDOW_READS = new Set(["matchMedia", "innerWidth"]);

/**
 * `web-ui-size-branch`: a page branching on the size class draws structure the design package
 * owns. A file under `apps/web/src` (tests and `dev/` apart) fails unless it is in
 * `SIZE_BRANCH_ALLOWED` when it
 * - imports `useSizeClass`, `useMediaQuery`, `useTouch`, `SIZE_CLASS_QUERIES` or `TOUCH_QUERY`, or
 *   reads one as a member of a namespace import (`design.useSizeClass`) or destructures it from
 *   one;
 * - reads `window.matchMedia` / `window.innerWidth` (also on `globalThis` / `self`), destructures
 *   them from the window, or reads a bare global `matchMedia` / `innerWidth` no enclosing scope
 *   binds (object keys, class members and type positions are not reads).
 */
export function sizeBranchFindings(p: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const flag = (n: Node, what: string) =>
    out.push({
      file: p.file,
      line: p.lineOf(n.start),
      rule: SIZE_BRANCH_RULE,
      message: `${what}: size-class logic belongs to the design package (templates, ClassForms); a page does not branch on the window; if a structure must differ per class, ask the template for it`,
    });
  const namespaces = new Set<string>();
  const isFn = (n: Node) =>
    n.type === "FunctionDeclaration" ||
    n.type === "FunctionExpression" ||
    n.type === "ArrowFunctionExpression";
  const bindInto = (into: Set<string>, id: unknown) => {
    const n = id as Node | null | undefined;
    if (!n) return;
    if (n.type === "Identifier") into.add(n.name as string);
    else if (n.type === "ObjectPattern")
      for (const prop of n.properties as Node[])
        bindInto(into, prop.type === "Property" ? prop.value : prop.argument);
    else if (n.type === "ArrayPattern") for (const el of n.elements as Node[]) bindInto(into, el);
    else if (n.type === "AssignmentPattern") bindInto(into, n.left);
    else if (n.type === "RestElement") bindInto(into, n.argument);
  };
  /** The names a scope binds: a function's params and the declarations in it, nested functions apart. */
  const scopeOf = (root: Node): Set<string> => {
    const names = new Set<string>();
    if (isFn(root)) for (const param of root.params as Node[]) bindInto(names, param);
    const go = (n: unknown, top: boolean): void => {
      if (typeof n !== "object" || n === null) return;
      if (Array.isArray(n)) {
        for (const x of n) go(x, false);
        return;
      }
      const node = n as Node;
      if (node.type === "VariableDeclarator") bindInto(names, node.id);
      else if (node.type === "ImportSpecifier" || node.type === "ImportDefaultSpecifier")
        bindInto(names, node.local);
      else if (node.type === "ImportNamespaceSpecifier") {
        bindInto(names, node.local);
        namespaces.add((node.local as Node).name as string);
      }
      if (!top && isFn(node)) {
        if (node.type === "FunctionDeclaration") bindInto(names, node.id);
        return;
      }
      for (const [k, v] of Object.entries(node))
        if (k !== "type" && k !== "start" && k !== "end") go(v, false);
    };
    go(root, true);
    return names;
  };
  const visit = (n: Node, parent: Node | null, key: string, scopes: Set<string>[]): void => {
    if (n.type === "ImportSpecifier" || n.type === "ExportSpecifier") {
      const imported = (n.type === "ImportSpecifier" ? n.imported : n.local) as Node;
      const name = (imported.name ?? imported.value) as string;
      if (SIZE_NAMES.has(name)) flag(n, `\`${name}\``);
      return;
    }
    if (n.type === "Identifier") {
      const name = n.name as string;
      if (!WINDOW_READS.has(name) || scopes.some((s) => s.has(name))) return;
      // a property name or an object key is not a read of the global
      if (parent?.type === "MemberExpression" && key === "property" && !parent.computed) return;
      if (key === "key" && !parent?.computed && KEY_PARENTS.has(parent?.type ?? "")) return;
      // a type position (`typeof innerWidth`, an interface member) reads nothing at runtime
      if (parent?.type === "TSTypeQuery") return;
      flag(n, `\`${name}\``);
      return;
    }
    if (n.type === "VariableDeclarator" && (n.id as Node).type === "ObjectPattern") {
      const init = n.init as Node | null;
      if (init?.type === "Identifier") {
        const from = init.name as string;
        const names = WINDOW_GLOBALS.has(from)
          ? WINDOW_READS
          : namespaces.has(from)
            ? SIZE_NAMES
            : undefined;
        for (const prop of (n.id as Node).properties as Node[]) {
          const k = propKey(prop);
          if (names && k && names.has(k)) flag(prop, `\`${from}.${k}\``);
        }
      }
    }
    if (n.type === "MemberExpression") {
      const obj = n.object as Node;
      const prop = n.property as Node;
      const name = n.computed
        ? prop.type === "Literal"
          ? (prop.value as string)
          : undefined
        : (prop.name as string | undefined);
      if (name && obj.type === "Identifier") {
        if (WINDOW_READS.has(name) && WINDOW_GLOBALS.has(obj.name as string))
          flag(n, `\`${obj.name as string}.${name}\``);
        else if (SIZE_NAMES.has(name) && namespaces.has(obj.name as string))
          flag(n, `\`${obj.name as string}.${name}\``);
      }
    }
    const inner = isFn(n) ? [...scopes, scopeOf(n)] : scopes;
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end" || typeof v !== "object" || v === null)
        continue;
      for (const c of Array.isArray(v) ? v : [v])
        if (c && typeof c === "object" && typeof (c as Node).type === "string")
          visit(c as Node, n, k, inner);
    }
  };
  visit(p.program, null, "", [scopeOf(p.program)]);
  return out;
}

export interface SizeBranchAllowed {
  /** Under apps/web/src, `/`-separated. */
  path: string;
  reason: string;
}

/** Files that read the window on purpose: the shell frame, the host API and the extension slot. */
export const SIZE_BRANCH_ALLOWED: readonly SizeBranchAllowed[] = [
  {
    path: "components/shell/AppFrame.tsx",
    reason:
      "the shell frame: useTouch for the install / push prompts and matchMedia for reduced motion",
  },
  {
    path: "components/shell/conversations.tsx",
    reason:
      "the conversation list: prewarms a route on hover for a fine pointer (matchMedia coarse) and reads compact for its row form",
  },
  {
    path: "components/client-ext/host-api.ts",
    reason: "the client host API hands useSizeClass and reduced motion to client extensions",
  },
  {
    path: "components/extension-ui/ExtensionSlot.tsx",
    reason: "an extension slot gates a contribution by the current size class",
  },
  {
    path: "components/ScheduleCalendarView.tsx",
    reason:
      "reads the compact class at click time to pick the phone gesture of the calendar (pending: a template-owned form)",
  },
];

export function sizeBranchTreeFindings(
  webSrcDir: string,
  allowed: readonly SizeBranchAllowed[] = SIZE_BRANCH_ALLOWED,
): Finding[] {
  const raw: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    if (isTest || relative(webSrcDir, file).split(sep)[0] === "dev") continue;
    const p = parseFile(file);
    if (isParseError(p)) continue; // reported by the other rules
    raw.push(...sizeBranchFindings(p));
  }
  return applyPathRatchet(
    raw,
    allowed,
    webSrcDir,
    SIZE_BRANCH_STALE_RULE,
    "size-class read",
    "SIZE_BRANCH_ALLOWED in tools/checks/src/web-ui-responsive.ts",
  );
}

// --- web-ui-template-only-props --------------------------------------------------------------

const HEADERISH = /^(?:header|head)$|Header$/;

/**
 * `web-ui-template-only-props`: `primaryForm` (on `PageHeader`, or inside the `header` object a
 * template takes) and `look` on `Tabs` are set by the design templates only; a page that passes
 * them chooses a form the template owns.
 */
export function templateOnlyPropsFindings(p: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const flag = (n: Node, what: string) =>
    out.push({
      file: p.file,
      line: p.lineOf(n.start),
      rule: TEMPLATE_ONLY_RULE,
      message: `${what} is set by the design templates only; a page leaves the form to the template`,
    });
  const headerObject = (o: unknown) => {
    const obj = o as Node | undefined;
    if (obj?.type !== "ObjectExpression") return;
    for (const prop of obj.properties as Node[])
      if (propKey(prop) === "primaryForm") flag(prop, "`primaryForm` in a page header");
  };
  const decls = new Map<string, Node>();
  walk(p.program, (n) => {
    if (n.type === "VariableDeclarator" && (n.id as Node).type === "Identifier" && n.init)
      decls.set((n.id as Node).name as string, n.init as Node);
  });
  const viaDecl = (v: Node | undefined) => {
    if (v?.type === "Identifier") headerObject(decls.get(v.name as string));
    else headerObject(v);
  };
  walk(p.program, (n) => {
    if (n.type === "JSXOpeningElement") {
      const name = jsxName(n);
      if (name === "PageHeader") {
        const a = attrNamed(n, "primaryForm");
        if (a) flag(a, "`primaryForm` on PageHeader");
      } else if (name === "Tabs") {
        const a = attrNamed(n, "look");
        if (a) flag(a, "`look` on Tabs");
      }
    } else if (n.type === "JSXAttribute" && (n.name as Node).name === "header") {
      const v = n.value as Node | null;
      if (v?.type === "JSXExpressionContainer") viaDecl(v.expression as Node);
    } else if (n.type === "Property" && propKey(n) === "header") {
      viaDecl(n.value as Node);
    } else if (
      n.type === "VariableDeclarator" &&
      (n.id as Node).type === "Identifier" &&
      HEADERISH.test((n.id as Node).name as string)
    ) {
      headerObject(n.init);
    }
  });
  // the same object can be reached twice (a const used as `header=`)
  return out.filter(
    (f, i) => out.findIndex((g) => g.line === f.line && g.message === f.message) === i,
  );
}

// --- web-ui-filters-scope --------------------------------------------------------------------

const SCOPE_CONTROLS = new Set(["Segmented", "Tabs"]);

export const FILTERS_SCOPE_MESSAGE =
  "ListPage `filters` holds a view choice (<Segmented> / <Tabs>): a scope such as all / mine / shared is a ScopeChips row, a view switch is the header's tabs; `filters` is for narrowing controls (Select, search fields) only";

export interface ScopePending {
  /** Under apps/web/src, `/`-separated. */
  path: string;
  /** The task that moves the page onto ScopeChips. */
  fix: string;
}

/** Pages that still hand a Segmented / Tabs to `filters`; a ratchet like `BOX_PENDING`. */
export const SCOPE_PENDING: readonly ScopePending[] = [
  { path: "app/(app)/agents/view.tsx", fix: "the scope Segmented becomes ScopeChips" },
  {
    path: "app/(app)/admin/agents/templates/view.tsx",
    fix: "useOwnerFilter's owner Tabs become ScopeChips",
  },
  {
    path: "app/(app)/admin/connectors/templates/view.tsx",
    fix: "useOwnerFilter's owner Tabs become ScopeChips",
  },
  { path: "app/(app)/admin/plugins/market/view.tsx", fix: "the source Tabs become ScopeChips" },
];

interface Binding {
  init: Node;
  /** `const { key } = init`: the destructured key, else undefined. */
  pick?: string;
}

interface FileInfo {
  p: ParsedFile;
  bindings: Map<string, Binding>;
  functions: Map<string, Node>;
  imports: Map<string, string>;
}

class FilterScan {
  private cache = new Map<string, FileInfo | null>();
  constructor(private webSrcDir: string) {}

  info(file: string): FileInfo | null {
    const hit = this.cache.get(file);
    if (hit !== undefined) return hit;
    const p = parseFile(file);
    if (isParseError(p)) {
      this.cache.set(file, null);
      return null;
    }
    const bindings = new Map<string, Binding>();
    const functions = new Map<string, Node>();
    const imports = new Map<string, string>();
    walk(p.program, (n) => {
      if (n.type === "FunctionDeclaration" && (n.id as Node | null)?.type === "Identifier") {
        functions.set((n.id as Node).name as string, n);
      } else if (n.type === "VariableDeclarator" && n.init) {
        const id = n.id as Node;
        const init = n.init as Node;
        if (id.type === "Identifier") {
          bindings.set(id.name as string, { init });
          if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression")
            functions.set(id.name as string, init);
        } else if (id.type === "ObjectPattern") {
          for (const prop of id.properties as Node[]) {
            const key = propKey(prop);
            const v = prop.value as Node | undefined;
            if (key && v?.type === "Identifier")
              bindings.set(v.name as string, { init, pick: key });
          }
        }
      } else if (n.type === "ImportDeclaration") {
        const spec = (n.source as Node).value as string;
        for (const s of n.specifiers as Node[])
          if (s.type === "ImportSpecifier") imports.set((s.local as Node).name as string, spec);
      }
    });
    const info = { p, bindings, functions, imports };
    this.cache.set(file, info);
    return info;
  }

  /** The `filters` values of a hook (a function in this file or an imported one). */
  private hookFilters(call: Node, fi: FileInfo, seen: Set<string>): boolean {
    const callee = call.callee as Node;
    if (callee.type !== "Identifier") return false;
    const name = callee.name as string;
    let target: { info: FileInfo; fn: Node } | undefined;
    const local = fi.functions.get(name);
    if (local) target = { info: fi, fn: local };
    else {
      const spec = fi.imports.get(name);
      const file = spec ? resolveModule(spec, fi.p.file, this.webSrcDir) : undefined;
      const info = file ? this.info(file) : null;
      const fn = info?.functions.get(name);
      if (info && fn) target = { info, fn };
    }
    if (!target) return false;
    const key = `${target.info.p.file}:${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    let found = false;
    walk(target.fn, (n) => {
      if (!found && propKey(n) === "filters" && this.holds(n.value as Node, target.info, seen))
        found = true;
    });
    return found;
  }

  /** Does the value hold a Segmented / Tabs, directly or through a const, a hook or JSX? */
  holds(node: unknown, fi: FileInfo, seen: Set<string> = new Set()): boolean {
    if (typeof node !== "object" || node === null) return false;
    if (Array.isArray(node)) return node.some((x) => this.holds(x, fi, seen));
    const n = node as Node;
    if (n.type === "JSXElement") {
      const name = jsxName((n as Node).openingElement as Node);
      if (name && SCOPE_CONTROLS.has(name)) return true;
    } else if (n.type === "Identifier") {
      const b = fi.bindings.get(n.name as string);
      const key = `${fi.p.file}#${n.name as string}`;
      if (!b || seen.has(key)) return false;
      seen.add(key);
      if (b.pick === "filters" && b.init.type === "CallExpression")
        return this.hookFilters(b.init, fi, seen);
      return b.pick ? false : this.holds(b.init, fi, seen);
    } else if (n.type === "MemberExpression") {
      const obj = n.object as Node;
      const prop = n.property as Node;
      if (obj.type === "Identifier" && !n.computed && prop.name === "filters") {
        const b = fi.bindings.get(obj.name as string);
        if (b?.init.type === "CallExpression" && !b.pick) return this.hookFilters(b.init, fi, seen);
      }
      return this.holds(obj, fi, seen);
    }
    for (const [k, v] of Object.entries(n)) {
      if (k === "type" || k === "start" || k === "end") continue;
      if (typeof v === "object" && v !== null && this.holds(v, fi, seen)) return true;
    }
    return false;
  }

  findings(file: string): Finding[] {
    const fi = this.info(file);
    if (!fi) return [];
    let hasListPage = false;
    walk(fi.p.program, (n) => {
      if (n.type === "JSXOpeningElement" && jsxName(n) === "ListPage") hasListPage = true;
    });
    if (!hasListPage) return [];
    const out: Finding[] = [];
    const flag = (n: Node) =>
      out.push({
        file,
        line: fi.p.lineOf(n.start),
        rule: FILTERS_SCOPE_RULE,
        message: FILTERS_SCOPE_MESSAGE,
      });
    walk(fi.p.program, (n) => {
      if (n.type === "JSXAttribute" && (n.name as Node).name === "filters") {
        const v = n.value as Node | null;
        if (v?.type === "JSXExpressionContainer" && this.holds(v.expression, fi)) flag(n);
      } else if (propKey(n) === "filters" && this.holds(n.value, fi)) {
        flag(n);
      }
    });
    return out;
  }
}

/** `web-ui-filters-scope` over one file (a fixture, or a page of the tree). */
export function filtersScopeFindings(file: string, webSrcDir: string): Finding[] {
  return new FilterScan(webSrcDir).findings(file);
}

export function filtersScopeTreeFindings(
  webSrcDir: string,
  pending: readonly ScopePending[] = SCOPE_PENDING,
): Finding[] {
  const scan = new FilterScan(webSrcDir);
  const raw: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    if (!isTest) raw.push(...scan.findings(file));
  }
  return applyPathRatchet(
    raw,
    pending,
    webSrcDir,
    FILTERS_SCOPE_STALE_RULE,
    "Segmented / Tabs in ListPage filters",
    "SCOPE_PENDING in tools/checks/src/web-ui-responsive.ts",
  );
}

/** The template-only rule over the tree. */
export function templateOnlyPropsTreeFindings(webSrcDir: string): Finding[] {
  const out: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    if (isTest) continue;
    const p = parseFile(file);
    if (!isParseError(p)) out.push(...templateOnlyPropsFindings(p));
  }
  return out;
}
