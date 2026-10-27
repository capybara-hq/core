import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
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
const TEMPLATE_EXEMPT_PREFIX = ["app", "[locale]", "dev"];

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
    if (!usesDesignTemplate(p) && !isNotFoundOnlyPage(p)) {
      out.push({
        file,
        line: 1,
        rule: "web-ui-template",
        message: `page 文件必须使用从 @capybara-hq/design 导入的页面模板之一（${WEB_UI_TEMPLATES.join(" / ")}）作为页面骨架`,
      });
    }
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
export function checkWebUi(webSrcDir: string, designSrcDir: string): Finding[] {
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
  return findings;
}
