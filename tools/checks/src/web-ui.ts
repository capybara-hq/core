import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { BOX_PENDING, type BoxPending, boxFindings } from "./box-in-box.js";
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

export { BOX_PENDING, type BoxPending } from "./box-in-box.js";
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
/**
 * Extension UI blocks that only `<ExtensionSlot>` (components/extension-ui) may draw: the view and
 * embed blocks, and the client component and replaceable slot renderers (client extensions spec §11).
 */
const EXTENSION_BLOCKS = new Set([
  "ExtensionPanel",
  "ExtensionSection",
  "ExtensionCard",
  "ExtensionViewTab",
  "EmbedTab",
  "ClientComponentBlock",
  "ReplaceableSlot",
  "ReplaceableFrame",
]);
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

/** The one file that may join a provider and a model into a label. */
const EXTENSION_LABEL_FILE = "lib/extension-label.ts";

/**
 * A provider label built by hand shows the extension id: a template literal that puts `<…>.provider`
 * (or `provider`) before ` / `, or one that holds such an expression and is the value of a `label`
 * property or JSX attribute (spaced or not). Option values (`value:`, encode helpers) stay allowed.
 * Labels go through `modelLabel` / `extensionLabel` (display names).
 */
function extensionLabelFindings(p: ParsedFile): Finding[] {
  const isProvider = (e: Node): boolean => {
    const name =
      e.type === "Identifier"
        ? (e.name as string)
        : e.type === "MemberExpression" && !e.computed
          ? ((e.property as Node).name as string | undefined)
          : undefined;
    return name === "provider";
  };
  const seen = new Set<number>();
  const out: Finding[] = [];
  const flag = (n: Node) => {
    if (seen.has(n.start)) return;
    seen.add(n.start);
    out.push({
      file: p.file,
      line: p.lineOf(n.start),
      rule: "web-ui-extension-label",
      message:
        "provider label built by hand shows the extension id; use modelLabel / extensionLabel from lib/extension-label.ts (display names)",
    });
  };
  const hasProvider = (t: Node) => (t.expressions as Node[]).some(isProvider);
  walk(p.program, (n) => {
    if (n.type === "TemplateLiteral") {
      const exprs = n.expressions as Node[];
      const quasis = n.quasis as Node[];
      exprs.forEach((e, i) => {
        const next = (quasis[i + 1]?.value as { cooked: string | null } | undefined)?.cooked;
        if (isProvider(e) && typeof next === "string" && next.startsWith(" / ")) flag(n);
      });
    } else if (n.type === "Property" && propKey(n) === "label") {
      const v = n.value as Node;
      if (v.type === "TemplateLiteral" && hasProvider(v)) flag(v);
    } else if (n.type === "JSXAttribute") {
      const name = n.name as Node;
      const v = n.value as Node | null;
      if (
        name.type === "JSXIdentifier" &&
        name.name === "label" &&
        v?.type === "JSXExpressionContainer"
      ) {
        const e = v.expression as Node;
        if (e.type === "TemplateLiteral" && hasProvider(e)) flag(e);
      }
    }
  });
  return out;
}

function checkWebFile(
  file: string,
  isTest: boolean,
  webSrcDir: string,
  readers: ReaderMap,
): Finding[] {
  if (isTest) return [];
  const p = parseFile(file);
  if (isParseError(p)) return [p];
  const out: Finding[] = [];
  const segs0 = relative(webSrcDir, file).split(sep);

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
  const EXT_SLOT_MSG = "render extension UI through <ExtensionSlot> (UI slots spec §7)";
  const inExtensionUi = segs0[0] === "components" && segs0[1] === "extension-ui";
  const declared = new Set<string>();
  walk(p.program, (n) => {
    if (n.type === "FunctionDeclaration" || n.type === "VariableDeclarator") {
      const id = n.id as Node | null;
      if (id?.type === "Identifier") declared.add(id.name as string);
    }
  });
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
      else if (
        name.type === "JSXIdentifier" &&
        EXTENSION_BLOCKS.has(name.name as string) &&
        !inExtensionUi &&
        segs0[0] !== "dev" &&
        !declared.has(name.name as string)
      )
        flag("web-ui-extension-slot", EXT_SLOT_MSG, n);
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
  out.push(...formMethodFindings(p));

  const segs = relative(webSrcDir, file).split(sep);
  if (segs.join("/") !== EXTENSION_LABEL_FILE) out.push(...extensionLabelFindings(p));
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
  out.push(...queryFindings(file, p, segs, webSrcDir, readers));
  if (segs[0] === "lib") out.push(...libClientHookFindings(file, p));
  return out;
}

/**
 * `web-lib-client-hook`: server layouts and pages import `lib/**` modules (loaders, `defineQuery`
 * options, the route table), and a server component may not reach a client-only hook (`next build`
 * rejects it; vitest and tsc do not). So a `lib/**` module that imports a hook (`use*`) is a client
 * module and says so with `"use client"` on its first line (`lib/query/mutation.ts`,
 * `page-query.ts`, `workspace.ts`), and the modules server code imports stay hook-free.
 */
function libClientHookFindings(file: string, p: ParsedFile): Finding[] {
  if (isUseClient(p)) return [];
  const out: Finding[] = [];
  for (const st of (p.program.body as Node[] | undefined) ?? []) {
    if (st.type !== "ImportDeclaration" || st.importKind === "type") continue;
    for (const sp of (st.specifiers as Node[] | undefined) ?? []) {
      if (sp.type !== "ImportSpecifier" || sp.importKind === "type") continue;
      const imported = sp.imported as Node;
      const name = (imported.name ?? imported.value) as string | undefined;
      if (name === undefined || !/^use[A-Z]/.test(name)) continue;
      out.push({
        file,
        line: p.lineOf(sp.start),
        rule: "web-lib-client-hook",
        message: `${name} is a client-only hook: server components import lib/** modules, so a lib module that uses hooks starts with "use client" (move the hook out of a module server code imports, e.g. writes into lib/query/mutation.ts)`,
      });
    }
  }
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
/** Empty since the web SSR plan's last batch (Task 11): every page is server-first. */
export const SSR_PENDING: readonly SsrPending[] = [];

const SSR_RULES = {
  loading: "web-ssr-loading-file",
  client: "web-ssr-client-page",
  location: "web-ssr-location",
  viewValue: "web-ssr-view-value-import",
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
 * Value imports and re-exports from `./view` other than its default export: in a server page they
 * are client references, never the value itself (audit docs/design/audits/2026-11-03-unslop-full.md
 * U1). `import type`, inline `type` specifiers, the default import and `export { default }` pass.
 */
function viewValueImports(p: ParsedFile): Node[] {
  const hits: Node[] = [];
  const fromView = (n: Node) =>
    n.source != null && /^\.\/view(?:\.[jt]sx?)?$/.test(String((n.source as Node).value));
  for (const n of (p.program.body as Node[] | undefined) ?? []) {
    if (!fromView(n)) continue;
    if (n.type === "ImportDeclaration") {
      if (n.importKind === "type") continue;
      const bad = (n.specifiers as Node[]).some(
        (sp) => sp.type !== "ImportDefaultSpecifier" && sp.importKind !== "type",
      );
      if (bad) hits.push(n);
    } else if (n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") {
      if (n.exportKind === "type") continue;
      const specs = (n.specifiers as Node[] | undefined) ?? [];
      const value = (sp: Node) =>
        sp.exportKind !== "type" &&
        String((sp.local as Node).name ?? (sp.local as Node).value) !== "default";
      if (n.type === "ExportAllDeclaration" || specs.some(value)) hits.push(n);
    }
  }
  return hits;
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
        "no loading.tsx: it would hide the page behind a fallback; the layout prefetches the route's first-paint reads (lib/query/routes.ts) and the view draws its template's loading state from the query cache (docs/superpowers/specs/2026-11-03-web-query-cache-design.md §3)",
    });

  const group = segs[1];
  if (/^page\.[jt]sx?$/.test(base) && (group === "(app)" || group === "(auth)") && isUseClient(p))
    out.push({
      file,
      line: 1,
      rule: SSR_RULES.client,
      message:
        'a page.tsx is a server component that renders its "use client" ./view; move the template and interaction into view.tsx, which reads its data from the query cache (the route table in lib/query/routes.ts prefetches the first paint)',
    });

  if (/^page\.[jt]sx?$/.test(base) && !isUseClient(p))
    for (const at of viewValueImports(p))
      flag(
        SSR_RULES.viewValue,
        at,
        'a server page.tsx imports only the default export and types from its "use client" ./view: any other value is a client reference on the server (a number becomes a function); move the value into a lib module both import',
      );

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
 * Query-cache conventions (spec docs/superpowers/specs/2026-11-03-web-query-cache-design.md §8):
 * every network read of the web app is a `defineQuery` (`lib/query/define.ts`, hook-free: server
 * layouts import it), every write a `useAppMutation` (`lib/query/mutation.ts`), keys come
 * from `lib/query/keys.ts`, and a route's first-paint reads are listed in `lib/query/routes.ts`.
 * `QUERY_PENDING` lists the files not converted yet. It is a ratchet like `SSR_PENDING`: a listed
 * file is exempt from the `web-query-*` rules (not from other web-ui rules), an entry whose file no
 * longer violates one (or no longer exists) fails as `web-query-stale-pending`, and nothing may be
 * added. Each migration task removes its entries; the last one leaves the list empty.
 */
export interface QueryPending {
  /** Relative to apps/web/src, with `/` separators. */
  path: string;
  reason: string;
}
export const QUERY_PENDING: readonly QueryPending[] = [];

const QUERY_RULES = {
  noDirectRead: "web-query-no-direct-read",
  keys: "web-query-keys",
  freshness: "web-query-freshness",
  pageRead: "web-query-page-read",
  routeTable: "web-query-route-table",
  stale: "web-query-stale-pending",
} as const;
const QUERY_SPEC = "docs/superpowers/specs/2026-11-03-web-query-cache-design.md §8";
const QUERY_EXEMPT = /\/\/\s*query-exempt:(.*)$/;
const KEYS_FILE = "lib/query/keys.ts";
const DEFINE_FILE = "lib/query/define.ts";
const ROUTES_FILE = "lib/query/routes.ts";
/** Calls whose `fn` property may reach the kernel. */
const QUERY_FN_HOSTS = new Set(["defineQuery", "useAppMutation"]);
/** Always a direct read, imported or not. */
const DIRECT_READ_CALLS = new Set(["useLoad", "useServerState", "apiFetch"]);
/** QueryClient methods whose object argument is a filter, not a query definition. */
const QUERY_FILTER_METHODS = new Set([
  "invalidateQueries",
  "cancelQueries",
  "removeQueries",
  "resetQueries",
  "refetchQueries",
  "isFetching",
  "getQueriesData",
  "setQueriesData",
]);
/** Server-side helpers that read nothing from the kernel. */
const SERVER_PURE = new Set([
  "isKernelUnavailable",
  "isSignedOut",
  "currentPath",
  // a request cookie (a remembered view, calendar spec §4.1): no kernel read
  "currentCookie",
  "PATH_HEADER",
  "dehydrateFor",
  "prefetchRoute",
  "serverQueryClient",
]);

/** Exported names of each `src/lib` module (extension stripped) that perform a kernel call. */
export type ReaderMap = Map<string, Set<string>>;

function stripExt(path: string): string {
  return path.replace(/\.[jt]sx?$/, "");
}

/** The functions `lib/**` exports that call `apiFetch`, directly or through a same-file function. */
export function kernelReaders(webSrcDir: string): ReaderMap {
  const map: ReaderMap = new Map();
  const libDir = join(webSrcDir, "lib");
  for (const { file, isTest } of listSourceFiles(libDir)) {
    const rel = relative(libDir, file).split(sep);
    if (isTest || rel[0] === "server" || rel[0] === "query") continue;
    const p = parseFile(file);
    if (isParseError(p)) continue;
    const fns = new Map<string, Node>();
    const exported = new Map<string, string>();
    for (const st of (p.program.body as Node[] | undefined) ?? []) {
      const decl = st.type === "ExportNamedDeclaration" ? (st.declaration as Node | null) : st;
      const isExport = st.type === "ExportNamedDeclaration";
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        const name = (decl.id as Node).name as string;
        fns.set(name, decl);
        if (isExport) exported.set(name, name);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations as Node[]) {
          if ((d.id as Node).type !== "Identifier" || !d.init) continue;
          const name = (d.id as Node).name as string;
          fns.set(name, d.init as Node);
          if (isExport) exported.set(name, name);
        }
      }
      if (isExport && !st.declaration && st.source == null) {
        for (const sp of (st.specifiers as Node[]) ?? []) {
          const local = (sp.local as Node).name as string;
          const out = (sp.exported as Node).name ?? (sp.exported as Node).value;
          exported.set(String(out), local);
        }
      }
    }
    const callsOf = (root: Node): Set<string> => {
      const names = new Set<string>();
      walk(root, (n) => {
        if (n.type !== "CallExpression") return;
        const c = n.callee as Node;
        if (c.type === "Identifier") names.add(c.name as string);
      });
      return names;
    };
    const reads = new Set<string>();
    const calls = new Map([...fns].map(([name, node]) => [name, callsOf(node)]));
    for (const [name, c] of calls) if (c.has("apiFetch")) reads.add(name);
    for (let grew = true; grew; ) {
      grew = false;
      for (const [name, c] of calls)
        if (!reads.has(name) && [...c].some((x) => reads.has(x))) {
          reads.add(name);
          grew = true;
        }
    }
    const names = new Set<string>();
    for (const [out, local] of exported) if (reads.has(local)) names.add(out);
    if (names.size > 0) map.set(stripExt(file), names);
  }
  return map;
}

/** The module an import specifier names, as a path without extension (`@/` is `src/`). */
function resolveSpec(spec: string, fromFile: string, webSrcDir: string): string | undefined {
  if (spec.startsWith("@/")) return join(webSrcDir, spec.slice(2));
  if (spec.startsWith(".")) return resolve(dirname(fromFile), spec);
  return undefined;
}

interface Bound {
  /** `reader`: a kernel-calling lib export; `server`: a `lib/server` helper that may read. */
  kind: "reader" | "server";
  imported: string;
}

/** Local names bound by value imports of kernel readers or `lib/server` helpers, and namespaces. */
function boundReaders(
  p: ParsedFile,
  file: string,
  webSrcDir: string,
  readers: ReaderMap,
): { names: Map<string, Bound>; namespaces: Map<string, string> } {
  const names = new Map<string, Bound>();
  const namespaces = new Map<string, string>();
  const serverDir = join(webSrcDir, "lib", "server") + sep;
  walk(p.program, (n) => {
    if (n.type !== "ImportDeclaration" || n.importKind === "type") return;
    const base = resolveSpec(String((n.source as Node).value), file, webSrcDir);
    if (base === undefined) return;
    const key = stripExt(base);
    const isServer = key.startsWith(serverDir);
    const lib = readers.get(key) ?? readers.get(join(key, "index"));
    for (const sp of n.specifiers as Node[]) {
      if (sp.importKind === "type") continue;
      const local = (sp.local as Node).name as string;
      if (sp.type === "ImportNamespaceSpecifier") {
        if (lib) namespaces.set(local, key);
        continue;
      }
      if (sp.type !== "ImportSpecifier") continue;
      const im = sp.imported as Node;
      const imported = String(im.name ?? im.value);
      if (lib?.has(imported)) names.set(local, { kind: "reader", imported });
      else if (isServer && !SERVER_PURE.has(imported))
        names.set(local, { kind: "server", imported });
    }
  });
  return { names, namespaces };
}

function unwrapExpr(n: Node): Node {
  let cur = n;
  while (
    cur.type === "TSAsExpression" ||
    cur.type === "TSSatisfiesExpression" ||
    cur.type === "ParenthesizedExpression" ||
    cur.type === "TSNonNullExpression"
  )
    cur = cur.expression as Node;
  return cur;
}

function queryFindings(
  file: string,
  p: ParsedFile,
  segs: string[],
  webSrcDir: string,
  readers: ReaderMap,
): Finding[] {
  const out: Finding[] = [];
  const rel = segs.join("/");
  const lines = readFileSync(file, "utf8").split("\n");
  const exemption = (line: number): "none" | "ok" | "empty" => {
    for (const i of [line - 1, line - 2]) {
      const m = QUERY_EXEMPT.exec(lines[i] ?? "");
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
      message: ex === "empty" ? "`// query-exempt:` needs a reason after the colon" : message,
    });
  };

  // web-query-keys: keys are built only in lib/query/keys.ts.
  if (rel !== KEYS_FILE) {
    const keyMessage = `a query key is built only by lib/query/keys.ts: call \`keys.org(id).<area>()\` instead of an array literal (${QUERY_SPEC})`;
    walk(p.program, (n) => {
      if (n.type === "Property" && propKey(n) === "queryKey") {
        if (unwrapExpr(n.value as Node).type === "ArrayExpression")
          flag(QUERY_RULES.keys, n, keyMessage);
      } else if (n.type === "CallExpression" && calleeName(n) === "defineQuery") {
        for (const a of n.arguments as Node[]) {
          if (a.type !== "ObjectExpression") continue;
          for (const q of a.properties as Node[])
            if (propKey(q) === "key" && unwrapExpr(q.value as Node).type === "ArrayExpression")
              flag(QUERY_RULES.keys, q, keyMessage);
        }
      }
    });
  }

  // web-query-freshness: a query definition is `defineQuery`, whose type requires `freshness`.
  if (rel !== DEFINE_FILE) {
    const filters = new Set<Node>();
    walk(p.program, (n) => {
      if (n.type !== "CallExpression") return;
      const name = calleeName(n);
      if (name !== undefined && QUERY_FILTER_METHODS.has(name))
        for (const a of n.arguments as Node[]) filters.add(a);
    });
    walk(p.program, (n) => {
      if (n.type !== "ObjectExpression" || filters.has(n)) return;
      const hit = (n.properties as Node[]).find((q) => {
        const k = propKey(q);
        return k === "queryKey" || k === "queryFn";
      });
      if (hit)
        flag(
          QUERY_RULES.freshness,
          n,
          `an inline \`${propKey(hit)}\` object has no freshness class: declare the read with \`defineQuery({ key, fn, freshness })\` and spread it into \`useQuery\` (${QUERY_SPEC})`,
        );
    });
  }

  const isPage = /^page\.[jt]sx?$/.test(segs.at(-1) ?? "");
  const client = isUseClient(p);
  const inApp = segs[0] === "app" && (segs[1] === "(app)" || segs[1] === "(auth)");
  const bound = boundReaders(p, file, webSrcDir, readers);
  const boundCall = (n: Node): { label: string; bound: Bound | undefined } | undefined => {
    const c = n.callee as Node;
    if (c.type === "Identifier") {
      const b = bound.names.get(c.name as string);
      return b ? { label: b.imported, bound: b } : undefined;
    }
    if (c.type === "MemberExpression" && !c.computed && (c.object as Node).type === "Identifier") {
      const key = bound.namespaces.get((c.object as Node).name as string);
      const prop = (c.property as Node).name as string;
      if (key !== undefined && readers.get(key)?.has(prop))
        return { label: prop, bound: { kind: "reader", imported: prop } };
    }
    return undefined;
  };

  // web-query-page-read: a server page reads nothing; its view reads through queries.
  if (inApp && isPage && !client) {
    walk(p.program, (n) => {
      if (n.type !== "CallExpression") return;
      const hit = boundCall(n);
      if (hit)
        flag(
          QUERY_RULES.pageRead,
          n,
          `a server page.tsx does not read: ${hit.label}() belongs in a query of its view, prefetched through lib/query/routes.ts (${QUERY_SPEC})`,
        );
    });
  }

  // web-query-no-direct-read: client code reads and writes only through defineQuery / useAppMutation.
  if (segs[0] === "components" || (segs[0] === "app" && client)) {
    const allowedFns = new Set<Node>();
    const visit = (n: Node, ok: boolean): void => {
      if (n.type === "CallExpression") {
        const name = calleeName(n);
        if (name !== undefined && QUERY_FN_HOSTS.has(name))
          for (const a of n.arguments as Node[])
            if (a.type === "ObjectExpression")
              for (const q of a.properties as Node[])
                if (propKey(q) === "fn" && q.value) allowedFns.add(q.value as Node);
        const c = n.callee as Node;
        if (c.type === "Identifier" && DIRECT_READ_CALLS.has(c.name as string))
          flag(
            QUERY_RULES.noDirectRead,
            n,
            `${c.name as string}() reads outside the query cache: declare the read with \`defineQuery\` and use \`useQuery\` (${QUERY_SPEC})`,
          );
        else if (!ok) {
          const hit = boundCall(n);
          if (hit && hit.bound?.kind === "reader")
            flag(
              QUERY_RULES.noDirectRead,
              n,
              `${hit.label}() reaches the kernel outside a query: call it only inside the \`fn\` of \`defineQuery\` / \`useAppMutation\` (${QUERY_SPEC})`,
            );
        }
      }
      for (const v of Object.values(n)) {
        if (Array.isArray(v)) {
          for (const c of v)
            if (c && typeof c === "object" && "type" in c)
              visit(c as Node, ok || allowedFns.has(c as Node));
        } else if (v && typeof v === "object" && "type" in v)
          visit(v as Node, ok || allowedFns.has(v as Node));
      }
    };
    visit(p.program, false);
  }
  return out;
}

/** The `pattern` / `none` of every entry of `lib/query/routes.ts`, read from the source. */
function routeEntries(webSrcDir: string): Map<string, { none: Node | undefined }> | undefined {
  const file = join(webSrcDir, ROUTES_FILE);
  if (!existsSync(file)) return undefined;
  const p = parseFile(file);
  if (isParseError(p)) return undefined;
  const entries = new Map<string, { none: Node | undefined }>();
  walk(p.program, (n) => {
    if (n.type !== "ObjectExpression") return;
    const props = n.properties as Node[];
    const pat = props.find((q) => propKey(q) === "pattern");
    const v = pat?.value as Node | undefined;
    if (v?.type !== "Literal" || typeof v.value !== "string") return;
    entries.set(v.value, { none: props.find((q) => propKey(q) === "none")?.value as Node });
  });
  return entries;
}

/** web-query-route-table: every page has a ROUTES entry, and an entry without queries says why. */
function routeTableFindings(webSrcDir: string): Finding[] {
  const entries = routeEntries(webSrcDir);
  if (entries === undefined) return [];
  const out: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    const segs = relative(webSrcDir, file).split(sep);
    if (isTest || segs[0] !== "app" || (segs[1] !== "(app)" && segs[1] !== "(auth)")) continue;
    if (!/^page\.[jt]sx?$/.test(segs.at(-1) ?? "")) continue;
    const pattern = `/${segs
      .slice(1, -1)
      .filter((s) => !/^\(.*\)$/.test(s))
      .join("/")}`;
    const entry = entries.get(pattern);
    if (entry === undefined)
      out.push({
        file,
        line: 1,
        rule: QUERY_RULES.routeTable,
        message: `no ROUTES entry for "${pattern}" in lib/query/routes.ts: list the queries of its first paint, or \`none: "<reason>"\` (${QUERY_SPEC})`,
      });
    else if (
      entry.none?.type === "Literal" &&
      typeof entry.none.value === "string" &&
      entry.none.value.trim() === ""
    )
      out.push({
        file,
        line: 1,
        rule: QUERY_RULES.routeTable,
        message: `the ROUTES entry for "${pattern}" has \`none: ""\`: give the reason it prefetches nothing (${QUERY_SPEC})`,
      });
  }
  return out;
}

/** Drops the web-query findings of the pending files; reports stale and missing entries. */
function applyQueryPending(
  findings: Finding[],
  webSrcDir: string,
  pending: readonly QueryPending[],
): Finding[] {
  const isQuery = (f: Finding) => f.rule.startsWith("web-query-");
  const abs = (path: string) => join(webSrcDir, ...path.split("/"));
  const listed = new Set(pending.map((e) => abs(e.path)));
  const out = findings.filter((f) => !(isQuery(f) && listed.has(f.file)));
  for (const e of pending) {
    const file = abs(e.path);
    const hit = findings.some((f) => isQuery(f) && f.file === file);
    if (!existsSync(file))
      out.push({
        file,
        line: 1,
        rule: QUERY_RULES.stale,
        message: `QUERY_PENDING entry ${e.path} does not exist; remove it from QUERY_PENDING in tools/checks/src/web-ui.ts`,
      });
    else if (!hit)
      out.push({
        file,
        line: 1,
        rule: QUERY_RULES.stale,
        message: `${e.path} no longer violates a web-query rule; remove its QUERY_PENDING entry in tools/checks/src/web-ui.ts (the list only shrinks)`,
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
/**
 * `web-ui-form-method`: every `<form>` (JSX or `createElement("form", …)`) says `method="post"` as a
 * literal. When the client JS does not load (a blocked dev origin, a script error, JS turned off)
 * the browser submits the form natively, and a form without a method is a GET: every field,
 * passwords included, lands in the URL (history, server logs, Referer). Which component inside a
 * form draws a password input cannot be followed statically, so the rule asks it of every form.
 */
function formMethodFindings(p: ParsedFile): Finding[] {
  const out: Finding[] = [];
  const message =
    'a <form> needs method="post": without it a native submission (client JS not loaded) is a GET that puts every field, passwords included, in the URL; add method="post" and a POST handler for the page (apps/web/src/lib/form-post.ts)';
  const isPost = (v: unknown) => typeof v === "string" && v.toLowerCase() === "post";
  const flag = (at: Node) =>
    out.push({ file: p.file, line: p.lineOf(at.start), rule: "web-ui-form-method", message });
  walk(p.program, (n) => {
    if (n.type === "JSXOpeningElement") {
      const name = n.name as Node;
      if (name.type !== "JSXIdentifier" || name.name !== "form") return;
      const method = (n.attributes as Node[]).find(
        (a) =>
          a.type === "JSXAttribute" &&
          (a.name as Node).type === "JSXIdentifier" &&
          (a.name as Node).name === "method",
      );
      const v = method?.value as Node | null | undefined;
      const literal =
        v?.type === "Literal"
          ? v.value
          : v?.type === "JSXExpressionContainer" && (v.expression as Node).type === "Literal"
            ? (v.expression as Node).value
            : undefined;
      if (!isPost(literal)) flag(n);
    } else if (n.type === "CallExpression") {
      const callee = n.callee as Node;
      const fn =
        callee.type === "Identifier"
          ? (callee.name as string)
          : callee.type === "MemberExpression"
            ? ((callee.property as Node).name as string | undefined)
            : undefined;
      if (fn === undefined || !CREATE_ELEMENT.has(fn)) return;
      const args = n.arguments as Node[];
      if (args[0]?.type !== "Literal" || args[0].value !== "form") return;
      const props = args[1];
      const prop =
        props?.type === "ObjectExpression"
          ? (props.properties as Node[]).find((x) => propKey(x) === "method")
          : undefined;
      const v = prop?.value as Node | undefined;
      if (!(v?.type === "Literal" && isPost(v.value))) flag(n);
    }
  });
  return out;
}

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
      if (!isTest) out.push(...charIconFindings(p), ...formMethodFindings(p));
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
  queryPending: readonly QueryPending[] = QUERY_PENDING,
  boxPending: readonly BoxPending[] = BOX_PENDING,
): Finding[] {
  const findings: Finding[] = [];
  const readers = kernelReaders(webSrcDir);
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    findings.push(...checkWebFile(file, isTest, webSrcDir, readers));
  }
  findings.push(...routeTableFindings(webSrcDir));
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
  findings.push(...boxFindings(webSrcDir, boxPending));
  return applyQueryPending(applySsrPending(findings, webSrcDir, pending), webSrcDir, queryPending);
}
