import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import {
  collectImports,
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
  walk,
} from "./source.js";

export type { Finding };

/** The page templates of spec §5; must equal @capybara-hq/design PAGE_TEMPLATES (a test checks). */
export const WEB_UI_TEMPLATES = [
  "OverviewPage",
  "ListPage",
  "DetailPage",
  "FormPage",
  "SettingsPage",
  "InboxPage",
  "ConversationPage",
  "TracePage",
  "WizardPage",
  "AuthPage",
  "StatusPage",
  "OnboardingPage",
  "SetupPage",
] as const;

/** design 包内用：color-mix( 等在 CSS 里合法地引用 token，所以这里只认字面量写法。 */
const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
/** apps/web 内用：页面里不该有任何颜色函数（color-mix 也不行，颜色只来自 design）。 */
const WEB_COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
const ALLOWED_CSS = "@capybara-hq/design/styles.css";
const FORBIDDEN_PKG = new RegExp(
  `^(?:@radix-ui/|@emotion/|@stitches/|@vanilla-extract/|@mui/|@chakra-ui/|@mantine/|@headlessui/|(?:${[
    "cmdk",
    "styled-components",
    "antd",
    "tailwindcss",
    "tailwind-merge",
    "clsx",
    "classnames",
    "class-variance-authority",
    "styled-jsx",
    "lucide-react",
    "react-icons",
  ].join("|")})(?:/|$))`,
);
const CREATE_ELEMENT = new Set(["createElement", "jsx", "jsxs", "jsxDEV"]);
const DESIGN_PKG = "@capybara-hq/design";
/** 目录式 catalog 页，不要求使用页面模板。 */
const TEMPLATE_EXEMPT_PREFIX = ["app", "dev"];

function listCssFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const visit = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== "node_modules") visit(p);
      } else if (e.isFile() && e.name.endsWith(".css")) out.push(p);
    }
  };
  visit(dir);
  return out;
}

/** 把 CSS 注释替换为等量空白（保留换行），行号不变。 */
function stripCssComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
}

function colorFindings(
  p: ParsedFile,
  rule: string,
  message: (snippet: string) => string,
  re: RegExp = COLOR,
): Finding[] {
  const out: Finding[] = [];
  const hit = (text: string | null | undefined, at: Node) => {
    if (typeof text !== "string") return;
    const m = re.exec(text);
    if (m) out.push({ file: p.file, line: p.lineOf(at.start), rule, message: message(m[0]) });
  };
  walk(p.program, (n) => {
    if (n.type === "Literal" && typeof n.value === "string") hit(n.value, n);
    else if (n.type === "TemplateElement") {
      hit((n.value as { cooked: string | null; raw: string }).cooked, n);
    }
  });
  return out;
}

/** 页面是否用了「从 @capybara-hq/design 导入」的页面模板（解析别名与命名空间导入）。 */
function usesDesignTemplate(p: ParsedFile): boolean {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  walk(p.program, (n) => {
    if (n.type !== "ImportDeclaration") return;
    if ((n.source as Node).value !== DESIGN_PKG) return;
    for (const sp of n.specifiers as Node[]) {
      const local = (sp.local as Node).name as string;
      if (sp.type === "ImportSpecifier") {
        const im = sp.imported as Node;
        named.set(local, (im.name ?? im.value) as string);
      } else if (sp.type === "ImportNamespaceSpecifier") namespaces.add(local);
    }
  });
  const templates: readonly string[] = WEB_UI_TEMPLATES;
  let found = false;
  walk(p.program, (n) => {
    if (n.type !== "JSXOpeningElement") return;
    const name = n.name as Node;
    if (name.type === "JSXIdentifier") {
      const imported = named.get(name.name as string);
      if (imported !== undefined && templates.includes(imported)) found = true;
    } else if (name.type === "JSXMemberExpression") {
      const obj = name.object as Node;
      const prop = (name.property as Node).name as string;
      if (
        obj.type === "JSXIdentifier" &&
        namespaces.has(obj.name as string) &&
        templates.includes(prop)
      )
        found = true;
    }
  });
  return found;
}

/**
 * 只负责 404 的 page（如 `[...rest]/page.tsx`）：不含任何 JSX，且调用了从 `next/navigation`
 * 导入的 `notFound()`。这类页面不渲染骨架（由同段的 not-found.tsx 渲染模板），豁免模板规则。
 */
function isNotFoundOnlyPage(p: ParsedFile): boolean {
  const locals = new Set<string>();
  let hasJsx = false;
  walk(p.program, (n) => {
    if (n.type === "JSXElement" || n.type === "JSXFragment") hasJsx = true;
    if (n.type !== "ImportDeclaration" || (n.source as Node).value !== "next/navigation") return;
    for (const sp of n.specifiers as Node[]) {
      if (sp.type !== "ImportSpecifier") continue;
      const im = sp.imported as Node;
      if ((im.name ?? im.value) === "notFound") locals.add((sp.local as Node).name as string);
    }
  });
  if (hasJsx || locals.size === 0) return false;
  let calls = false;
  walk(p.program, (n) => {
    if (n.type !== "CallExpression") return;
    const callee = n.callee as Node;
    if (callee.type === "Identifier" && locals.has(callee.name as string)) calls = true;
  });
  return calls;
}

function propKey(prop: Node): string | undefined {
  if (prop.type !== "Property") return undefined;
  const k = prop.key as Node;
  if (k.type === "Identifier" && !prop.computed) return k.name as string;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return undefined;
}

/** Templates whose head is not the shared page head with a breadcrumb path. */
const PATH_EXEMPT_TEMPLATES = new Set([
  "ConversationPage",
  "AuthPage",
  "OnboardingPage",
  "StatusPage",
  "TracePage",
  "InboxPage",
]);
const PAGE_PATH_RULE = "web-ui-page-path";

/**
 * In an app page, the object passed as `header` to a design page template must have a `path`
 * property (the breadcrumb of the shared page head). Follows a same-file const bound to an object
 * literal; a top-level spread, a call result, an import or anything else is reported as
 * "cannot be confirmed statically".
 */
function pagePathFindings(file: string, p: ParsedFile): Finding[] {
  const named = new Map<string, string>();
  const namespaces = new Set<string>();
  const consts = new Map<string, Node>();
  walk(p.program, (n) => {
    if (n.type === "ImportDeclaration" && (n.source as Node).value === DESIGN_PKG) {
      for (const sp of n.specifiers as Node[]) {
        const local = (sp.local as Node).name as string;
        if (sp.type === "ImportSpecifier") {
          const im = sp.imported as Node;
          named.set(local, (im.name ?? im.value) as string);
        } else if (sp.type === "ImportNamespaceSpecifier") namespaces.add(local);
      }
    } else if (n.type === "VariableDeclarator") {
      const id = n.id as Node;
      if (id.type === "Identifier" && n.init) consts.set(id.name as string, n.init as Node);
    }
  });
  const templates: readonly string[] = WEB_UI_TEMPLATES;
  const out: Finding[] = [];
  const add = (at: Node, message: string) =>
    out.push({ file, line: p.lineOf(at.start), rule: PAGE_PATH_RULE, message });
  const unconfirmed = (at: Node, why: string) =>
    add(
      at,
      `the header of this page template cannot be confirmed statically (${why}); write an object literal with a \`path\` (inline or a same-file const)`,
    );
  walk(p.program, (n) => {
    if (n.type !== "JSXOpeningElement") return;
    const name = n.name as Node;
    let template: string | undefined;
    if (name.type === "JSXIdentifier") template = named.get(name.name as string);
    else if (
      name.type === "JSXMemberExpression" &&
      (name.object as Node).type === "JSXIdentifier" &&
      namespaces.has((name.object as Node).name as string)
    )
      template = (name.property as Node).name as string;
    if (template === undefined || !templates.includes(template)) return;
    if (PATH_EXEMPT_TEMPLATES.has(template)) return;
    const attrs = n.attributes as Node[];
    const attr = attrs.find((a) => a.type === "JSXAttribute" && (a.name as Node).name === "header");
    if (!attr && attrs.some((a) => a.type === "JSXSpreadAttribute")) {
      unconfirmed(n, "no explicit header attribute and a spread attribute");
      return;
    }
    if (!attr) {
      add(n, `${template} has no \`header\`; pass header={{ path: [...], title }}`);
      return;
    }
    const value = attr.value as Node | null;
    let expr: Node | undefined =
      value?.type === "JSXExpressionContainer" ? (value.expression as Node) : undefined;
    if (expr?.type === "Identifier") {
      const bound = consts.get(expr.name as string);
      if (bound === undefined)
        return unconfirmed(attr, `\`${expr.name}\` is not a same-file const`);
      expr = bound;
    }
    if (expr?.type !== "ObjectExpression") return unconfirmed(attr, "not an object literal");
    const props = expr.properties as Node[];
    if (props.some((q) => propKey(q) === "path")) return;
    if (props.some((q) => q.type !== "Property"))
      return unconfirmed(attr, "a spread at the top level of the header and no literal path");
    add(attr, `the header of ${template} has no \`path\`; every app page sets the breadcrumb path`);
  });
  return out;
}

function checkWebFile(file: string, isTest: boolean, webSrcDir: string): Finding[] {
  if (isTest) return [];
  const p = parseFile(file);
  if (isParseError(p)) return [p];
  const out: Finding[] = [];

  for (const imp of collectImports(p.program)) {
    const line = p.lineOf(imp.start);
    if (FORBIDDEN_PKG.test(imp.spec)) {
      out.push({
        file,
        line,
        rule: "web-ui-import",
        message: `不得直接导入 ${imp.spec}；改用 @capybara-hq/design 导出的组件，缺组件时先在 design 包里补`,
      });
    } else if (/\.css(?:[?#].*)?$/.test(imp.spec) && imp.spec !== ALLOWED_CSS) {
      out.push({
        file,
        line,
        rule: "web-ui-import",
        message: `不得导入样式文件 ${imp.spec}；apps/web 只允许导入 ${ALLOWED_CSS}，样式写进 design 包`,
      });
    }
  }

  const CLASS_MSG =
    "页面内不得写 className / class；改用 @capybara-hq/design 的组件或布局原语，页面内不写样式";
  const STYLE_MSG =
    "页面内不得写 style / <style> / dangerouslySetInnerHTML；改用 @capybara-hq/design 的组件或布局原语，页面内不写样式";
  const IFRAME_MSG =
    "页面内不得直接渲染 iframe；用 @capybara-hq/design 的 EmbedFrame（固定 sandbox、只转发本 iframe 的消息）";
  const flag = (rule: string, message: string, at: Node) =>
    out.push({ file, line: p.lineOf(at.start), rule, message });
  const checkObject = (obj: unknown) => {
    const o = obj as Node | undefined;
    if (o?.type !== "ObjectExpression") return;
    for (const prop of o.properties as Node[]) {
      const key = propKey(prop);
      if (key === "className" || key === "class") flag("web-ui-class-name", CLASS_MSG, prop);
      else if (key === "style" || key === "dangerouslySetInnerHTML")
        flag("web-ui-style", STYLE_MSG, prop);
    }
  };

  walk(p.program, (n) => {
    if (n.type === "JSXAttribute") {
      const name = n.name as Node;
      if (name.type !== "JSXIdentifier") return;
      if (name.name === "className" || name.name === "class")
        flag("web-ui-class-name", CLASS_MSG, n);
      else if (name.name === "style" || name.name === "dangerouslySetInnerHTML")
        flag("web-ui-style", STYLE_MSG, n);
    } else if (n.type === "JSXSpreadAttribute") {
      checkObject(n.argument);
    } else if (n.type === "JSXOpeningElement") {
      const name = n.name as Node;
      if (name.type === "JSXIdentifier" && name.name === "style")
        flag("web-ui-style", STYLE_MSG, n);
      else if (name.type === "JSXIdentifier" && name.name === "iframe")
        flag("web-ui-iframe", IFRAME_MSG, n);
    } else if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      const fn =
        callee.type === "Identifier"
          ? (callee.name as string)
          : callee.type === "MemberExpression"
            ? ((callee.property as Node).name as string | undefined)
            : undefined;
      if (fn !== undefined && CREATE_ELEMENT.has(fn)) {
        const args = n.arguments as Node[];
        if (args[0]?.type === "Literal" && args[0].value === "iframe")
          flag("web-ui-iframe", IFRAME_MSG, n);
        checkObject(args[1]);
      }
    }
  });

  out.push(
    ...colorFindings(
      p,
      "web-ui-color",
      (s) =>
        `不得出现颜色字面量「${s}」；颜色只能来自 @capybara-hq/design 的 token，页面内不写颜色`,
      WEB_COLOR,
    ),
  );
  out.push(...charIconFindings(p));

  const segs = relative(webSrcDir, file).split(sep);
  const exempt = TEMPLATE_EXEMPT_PREFIX.every((s, i) => segs[i] === s);
  if (segs[0] === "app" && /^page\.[jt]sx?$/.test(segs.at(-1) ?? "") && !exempt) {
    if (!usesDesignTemplate(p) && !isNotFoundOnlyPage(p) && !viewUsesTemplate(file, p)) {
      out.push({
        file,
        line: 1,
        rule: "web-ui-template",
        message: `page 文件必须使用从 @capybara-hq/design 导入的页面模板之一（${WEB_UI_TEMPLATES.join(" / ")}）作为页面骨架`,
      });
    }
  }
  if (
    segs[0] === "app" &&
    segs[1] === "(app)" &&
    /^(?:page|view)\.[jt]sx?$/.test(segs.at(-1) ?? "")
  )
    out.push(...pagePathFindings(file, p));
  out.push(...ssrFindings(file, p, segs));
  return out;
}

/**
 * A server page that renders its client view: `import X from "./view"` whose sibling `view.tsx`
 * (or .jsx/.ts/.js) uses a design page template. The page itself then needs no template.
 */
function viewUsesTemplate(file: string, p: ParsedFile): boolean {
  let imported = false;
  walk(p.program, (n) => {
    if (n.type !== "ImportDeclaration") return;
    const spec = (n.source as Node).value;
    if (spec === "./view" || /^\.\/view\.[jt]sx?$/.test(String(spec))) imported = true;
  });
  if (!imported) return false;
  for (const ext of ["tsx", "jsx", "ts", "js"]) {
    const view = join(dirname(file), `view.${ext}`);
    if (!existsSync(view)) continue;
    const v = parseFile(view);
    return !isParseError(v) && usesDesignTemplate(v);
  }
  return false;
}

/**
 * Server-rendered pages (spec docs/superpowers/specs/2026-11-01-web-ssr-design.md §9).
 * `SSR_PENDING` lists the page files not migrated yet. It is a ratchet: a listed file is exempt from
 * the `web-ssr-*` rules (not from other web-ui rules), an entry whose file no longer violates one
 * (or no longer exists) fails as `web-ssr-stale-pending`, and nothing may be added: a new page
 * is written server-first. Each migration batch removes its entries.
 */
export interface SsrPending {
  /** Relative to apps/web/src, with `/` separators. */
  path: string;
  reason: string;
}
const PENDING_REASON = "not migrated yet (web SSR plan Tasks 7-11)";
export const SSR_PENDING: readonly SsrPending[] = [
  { path: "app/(app)/admin/catalog/[itemId]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/admin/catalog/import/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/admin/catalog/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/admin/catalog/requests/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/admin/marketplaces/entries/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/admin/marketplaces/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/[setId]/cases/[caseId]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/[setId]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/[setId]/run/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/new/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/evals/runs/[runId]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/p/[plugin]/[id]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/trajectories/[conversationId]/page.tsx", reason: PENDING_REASON },
  { path: "app/(app)/trajectories/page.tsx", reason: PENDING_REASON },
  { path: "app/(auth)/bind/[token]/page.tsx", reason: PENDING_REASON },
  { path: "app/(auth)/invite/[token]/page.tsx", reason: PENDING_REASON },
  { path: "app/(auth)/login/page.tsx", reason: PENDING_REASON },
  { path: "app/(auth)/setup/page.tsx", reason: PENDING_REASON },
];

const SSR_RULES = {
  loading: "web-ssr-loading-file",
  client: "web-ssr-client-page",
  firstPaint: "web-ssr-first-paint",
  location: "web-ssr-location",
  stale: "web-ssr-stale-pending",
} as const;
const SSR_EXEMPT = /\/\/\s*ssr-exempt:(.*)$/;
/** Hooks whose function argument runs during render (so a location read there is a render read). */
const RENDER_CALLBACK_HOOKS = new Set(["useState", "useMemo", "useReducer"]);

function isUseClient(p: ParsedFile): boolean {
  const body = p.program.body as Node[] | undefined;
  for (const st of body ?? []) {
    if (st.type !== "ExpressionStatement") return false;
    if (st.directive === "use client") return true;
    const e = st.expression as Node;
    if (e.type === "Literal" && e.value === "use client") return true;
    if (typeof st.directive !== "string" && e.type !== "Literal") return false;
  }
  return false;
}

function calleeName(n: Node): string | undefined {
  const c = n.callee as Node;
  if (c.type === "Identifier") return c.name as string;
  if (c.type === "MemberExpression" && !c.computed) return (c.property as Node).name as string;
  return undefined;
}

function isLocationRead(n: Node): boolean {
  if (n.type !== "MemberExpression" || n.computed) return false;
  const prop = (n.property as Node).name;
  if (prop !== "search" && prop !== "pathname") return false;
  const o = n.object as Node;
  if (o.type === "Identifier") return o.name === "location";
  return (
    o.type === "MemberExpression" &&
    !o.computed &&
    (o.object as Node).type === "Identifier" &&
    ["window", "globalThis", "self"].includes((o.object as Node).name as string) &&
    (o.property as Node).name === "location"
  );
}

/**
 * Location reads during render. A text-free AST pass with a function-nesting heuristic: a read is
 * flagged when it is at module level, directly in a component or hook body (a function that is
 * not nested in another function, named with a capital or `use`, or anonymous), or in a callback
 * handed to `useState` / `useMemo` / `useReducer` (initializers run during render). Reads inside
 * any other nested function (handlers, effects, helpers) are not flagged. Limits: a module-level
 * helper that a component calls during render is not followed, and components wrapped in
 * `memo` / `forwardRef` count as anonymous top-level functions. `// ssr-exempt: <reason>`
 * covers a false positive.
 */
function locationReads(p: ParsedFile): Node[] {
  const hits: Node[] = [];
  const fnNames = new Map<Node, string>();
  type Kind = "component" | "init" | "other";
  const visit = (n: Node, stack: Kind[], init: Set<Node>): void => {
    let next = stack;
    let nextInit = init;
    if (n.type === "VariableDeclarator") {
      const id = n.id as Node;
      const v = n.init as Node | null;
      if (id.type === "Identifier" && v && /Function/.test(v.type)) {
        fnNames.set(v, id.name as string);
      }
    } else if (n.type === "CallExpression") {
      const name = calleeName(n);
      if (name !== undefined && RENDER_CALLBACK_HOOKS.has(name)) {
        nextInit = new Set(init);
        for (const a of n.arguments as Node[]) nextInit.add(a);
      }
    } else if (
      n.type === "FunctionDeclaration" ||
      n.type === "FunctionExpression" ||
      n.type === "ArrowFunctionExpression"
    ) {
      const name =
        n.type === "FunctionDeclaration"
          ? ((n.id as Node | null)?.name as string | undefined)
          : fnNames.get(n);
      let kind: Kind = "other";
      if (init.has(n) && !stack.includes("other")) kind = "init";
      else if (stack.length === 0 && (name === undefined || /^(?:[A-Z]|use[A-Z])/.test(name)))
        kind = "component";
      next = [...stack, kind];
    }
    if (isLocationRead(n) && !next.includes("other")) hits.push(n);
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) {
        for (const c of v)
          if (c && typeof c === "object" && "type" in c) visit(c as Node, next, nextInit);
      } else if (v && typeof v === "object" && "type" in v) visit(v as Node, next, nextInit);
    }
  };
  visit(p.program, [], new Set());
  return hits;
}

/**
 * Names bound by value imports from a `/lib/` module (any name: a loader, a stream, a poller) and
 * every `apiFetch` import. Namespace imports are tracked too.
 */
function libLoaders(p: ParsedFile): { names: Set<string>; namespaces: Set<string> } {
  const names = new Set<string>();
  const namespaces = new Set<string>();
  walk(p.program, (n) => {
    if (n.type !== "ImportDeclaration" || n.importKind === "type") return;
    const lib = String((n.source as Node).value).includes("/lib/");
    for (const sp of n.specifiers as Node[]) {
      if (sp.importKind === "type") continue;
      const local = (sp.local as Node).name as string;
      const im = sp.imported as Node | undefined;
      const imported = im ? String(im.name ?? im.value) : "";
      if (sp.type === "ImportNamespaceSpecifier") {
        if (lib) namespaces.add(local);
      } else if (lib || imported === "apiFetch") names.add(local);
    }
  });
  return { names, namespaces };
}

/** Same-file functions by name: declarations and consts bound to a function or a call wrapping one. */
function localFunctions(p: ParsedFile): Map<string, Node> {
  const fns = new Map<string, Node>();
  walk(p.program, (n) => {
    if (n.type === "FunctionDeclaration" && n.id) fns.set((n.id as Node).name as string, n);
    else if (n.type === "VariableDeclarator" && (n.id as Node).type === "Identifier" && n.init)
      fns.set((n.id as Node).name as string, n.init as Node);
  });
  return fns;
}

function hasInitial(call: Node): boolean {
  return (call.arguments as Node[]).some(
    (a) =>
      a.type === "ObjectExpression" &&
      (a.properties as Node[]).some((q) => propKey(q) === "initial"),
  );
}

function ssrFindings(file: string, p: ParsedFile, segs: string[]): Finding[] {
  if (segs[0] !== "app") return [];
  const out: Finding[] = [];
  const base = segs.at(-1) ?? "";
  const lines = readFileSync(file, "utf8").split("\n");
  /** An exemption comment on the line or the line above: "none" | "ok" | "empty". */
  const exemption = (line: number): "none" | "ok" | "empty" => {
    for (const i of [line - 1, line - 2]) {
      const m = SSR_EXEMPT.exec(lines[i] ?? "");
      if (m) return (m[1] ?? "").trim() === "" ? "empty" : "ok";
    }
    return "none";
  };
  const flag = (rule: string, at: Node, message: string) => {
    const line = p.lineOf(at.start);
    const ex = exemption(line);
    if (ex === "ok") return;
    out.push({
      file,
      line,
      rule,
      message: ex === "empty" ? "`// ssr-exempt:` needs a reason after the colon" : message,
    });
  };

  if (/^loading\.[jt]sx?$/.test(base))
    out.push({
      file,
      line: 1,
      rule: SSR_RULES.loading,
      message:
        "no loading.tsx: it would hide the server-rendered page behind a fallback; the page renders its data on the server (docs/superpowers/specs/2026-11-01-web-ssr-design.md §5)",
    });

  const group = segs[1];
  if (/^page\.[jt]sx?$/.test(base) && (group === "(app)" || group === "(auth)") && isUseClient(p))
    out.push({
      file,
      line: 1,
      rule: SSR_RULES.client,
      message:
        'a page.tsx is a server component (gate and reads); move the template and interaction into view.tsx with "use client" and pass the data as `initial` props',
    });

  if (isUseClient(p)) {
    const loaders = libLoaders(p);
    const fns = localFunctions(p);
    const loaderCall = (root: Node): string | undefined => {
      let found: string | undefined;
      walk(root, (m) => {
        if (m.type !== "CallExpression" || found !== undefined) return;
        const mc = m.callee as Node;
        if (mc.type === "Identifier" && loaders.names.has(mc.name as string))
          found = mc.name as string;
        else if (
          mc.type === "MemberExpression" &&
          (mc.object as Node).type === "Identifier" &&
          loaders.namespaces.has((mc.object as Node).name as string)
        )
          found = String((mc.property as Node).name);
      });
      return found;
    };
    /** A lib call in the callback, or in a same-file function it calls (one level). */
    const effectLoader = (cb: Node): string | undefined => {
      const direct = loaderCall(cb);
      if (direct !== undefined) return direct;
      let via: string | undefined;
      walk(cb, (m) => {
        if (m.type !== "CallExpression" || via !== undefined) return;
        const mc = m.callee as Node;
        const target = mc.type === "Identifier" ? fns.get(mc.name as string) : undefined;
        if (target && target !== cb) {
          const l = loaderCall(target);
          if (l !== undefined) via = `${(mc as Node).name as string} -> ${l}`;
        }
      });
      return via;
    };
    walk(p.program, (n) => {
      if (n.type !== "CallExpression") return;
      const c = n.callee as Node;
      if (c.type !== "Identifier") return;
      if (c.name === "useLoad" && !hasInitial(n)) {
        flag(
          SSR_RULES.firstPaint,
          n,
          "useLoad without `initial` fetches after mount, so the first paint is empty; pass the server read as `{ initial }` (or `// ssr-exempt: <reason>`)",
        );
      } else if (c.name === "useEffect" || c.name === "useLayoutEffect") {
        const cb = (n.arguments as Node[])[0];
        if (!cb) return;
        const loader = effectLoader(cb);
        if (loader !== undefined)
          flag(
            SSR_RULES.firstPaint,
            n,
            `${c.name} calls ${loader}(): a lib call after mount leaves the first paint empty; read it on the server and pass it as \`initial\`, or \`// ssr-exempt: <reason>\` for live updates`,
          );
      }
    });
  }

  for (const hit of locationReads(p))
    flag(
      SSR_RULES.location,
      hit,
      "location.search / location.pathname read during render: it differs on the server; take `searchParams` in page.tsx or use `usePathname()` (or `// ssr-exempt: <reason>`)",
    );
  return out;
}

/** Drops the web-ssr findings of the pending files; reports stale and missing entries. */
function applySsrPending(
  findings: Finding[],
  webSrcDir: string,
  pending: readonly SsrPending[],
): Finding[] {
  const isSsr = (f: Finding) => f.rule.startsWith("web-ssr-");
  const abs = (path: string) => join(webSrcDir, ...path.split("/"));
  const listed = new Set(pending.map((e) => abs(e.path)));
  const out = findings.filter((f) => !(isSsr(f) && listed.has(f.file)));
  for (const e of pending) {
    const file = abs(e.path);
    const hit = findings.some((f) => isSsr(f) && f.file === file);
    if (!existsSync(file))
      out.push({
        file,
        line: 1,
        rule: SSR_RULES.stale,
        message: `SSR_PENDING entry ${e.path} does not exist; remove it from SSR_PENDING in tools/checks/src/web-ui.ts`,
      });
    else if (!hit)
      out.push({
        file,
        line: 1,
        rule: SSR_RULES.stale,
        message: `${e.path} no longer violates a web-ssr rule; remove its SSR_PENDING entry in tools/checks/src/web-ui.ts (the list only shrinks)`,
      });
  }
  return out;
}

/**
 * Characters that were used as icons. They render inconsistently across fonts and carry no
 * accessible name; icons come from `<Icon>` (packages/design/src/icons). Box-drawing, `⌘`, `↵`,
 * `→`, `·` and `…` are text, not icons, and are allowed.
 */
export const ICON_CHARS: Readonly<Record<string, string>> = {
  "▾": "chevron-down",
  "▴": "chevron-up",
  "▸": "chevron-right",
  "◂": "chevron-left",
  "✓": "check",
  "✗": "x",
  "✕": "x",
  "◐": "spinner",
  "›": "chevron-right",
  "‹": "chevron-left",
  "«": "chevrons-left",
  "»": "chevrons-right",
  "●": "circle",
  "○": "circle",
  "⠿": "spinner",
  "▤": "file",
  "⋯": "more-horizontal",
  "↻": "refresh",
  "↗": "external-link",
  "↕": "arrow-up-down",
  "▲": "arrow-up",
  "▼": "arrow-down",
  "‖": "pause",
  "⊘": "ban",
  "◆": "diamond",
  "□": "square",
  "■": "square",
  "▶": "chevron-right",
  "∅": "empty",
  "☰": "menu",
  "⚙": "settings",
  "⌕": "search",
  "▦": "catalog",
};
const ICON_CHAR_RE = new RegExp(`[${Object.keys(ICON_CHARS).join("")}]`, "u");
const CHAR_ICON_RULE = "design-char-icon";

function charIconMessage(ch: string): string {
  return `"${ch}" used as an icon: use <Icon name="${ICON_CHARS[ch]}"> (packages/design/src/icons); characters are not icons`;
}

/** String literals, template chunks and JSX text that contain an icon character. */
function charIconFindings(p: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const hit = (text: unknown, at: Node) => {
    if (typeof text !== "string") return;
    const m = ICON_CHAR_RE.exec(text);
    if (m) {
      out.push({
        file: p.file,
        line: p.lineOf(at.start),
        rule: CHAR_ICON_RULE,
        message: charIconMessage(m[0]),
      });
    }
  };
  walk(p.program, (n) => {
    if (n.type === "Literal" || n.type === "JSXText") hit(n.value, n);
    else if (n.type === "TemplateElement") {
      hit((n.value as { cooked: string | null; raw: string }).cooked, n);
    }
  });
  return out;
}

/** UI messages (`apps/web/messages/*.json`): one finding per line whose text has an icon character. */
function charIconMessageFindings(messagesDir: string): Finding[] {
  if (!existsSync(messagesDir)) return [];
  const out: Finding[] = [];
  for (const name of readdirSync(messagesDir).sort()) {
    if (!name.endsWith(".json")) continue;
    const file = join(messagesDir, name);
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((text, i) => {
        const m = ICON_CHAR_RE.exec(text);
        if (m)
          out.push({ file, line: i + 1, rule: CHAR_ICON_RULE, message: charIconMessage(m[0]) });
      });
  }
  return out;
}

function checkDesign(designSrcDir: string): Finding[] {
  const out: Finding[] = [];
  const tokens = join(designSrcDir, "styles", "tokens.css");
  const rule = "design-color-literal";
  const message = (s: string) =>
    `颜色字面量「${s}」只允许出现在 styles/tokens.css；在 tokens.css 定义 token，这里用 var(--…) 引用`;

  for (const f of listCssFiles(designSrcDir)) {
    if (f === tokens) continue;
    const lines = stripCssComments(readFileSync(f, "utf8")).split("\n");
    lines.forEach((text, i) => {
      const m = COLOR.exec(text);
      if (m) out.push({ file: f, line: i + 1, rule, message: message(m[0]) });
    });
  }
  for (const { file, isTest } of listSourceFiles(designSrcDir)) {
    const p = parseFile(file);
    if (isParseError(p)) out.push(p);
    else {
      out.push(...colorFindings(p, rule, message));
      if (!isTest) out.push(...charIconFindings(p));
    }
  }
  return out;
}

/**
 * 界面规范：apps/web/src 只能用 @capybara-hq/design 搭界面（导入边界、样式归属、页面模板、颜色字面量），
 * packages/design/src 的颜色字面量只能在 styles/tokens.css。
 */
export function checkWebUi(
  webSrcDir: string,
  designSrcDir: string,
  pending: readonly SsrPending[] = SSR_PENDING,
): Finding[] {
  const findings: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    findings.push(...checkWebFile(file, isTest, webSrcDir));
  }
  for (const css of listCssFiles(webSrcDir)) {
    findings.push({
      file: css,
      line: 1,
      rule: "web-ui-css-file",
      message: "apps/web/src 下不得有 .css 文件；删除它，样式写进 packages/design",
    });
  }
  findings.push(...charIconMessageFindings(join(webSrcDir, "..", "messages")));
  findings.push(...checkDesign(designSrcDir));
  return applySsrPending(findings, webSrcDir, pending);
}
