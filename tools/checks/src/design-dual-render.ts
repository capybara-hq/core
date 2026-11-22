import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Finding, isParseError, listSourceFiles, type Node, parseFile } from "./source.js";

/**
 * `design-dual-render` (responsive system spec §5.3, §7): a component that pairs `useHydrated`
 * with a size class or touch query writes its own dual render by hand. Structure that differs per
 * class goes through the `ClassForms` helper (`shell/class-forms.tsx`), the one place that draws
 * both forms before hydration and prunes one after. The scan covers the non-test files of
 * `packages/design/src`; a function (a component or a hook, nested functions apart) that calls
 * `useHydrated` and one of the class queries outside `shell/class-forms.tsx` fails.
 */
export const DUAL_RENDER_RULE = "design-dual-render";
export const DUAL_RENDER_STALE_RULE = "design-dual-render-stale-pending";

/** The one file allowed to pair them. */
export const CLASS_FORMS_FILE = "shell/class-forms.tsx";

/** Hooks that read the size class or touch. */
const CLASS_HOOKS = new Set(["useSizeClass", "useTouch", "useMobileSizes"]);
/** Constants a `useMediaQuery` argument may name to ask a class / touch / width-class question. */
const CLASS_QUERY_NAMES = new Set([
  "SIZE_CLASS_QUERIES",
  "COMPACT_QUERY",
  "MOBILE_SIZE_QUERY",
  "TOUCH_QUERY",
  "INLINE_RIGHT_AREA_BELOW",
  "INLINE_RIGHT_AREA_QUERY",
]);

/**
 * Today's pairs, a ratchet like `BOX_PENDING`: more findings than `max` are all reported, fewer or
 * none (or a missing file) fail as stale, so the list only shrinks as the tasks that move a
 * component onto `ClassForms` land. New code adds no entry.
 */
export interface DualRenderPending {
  /** Under packages/design/src, `/`-separated. */
  path: string;
  /** How many functions of the file may still pair them. */
  max: number;
  /** The task that moves it onto `ClassForms`. */
  fix: string;
}

export const DUAL_RENDER_PENDING: readonly DualRenderPending[] = [
  { path: "shell/body.tsx", max: 1, fix: "BodyFrame rail / inspector forms move to ClassForms" },
  { path: "shell/sidebar.tsx", max: 1, fix: "Sidebar modes move to ClassForms" },
  { path: "shell/app-shell.tsx", max: 1, fix: "AppShell frame forms move to ClassForms" },
];

const isFunction = (n: Node) =>
  n.type === "FunctionDeclaration" ||
  n.type === "FunctionExpression" ||
  n.type === "ArrowFunctionExpression";

function calleeName(call: Node): string | undefined {
  const c = call.callee as Node;
  return c.type === "Identifier" ? (c.name as string) : undefined;
}

function mentionsClassQuery(n: unknown): boolean {
  if (typeof n !== "object" || n === null) return false;
  if (Array.isArray(n)) return n.some(mentionsClassQuery);
  const node = n as Node;
  if (node.type === "Identifier" && CLASS_QUERY_NAMES.has(node.name as string)) return true;
  return Object.entries(node).some(
    ([k, v]) => k !== "type" && typeof v === "object" && v !== null && mentionsClassQuery(v),
  );
}

/** The calls a function makes itself, without those of the functions nested in it. */
function ownCalls(fn: Node, visit: (call: Node) => void): void {
  const go = (n: unknown, top: boolean): void => {
    if (typeof n !== "object" || n === null) return;
    if (Array.isArray(n)) {
      for (const x of n) go(x, false);
      return;
    }
    const node = n as Node;
    if (!top && isFunction(node)) return;
    if (node.type === "CallExpression") visit(node);
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      go(v, false);
    }
  };
  go(fn, true);
}

/** Every function of a parsed design file that pairs `useHydrated` with a class query. */
export function dualRenderFindings(file: string, program: Node, lineOf: (o: number) => number) {
  const out: Finding[] = [];
  const visitFn = (n: unknown): void => {
    if (typeof n !== "object" || n === null) return;
    if (Array.isArray(n)) {
      for (const x of n) visitFn(x);
      return;
    }
    const node = n as Node;
    if (isFunction(node)) {
      let hydrated = false;
      let query: string | undefined;
      ownCalls(node, (call) => {
        const name = calleeName(call);
        if (name === "useHydrated") hydrated = true;
        else if (name && CLASS_HOOKS.has(name)) query ??= name;
        else if (name === "useMediaQuery" && mentionsClassQuery(call.arguments))
          query ??= "useMediaQuery(<class query>)";
      });
      if (hydrated && query)
        out.push({
          file,
          line: lineOf(node.start),
          rule: DUAL_RENDER_RULE,
          message: `useHydrated paired with ${query}: a structure that differs per class goes through ClassForms (shell/class-forms.tsx), which draws both forms before hydration and prunes one after`,
        });
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      visitFn(v);
    }
  };
  visitFn(program);
  return out;
}

/** The rule over `packages/design/src`, with the ratchet. */
export function dualRenderTreeFindings(
  designSrcDir: string,
  pending: readonly DualRenderPending[] = DUAL_RENDER_PENDING,
): Finding[] {
  const rel = (f: string) => relative(designSrcDir, f).split(sep).join("/");
  const raw: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(designSrcDir)) {
    if (isTest || rel(file) === CLASS_FORMS_FILE) continue;
    const p = parseFile(file);
    if (isParseError(p)) raw.push(p);
    else raw.push(...dualRenderFindings(file, p.program, p.lineOf));
  }
  const where = "DUAL_RENDER_PENDING in tools/checks/src/design-dual-render.ts";
  const hidden = new Map<DualRenderPending, Finding[]>();
  const out: Finding[] = [];
  for (const f of raw) {
    const e = pending.find((p) => p.path === rel(f.file));
    if (e) hidden.set(e, [...(hidden.get(e) ?? []), f]);
    else out.push(f);
  }
  for (const e of pending) {
    const file = join(designSrcDir, ...e.path.split("/"));
    const found = hidden.get(e) ?? [];
    if (found.length > e.max) {
      for (const f of found)
        out.push({
          ...f,
          message: `${f.message} (pending "${e.path}" allows ${e.max}, found ${found.length})`,
        });
    } else if (found.length < e.max) {
      out.push({
        file,
        line: 1,
        rule: DUAL_RENDER_STALE_RULE,
        message: !existsSync(file)
          ? `"${e.path}": the file does not exist; remove the entry from ${where}`
          : found.length === 0
            ? `no dual render left in "${e.path}": remove the entry from ${where} (the list only shrinks)`
            : `${found.length} dual render(s) left in "${e.path}": lower max to ${found.length} in ${where}`,
      });
    }
  }
  return out;
}
