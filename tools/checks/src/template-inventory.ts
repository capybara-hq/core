// Lists, per route page of apps/web, which design page templates it draws (responsive system spec
// §6): `pnpm --filter @capybara-hq/checks inventory:templates`. A script, not a `pnpm check` check.
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectImports,
  isParseError,
  type Node,
  type ParsedFile,
  parseFile,
  walk,
} from "./source.js";
import { WEB_UI_TEMPLATES } from "./web-ui.js";

export type InventoryRow = {
  route: string;
  templates: string[];
  variant?: "cards" | "objects" | "records";
  tabs: number;
  filtersKind?: "segmented" | "tabs" | "fields";
  dataTables: number;
  audience: "member" | "org-admin" | "super-admin" | "public";
};

const TEMPLATES = new Set<string>(WEB_UI_TEMPLATES);
const SOURCE_EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];
const VARIANTS = new Set(["cards", "objects", "records"]);

function resolveModule(spec: string, fromFile: string, srcDir: string): string | undefined {
  let base: string;
  if (spec.startsWith("@/")) base = join(srcDir, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return undefined;
  if (/\.[jt]sx?$/.test(base) && existsSync(base)) return base;
  for (const ext of SOURCE_EXTS) if (existsSync(base + ext)) return base + ext;
  return undefined;
}

function parse(file: string): ParsedFile | undefined {
  const p = parseFile(file);
  return isParseError(p) ? undefined : p;
}

/**
 * The route prefixes of the nav items marked `desktopOnly`, parsed from nav.tsx: the first segment
 * of each such item's `href`, plus every `under(pathname, "/x")` that `activeNavOf` maps to such an
 * item (trajectories belong to the evals item).
 */
export function desktopOnlyPrefixes(srcDir: string): string[] {
  const file = join(srcDir, "components/shell/nav.tsx");
  const p = existsSync(file) ? parse(file) : undefined;
  if (!p) return [];
  const out = new Set<string>();
  const ids = new Set<string>();
  walk(p.program, (n) => {
    if (n.type !== "ObjectExpression") return;
    let id: string | undefined;
    let href: string | undefined;
    let desktopOnly = false;
    for (const prop of n.properties as Node[]) {
      if (prop.type !== "Property") continue;
      const k = prop.key as Node;
      const name = (k.name ?? k.value) as string;
      const v = prop.value as Node;
      const str = v.type === "Literal" && typeof v.value === "string" ? v.value : undefined;
      if (name === "id") id = str;
      if (name === "href") href = str;
      if (name === "desktopOnly" && v.type === "Literal" && v.value === true) desktopOnly = true;
    }
    if (desktopOnly && id) ids.add(id);
    if (desktopOnly && href) out.add(`/${href.split("/")[1]}`);
  });
  walk(p.program, (n) => {
    if (n.type !== "IfStatement") return;
    let returned: string | undefined;
    walk(n.consequent, (r) => {
      const arg = r.type === "ReturnStatement" ? (r.argument as Node | null) : null;
      if (arg?.type === "Literal" && typeof arg.value === "string") returned = arg.value;
    });
    if (!returned || !ids.has(returned)) return;
    walk(n.test, (c) => {
      if (c.type !== "CallExpression" || (c.callee as Node).name !== "under") return;
      const lit = (c.arguments as Node[])[1];
      if (lit?.type === "Literal" && typeof lit.value === "string") out.add(lit.value);
    });
  });
  return [...out].sort();
}

function listPages(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listPages(full));
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

function routeOf(appDir: string, page: string): { route: string; auth: boolean } {
  const rel = page.slice(appDir.length + 1).split(sep);
  rel.pop();
  const auth = rel[0] === "(auth)";
  const segs = rel.filter((s) => !/^\(.*\)$/.test(s)).map((s) => s.replace(/^\[(.*)\]$/, "<$1>"));
  return { route: `/${segs.join("/")}`, auth };
}

/** The page, its `./view`, and the components they import (relative and `@/`, re-exports followed). */
function filesOf(page: string, srcDir: string): string[] {
  const seen = new Set<string>([page]);
  const follow = (file: string, depth: number) => {
    const p = parse(file);
    if (!p) return;
    for (const ref of collectImports(p.program)) {
      const target = resolveModule(ref.spec, file, srcDir);
      if (!target || seen.has(target)) continue;
      // Components of apps/web only; the app tree below the page is its view, not other routes.
      if (target.includes(`${sep}app${sep}`) && !target.startsWith(`${dirname(page)}${sep}`))
        continue;
      seen.add(target);
      // page -> view -> components (depth 2); a re-export hop is followed one more level.
      if (depth < 2 || isReexport(target)) follow(target, depth + 1);
    }
  };
  follow(page, 0);
  return [...seen];
}

function isReexport(file: string): boolean {
  const p = parse(file);
  if (!p) return false;
  const body = (p.program.body as Node[]) ?? [];
  return (
    body.length > 0 &&
    body.every(
      (n) =>
        (n.type === "ExportNamedDeclaration" || n.type === "ExportAllDeclaration") && !!n.source,
    )
  );
}

function jsxName(n: Node): string | undefined {
  const name = (n.name ?? {}) as Node;
  return name.type === "JSXIdentifier" ? (name.name as string) : undefined;
}

export function inventoryTemplates(appDir: string): InventoryRow[] {
  const srcDir = appDir;
  const appRoot = join(appDir, "app");
  const prefixes = desktopOnlyPrefixes(srcDir);
  const rows: InventoryRow[] = [];
  for (const page of listPages(appRoot)) {
    const { route, auth } = routeOf(appRoot, page);
    const templates = new Set<string>();
    let tabs = 0;
    let dataTables = 0;
    let segmented = false;
    let hasFilters = false;
    let variant: InventoryRow["variant"];
    const own = (f: string) => dirname(f) === dirname(page);
    for (const file of filesOf(page, srcDir)) {
      const p = parse(file);
      if (!p) continue;
      walk(p.program, (n) => {
        if (n.type === "JSXOpeningElement") {
          const name = jsxName(n);
          if (!name) return;
          // StatusPage drawn by shared components (ErrorFrame, NoAccess, ...) is counted with
          // the routes that use them (spec §6): only the page or its view draws it for the row.
          if (TEMPLATES.has(name) && (name !== "StatusPage" || own(file))) templates.add(name);
          if (name === "Tabs") tabs++;
          if (name === "Segmented") segmented = true;
          if (name === "DataTable") dataTables++;
          if (name === "ListPage") {
            for (const a of n.attributes as Node[]) {
              const an = a.type === "JSXAttribute" ? (a.name as Node).name : undefined;
              const v = a.value as Node | null;
              if (an === "variant" && v?.type === "Literal" && VARIANTS.has(v.value as string))
                variant ??= v.value as InventoryRow["variant"];
              if (an === "filters") hasFilters = true;
            }
          }
        }
        // `const common = { variant: "cards", filters }` spread onto ListPage
        if (n.type === "Property" && (n.key as Node).name === "variant") {
          const v = n.value as Node;
          const lit = v.type === "TSAsExpression" ? (v.expression as Node) : v;
          if (lit.type === "Literal" && VARIANTS.has(lit.value as string))
            variant ??= lit.value as InventoryRow["variant"];
        }
        if (n.type === "Property" && (n.key as Node).name === "filters") hasFilters = true;
      });
    }
    const row: InventoryRow = {
      route,
      templates: [...templates].sort(),
      tabs,
      dataTables,
      audience: audienceOf(route, auth, prefixes),
    };
    if (templates.has("ListPage")) {
      if (variant) row.variant = variant;
      if (hasFilters) row.filtersKind = segmented ? "segmented" : tabs > 0 ? "tabs" : "fields";
    }
    rows.push(row);
  }
  return rows.sort((a, b) => (a.route < b.route ? -1 : a.route > b.route ? 1 : 0));
}

function audienceOf(route: string, auth: boolean, desktopOnly: string[]): InventoryRow["audience"] {
  if (auth) return "public";
  if (route === "/admin" || route.startsWith("/admin/")) return "super-admin";
  if (route === "/settings" || route.startsWith("/settings/")) return "org-admin";
  if (desktopOnly.some((p) => route === p || route.startsWith(`${p}/`))) return "org-admin";
  return "member";
}

/** Counts per template and per audience, for comparing with spec §6.5. */
export function summarize(rows: InventoryRow[]): string {
  const lines: string[] = [];
  const by = new Map<string, number>();
  for (const r of rows) for (const t of r.templates) by.set(t, (by.get(t) ?? 0) + 1);
  lines.push(`pages: ${rows.length}`);
  lines.push(`no template: ${rows.filter((r) => r.templates.length === 0).length}`);
  for (const [t, n] of [...by].sort()) lines.push(`${t}: ${n}`);
  const aud = (a: string) => rows.filter((r) => r.audience === a && r.templates.length > 0).length;
  lines.push(
    `templated by audience: member ${aud("member")}, org-admin ${aud("org-admin")}, super-admin ${aud("super-admin")}, public ${aud("public")}`,
  );
  return lines.join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const dir = process.argv[2]
    ? resolve(process.argv[2])
    : fileURLToPath(new URL("../../../apps/web/src", import.meta.url));
  const rows = inventoryTemplates(dir);
  if (process.argv.includes("--json")) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const r of rows)
      console.log(
        `${r.route}\t${r.audience}\t${r.templates.join("+") || "-"}${r.variant ? `\t${r.variant}` : ""}`,
      );
    console.log(`\n${summarize(rows)}`);
  }
}
