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
 * `web-ui-box-in-box` (spec §1 "One box is enough", §9.1; acceptance item AB): inside a box
 * (a Card, a form card, a Dialog or Sheet, an inline card, a Callout …) group with headings,
 * hairlines and space, never a second box. The check reads the JSX of apps/web/src: a boxed design
 * component drawn inside another, directly or through a component of apps/web whose JSX draws one
 * (followed across relative and `@/` imports). The rendered half (what the design package and the
 * /dev/ui catalog draw) is the jsdom guard `findNestedBoxes` of `@capybara-hq/design/reference`.
 */
export const BOX_RULE = "web-ui-box-in-box";
export const BOX_STALE_RULE = "web-ui-box-stale-pending";
const DESIGN_PKG = "@capybara-hq/design";
const SPEC = "docs/design/spec.md §1";

/** Design components whose children are drawn inside their box. */
const OUTER = new Set([
  "Card",
  "FormSection",
  "Dialog",
  "DangerConfirm",
  "Sheet",
  "Popover",
  "InlineCard",
  "PropertySection",
  "Callout",
  "DangerZone",
  "ObjectList",
]);
/** Overlays: drawn in a portal, so as children they are not inside the box around them. */
const PORTALS = new Set(["Dialog", "DangerConfirm", "Sheet", "Popover", "Menu", "CommandPalette"]);
/**
 * Design components that draw a box and have no unboxed form: inside a box they are a second box.
 * (CodeBlock, EmbedFrame, DataTable and Repeater draw their unboxed form inside a box by
 * themselves; PropertySection becomes a heading and hairline group; RadioGroup's option cards
 * and the form controls are the spec's exceptions.)
 */
const BOXED = new Set([
  "Card",
  "FormSection",
  "LoadingFormSection",
  "InlineCard",
  "Callout",
  "DangerZone",
  "ObjectList",
  "LinkCard",
  "StatCards",
  "FilePicker",
]);
/** Full-height panes: what they hold is on a page again. */
const PANES = new Set(["RightPanel"]);
/** Pieces with a `framed` prop: an explicit `framed` inside a box draws a second box. */
const FRAMED = new Set(["CodeBlock", "EmbedFrame", "DataTable"]);
/** Allowed inner boxes by outer box, with the reason (spec §1). */
const ALLOWED: Readonly<Record<string, { outer: string; reason: string }>> = {
  FilePicker: {
    outer: "Dialog",
    reason: "a dialog's one file drop zone is a control, not a group (spec §6.25)",
  },
};

/** What to use instead, by the inner box. */
const FIX: Readonly<Record<string, string>> = {
  Card: 'an ItemList of ItemListItem rows (a flush FormSection with `inset="flush"`) or a Subsection',
  FormSection: "a Subsection",
  LoadingFormSection: "a Subsection",
  InlineCard: "the card's content directly",
  Callout: "the Callout above the box (spec §6.19: never inside a card or form card)",
  DangerZone: "the DangerZone on the page ground",
  ObjectList: "an ItemList",
  LinkCard: "a TextLink in a row",
  StatCards: "KeyValue figures",
  FilePicker: "the FilePicker on the page ground or in a Dialog",
  DataTable: "a `flush` FormSection (the table runs to the card's edges, unframed)",
};

/**
 * Occurrences found before the rule existed (acceptance item AB, wave 1), fixed by wave 2. A
 * finding whose file and inner box match an entry is not reported. The list only shrinks: an entry
 * whose file no longer has the finding fails (`web-ui-box-stale-pending`); an entry the static
 * reading cannot reach (`rendered`: the inner box is drawn through a hook's render callback, which
 * the jsdom guard sees) stays while its file still draws the inner box. New code adds no entry.
 */
export interface BoxPending {
  /** The occurrence's number in `.superpowers/acceptance/fix-AB-brief.md`. */
  id: string;
  /** Under apps/web/src: the file where the inner box sits inside the outer one. */
  path: string;
  /** The inner box as the finding names it (a design component or an apps/web component). */
  inner: string;
  /** The brief's pattern and its approved fix. */
  fix: string;
  /** The static reading cannot connect the two boxes; live while `path` draws `<inner>`. */
  rendered?: true;
}

export const BOX_PENDING: readonly BoxPending[] = [
  // Empty since AB wave 2. Occurrences 5 (Repeater cards in a form card), 12's arrays, 14, 15, 16
  // (a CodeBlock in a card) and 20-24 (an embed, a plugin view and the narrow properties sheet)
  // were fixed in the design package by wave 1: those pieces draw their unboxed form inside a box
  // by themselves. Wave 2 rewired the pages for 1-4, 6-13 and 17-19 (item rows, subsections, the
  // Callout above the card, warn lines and headings inside the overlays).
];

type Component = { node: Node; file: string };
interface FileInfo {
  parsed: ParsedFile;
  /** Local names bound to design exports: local -> exported name. */
  design: Map<string, string>;
  /** Components defined in the file (function declarations, `const X = (…) =>`), by name. */
  local: Map<string, Node>;
  /** Default export's component, when it is one. */
  defaultExport?: Node;
  /** Local names bound to imports from apps/web files: local -> [module path, imported name]. */
  imported: Map<string, [string, string]>;
  /** `export { a as b } from "./x"` / `export * from "./x"` re-exports. */
  reexports: { from: string; name?: string; local?: string }[];
}

interface Traits {
  /** The boxes it draws in its JSX (outside portals): inside another box each is a second box. */
  boxed?: string[];
  /** Draws a DataTable (outside portals): inside a non-flush form section it is padded in. */
  table?: boolean;
  /** Draws its `children` inside a box: it acts as that box. */
  wraps?: string;
}

const isCapitalized = (s: string) => /^[A-Z]/.test(s);
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

function elementName(n: Node): string | undefined {
  const opening = n.openingElement as Node | undefined;
  const name = opening?.name as Node | undefined;
  return name?.type === "JSXIdentifier" ? (name.name as string) : undefined;
}

/** A JSX attribute's presence and literal truth: `framed`, `framed={true}`, `flush`. */
function attrTrue(n: Node, attr: string): boolean {
  const attrs = ((n.openingElement as Node).attributes as Node[]) ?? [];
  for (const a of attrs) {
    if (a.type !== "JSXAttribute") continue;
    if ((a.name as Node).name !== attr) continue;
    const v = a.value as Node | null;
    if (v === null) return true;
    if (v.type === "JSXExpressionContainer") {
      const e = v.expression as Node;
      return e.type === "Literal" && e.value === true;
    }
    return false;
  }
  return false;
}

/** The function a variable declarator or declaration holds, when it is a component. */
function componentOf(n: Node | null | undefined): Node | undefined {
  if (!n) return undefined;
  if (n.type === "FunctionDeclaration" || n.type === "FunctionExpression") return n;
  if (n.type === "ArrowFunctionExpression") return n;
  if (n.type === "CallExpression") {
    // memo(…), forwardRef(…)
    const arg = (n.arguments as Node[])[0];
    return componentOf(arg);
  }
  return undefined;
}

export class BoxReader {
  private files = new Map<string, FileInfo | null>();
  private traits = new Map<string, Traits>();
  private visiting = new Set<string>();

  constructor(private readonly webSrcDir: string) {}

  info(file: string): FileInfo | null {
    if (this.files.has(file)) return this.files.get(file) ?? null;
    const parsed = parseFile(file);
    if (isParseError(parsed)) {
      this.files.set(file, null);
      return null;
    }
    const info: FileInfo = {
      parsed,
      design: new Map(),
      local: new Map(),
      imported: new Map(),
      reexports: [],
    };
    for (const st of (parsed.program.body as Node[] | undefined) ?? []) {
      if (st.type === "ImportDeclaration" && st.importKind !== "type") {
        const spec = String((st.source as Node).value);
        const target = spec === DESIGN_PKG ? DESIGN_PKG : resolveModule(spec, file, this.webSrcDir);
        if (target === undefined) continue;
        for (const sp of (st.specifiers as Node[]) ?? []) {
          if (sp.importKind === "type") continue;
          const local = (sp.local as Node).name as string;
          let imported: string | undefined;
          if (sp.type === "ImportSpecifier") {
            const im = sp.imported as Node;
            imported = String(im.name ?? im.value);
          } else if (sp.type === "ImportDefaultSpecifier") imported = "default";
          if (imported === undefined) continue;
          if (target === DESIGN_PKG) info.design.set(local, imported);
          else info.imported.set(local, [target, imported]);
        }
        continue;
      }
      if (st.type === "ExportAllDeclaration" && st.source) {
        const from = resolveModule(String((st.source as Node).value), file, this.webSrcDir);
        if (from) info.reexports.push({ from });
        continue;
      }
      if (st.type === "ExportNamedDeclaration" && st.source) {
        const from = resolveModule(String((st.source as Node).value), file, this.webSrcDir);
        if (!from) continue;
        for (const sp of (st.specifiers as Node[]) ?? []) {
          const loc = sp.local as Node;
          const ex = sp.exported as Node;
          info.reexports.push({
            from,
            local: String(loc.name ?? loc.value),
            name: String(ex.name ?? ex.value),
          });
        }
        continue;
      }
      if (st.type === "ExportDefaultDeclaration") {
        const d = st.declaration as Node;
        const fn = componentOf(d);
        if (fn) {
          info.defaultExport = fn;
          const id = (d as Node).id as Node | undefined;
          if (id?.name) info.local.set(id.name as string, fn);
        } else if (d.type === "Identifier") {
          const name = d.name as string;
          const found = info.local.get(name);
          if (found) info.defaultExport = found;
          else info.defaultExport = { type: "DeferredIdentifier", start: 0, end: 0, name };
        }
        continue;
      }
      const decl = st.type === "ExportNamedDeclaration" ? (st.declaration as Node | null) : st;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        const name = (decl.id as Node).name as string;
        if (isCapitalized(name)) info.local.set(name, decl);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of (decl.declarations as Node[]) ?? []) {
          const id = d.id as Node;
          if (id.type !== "Identifier" || !isCapitalized(id.name as string)) continue;
          const fn = componentOf(d.init as Node | null);
          if (fn) info.local.set(id.name as string, fn);
        }
      }
    }
    const deferred = info.defaultExport;
    if (deferred?.type === "DeferredIdentifier") {
      const found = info.local.get(deferred.name as string);
      if (found) info.defaultExport = found;
      else delete info.defaultExport;
    }
    this.files.set(file, info);
    return info;
  }

  /** The component an apps/web module exports under `name`, following re-exports. */
  private exported(file: string, name: string, depth = 0): Component | undefined {
    if (depth > 8) return undefined;
    const info = this.info(file);
    if (!info) return undefined;
    if (name === "default")
      return info.defaultExport ? { node: info.defaultExport, file } : undefined;
    const local = info.local.get(name);
    if (local) return { node: local, file };
    for (const r of info.reexports) {
      if (r.name === undefined) {
        const found = this.exported(r.from, name, depth + 1);
        if (found) return found;
      } else if (r.name === name) return this.exported(r.from, r.local ?? name, depth + 1);
    }
    return undefined;
  }

  /** The component a JSX name in `file` stands for (same file or an apps/web import). */
  componentFor(file: string, name: string): Component | undefined {
    const info = this.info(file);
    if (!info) return undefined;
    const local = info.local.get(name);
    if (local) return { node: local, file };
    const imp = info.imported.get(name);
    if (imp) return this.exported(imp[0], imp[1]);
    return undefined;
  }

  /** What a component of apps/web draws (memoized; a cycle reads as nothing). */
  traitsOf(c: Component): Traits {
    const key = `${c.file}:${c.node.start}`;
    const known = this.traits.get(key);
    if (known) return known;
    if (this.visiting.has(key)) return {};
    this.visiting.add(key);
    const t: Traits = {};
    const info = this.info(c.file);
    if (info) this.scan(c.node, info, c.file, null, null, t);
    this.visiting.delete(key);
    this.traits.set(key, t);
    return t;
  }

  /**
   * Walks `root` with the nearest enclosing box (`box`, with whether it is a flush form card) and
   * reports nested boxes to `report`, or collects the root component's traits into `traits`.
   */
  scan(
    root: Node,
    info: FileInfo,
    file: string,
    report: ((inner: string, outer: string, at: Node, how: string) => void) | null,
    start: { name: string; flush: boolean } | null,
    traits: Traits | null,
  ): void {
    const visit = (n: Node, box: { name: string; flush: boolean } | null, portal: boolean) => {
      if (n.type === "JSXElement") {
        const name = elementName(n);
        let next = box;
        let nextPortal = portal;
        if (name !== undefined) {
          const design = info.design.get(name);
          if (design !== undefined) {
            const inner = BOXED.has(design) ? design : undefined;
            if (inner !== undefined) {
              if (box && !(ALLOWED[inner]?.outer === box.name)) report?.(inner, box.name, n, "");
              if (!portal && traits) traits.boxed = [...new Set([...(traits.boxed ?? []), inner])];
            }
            if (design === "DataTable") {
              if (box?.name === "FormSection" && !box.flush) report?.("DataTable", box.name, n, "");
              if (!portal && traits) traits.table = true;
            }
            if (FRAMED.has(design) && box && attrTrue(n, "framed"))
              report?.(design, box.name, n, " (framed)");
            if (PORTALS.has(design)) nextPortal = true;
            if (OUTER.has(design)) next = { name: design, flush: attrTrue(n, "flush") };
            if (PANES.has(design)) next = null;
          } else if (isCapitalized(name)) {
            const c = this.componentFor(file, name);
            if (c) {
              const t = this.traitsOf(c);
              const second = (t.boxed ?? []).filter((b) => ALLOWED[b]?.outer !== box?.name);
              if (second.length > 0 && box) report?.(name, box.name, n, ` (draws ${second[0]})`);
              if (t.table && box?.name === "FormSection" && !box.flush)
                report?.(name, box.name, n, " (draws a DataTable)");
              if (traits && !portal) {
                if (t.boxed) traits.boxed = [...new Set([...(traits.boxed ?? []), ...t.boxed])];
                if (t.table) traits.table = true;
              }
              if (t.wraps !== undefined) next = { name: t.wraps, flush: false };
            }
          }
        }
        // The element's attributes (render props, `title`, `actions`) are inside its box too.
        for (const a of ((n.openingElement as Node).attributes as Node[]) ?? [])
          walkInto(a, next, nextPortal);
        for (const ch of (n.children as Node[]) ?? []) walkInto(ch, next, nextPortal);
        return;
      }
      if (
        traits &&
        box &&
        !portal &&
        n.type === "JSXExpressionContainer" &&
        isChildrenRef(n.expression as Node)
      ) {
        if (traits.wraps === undefined) traits.wraps = box.name;
      }
      for (const [k, v] of Object.entries(n)) {
        if (k === "type" || k === "start" || k === "end") continue;
        if (typeof v === "object" && v !== null) walkInto(v, box, portal);
      }
    };
    const walkInto = (
      v: unknown,
      box: { name: string; flush: boolean } | null,
      portal: boolean,
    ) => {
      if (Array.isArray(v)) {
        for (const x of v) walkInto(x, box, portal);
        return;
      }
      if (typeof v === "object" && v !== null && typeof (v as Node).type === "string")
        visit(v as Node, box, portal);
    };
    visit(root, start, false);
  }
}

function isChildrenRef(e: Node): boolean {
  if (e.type === "Identifier") return e.name === "children";
  if (e.type === "MemberExpression") {
    const p = e.property as Node;
    return p.type === "Identifier" && p.name === "children";
  }
  return false;
}

/** Every box-in-box finding of apps/web/src (test files and the pending list aside). */
export function boxFindings(
  webSrcDir: string,
  pending: readonly BoxPending[] = BOX_PENDING,
): Finding[] {
  const reader = new BoxReader(webSrcDir);
  const raw: (Finding & { inner: string })[] = [];
  for (const { file, isTest } of listSourceFiles(webSrcDir)) {
    if (isTest || !/\.tsx$/.test(file)) continue;
    const info = reader.info(file);
    if (!info) continue;
    // Each top-level statement starts on the page ground; nested boxes are found inside it.
    for (const st of (info.parsed.program.body as Node[] | undefined) ?? []) {
      reader.scan(
        st,
        info,
        file,
        (inner, outer, at, how) => {
          raw.push({
            file,
            line: info.parsed.lineOf(at.start),
            rule: BOX_RULE,
            inner,
            message: `<${inner}>${how} inside <${outer}>: one box is enough (${SPEC}); use ${FIX[inner] ?? "headings, hairlines and space"} instead`,
          });
        },
        null,
        null,
      );
    }
  }
  const rel = (f: string) => relative(webSrcDir, f).split(sep).join("/");
  const matches = (f: { file: string; inner: string }, e: BoxPending) =>
    rel(f.file) === e.path && f.inner === e.inner;
  const out: Finding[] = raw
    .filter((f) => !pending.some((e) => matches(f, e)))
    .map(({ inner: _inner, ...f }) => f);
  for (const e of pending) {
    const file = join(webSrcDir, ...e.path.split("/"));
    const where = `BOX_PENDING entry ${e.id} (${e.path}, <${e.inner}>)`;
    if (!existsSync(file)) {
      out.push({
        file,
        line: 1,
        rule: BOX_STALE_RULE,
        message: `${where}: the file does not exist; remove the entry from BOX_PENDING in tools/checks/src/box-in-box.ts`,
      });
      continue;
    }
    const live = e.rendered ? drawsElement(reader, file, e.inner) : raw.some((f) => matches(f, e));
    if (!live)
      out.push({
        file,
        line: 1,
        rule: BOX_STALE_RULE,
        message: `${where} is fixed; remove it from BOX_PENDING in tools/checks/src/box-in-box.ts (the list only shrinks)`,
      });
  }
  return out;
}

/** The file still draws a design `<name>` element (a `rendered` entry's liveness). */
function drawsElement(reader: BoxReader, file: string, name: string): boolean {
  const info = reader.info(file);
  if (!info) return false;
  let found = false;
  walk(info.parsed.program, (n) => {
    if (found || n.type !== "JSXElement") return;
    const el = elementName(n);
    if (el !== undefined && info.design.get(el) === name) found = true;
  });
  return found;
}
