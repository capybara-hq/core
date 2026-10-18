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

/** spec §5 的 12 个页面模板；必须与 @capybara-hq/design 的 PAGE_TEMPLATES 相同（测试核对）。 */
export const WEB_UI_TEMPLATES = [
  "OverviewPage",
  "ListPage",
  "DetailPage",
  "FormPage",
  "SettingsPage",
  "InboxPage",
  "PlaygroundPage",
  "TracePage",
  "WizardPage",
  "AuthPage",
  "StatusPage",
  "OnboardingPage",
] as const;

const COLOR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;
const ALLOWED_CSS = "@capybara-hq/design/styles.css";
const FORBIDDEN_PKG = /^(?:@radix-ui\/|cmdk(?:\/|$))/;
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
): Finding[] {
  const out: Finding[] = [];
  const hit = (text: string | null | undefined, at: Node) => {
    if (typeof text !== "string") return;
    const m = COLOR.exec(text);
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

function elementNames(p: ParsedFile): Set<string> {
  const names = new Set<string>();
  walk(p.program, (n) => {
    if (n.type !== "JSXOpeningElement") return;
    const name = n.name as Node;
    if (name.type === "JSXIdentifier") names.add(name.name as string);
  });
  return names;
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

  walk(p.program, (n) => {
    if (n.type !== "JSXAttribute") return;
    const name = n.name as Node;
    if (name.type !== "JSXIdentifier") return;
    const line = p.lineOf(n.start);
    if (name.name === "className") {
      out.push({
        file,
        line,
        rule: "web-ui-class-name",
        message:
          "页面内不得写 className；改用 @capybara-hq/design 的组件或布局原语，页面内不写样式",
      });
    } else if (name.name === "style") {
      out.push({
        file,
        line,
        rule: "web-ui-style",
        message: "页面内不得写 style；改用 @capybara-hq/design 的组件或布局原语，页面内不写样式",
      });
    }
  });

  out.push(
    ...colorFindings(
      p,
      "web-ui-color",
      (s) =>
        `不得出现颜色字面量「${s}」；颜色只能来自 @capybara-hq/design 的 token，页面内不写颜色`,
    ),
  );

  const segs = relative(webSrcDir, file).split(sep);
  const exempt = TEMPLATE_EXEMPT_PREFIX.every((s, i) => segs[i] === s);
  if (segs[0] === "app" && segs.at(-1) === "page.tsx" && !exempt) {
    const used = elementNames(p);
    if (!WEB_UI_TEMPLATES.some((t) => used.has(t))) {
      out.push({
        file,
        line: 1,
        rule: "web-ui-template",
        message: `page.tsx 必须使用 @capybara-hq/design 的页面模板之一（${WEB_UI_TEMPLATES.join(" / ")}）作为页面骨架`,
      });
    }
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
  for (const { file } of listSourceFiles(designSrcDir)) {
    const p = parseFile(file);
    if (isParseError(p)) out.push(p);
    else out.push(...colorFindings(p, rule, message));
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
  findings.push(...checkDesign(designSrcDir));
  return findings;
}
