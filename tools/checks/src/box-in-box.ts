import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  type Finding,
  isParseError,
  listSourceFiles,
  type Node,
  type ParsedFile,
  parseFile,
} from "./source.js";

/**
 * `web-ui-box-in-box` (spec §1 "One box is enough", §9.1; acceptance item AB): inside a box
 * (a Card, a form card, a Dialog or Sheet, an inline card, a Callout …) group with headings,
 * hairlines and space, never a second box. The check reads the JSX of apps/web/src: a boxed design
 * component drawn inside another, directly or through a component of apps/web whose JSX draws one
 * (followed across relative and `@/` imports), a same-function `const` holding JSX (a `.map(...)`
 * result too), a same-file helper returning JSX (`renderCard()`), a render function a hook returns
 * (`const { editor } = useX(); editor(v)`, same file or imported), a renamed `children` prop and
 * the other slot props a local wrapper draws inside its box. The rendered half (what the design package and the
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
  "AgentMapDialog",
]);
/**
 * Overlays: drawn in a portal, so what they hold is not inside the box around them. An overlay
 * that is a box itself (Dialog, Sheet, Popover, the agent map's dialog) is the box of what it
 * holds; the others (a menu, the command palette, a tooltip) start again on no box.
 */
const PORTALS = new Set([
  "Dialog",
  "DangerConfirm",
  "Sheet",
  "Popover",
  "Menu",
  "ConvMenu",
  "CommandPalette",
  "Tooltip",
  "AgentMapDialog",
]);
/**
 * Design components that draw a box and have no unboxed form: inside a box they are a second box.
 * (CodeBlock, EmbedFrame, DataTable, Repeater and Callout draw their unboxed form inside a box
 * by themselves; PropertySection becomes a heading and hairline group; RadioGroup's option cards
 * and the form controls are the spec's exceptions.)
 */
const BOXED = new Set([
  "Card",
  "FormSection",
  "LoadingFormSection",
  "InlineCard",
  "DangerZone",
  "ObjectList",
  "LinkCard",
  "StatCards",
  "FilePicker",
]);
/**
 * Full-height panes: what they hold is on a page again (the right panel, the file preview, which
 * the design draws as one, and the agent map's transcript).
 */
const PANES = new Set(["RightPanel", "FilePreviewFrame", "TranscriptFrame"]);
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
  DangerZone: "the DangerZone on the page ground",
  ObjectList: "an ItemList",
  LinkCard: "a TextLink in a row",
  StatCards: "KeyValue figures",
  FilePicker: "the FilePicker on the page ground or in a Dialog",
  DataTable: "a `flush` FormSection (the table runs to the card's edges, unframed)",
};

/**
 * Occurrences found when the rule came (acceptance item AB); a ratchet bounded like `KC_PENDING`.
 * An entry hides up to `max` findings in its file whose inner box is `inner`: more fail (each
 * finding is reported with the allowance), fewer fail as "lower max", none as a stale entry
 * (`web-ui-box-stale-pending`), and so does an entry whose file is gone. New code adds no entry.
 */
export interface BoxPending {
  /** Under apps/web/src: the file where the inner box sits inside the outer one. */
  path: string;
  /** The inner box as the finding names it (a design component or an apps/web name). */
  inner: string;
  /** How many such findings the file may still hold. */
  max: number;
  /** The pattern of the AB brief and its approved fix. */
  fix: string;
}

export const BOX_PENDING: readonly BoxPending[] = [
  // Empty since AB wave 2. Occurrences 5 (Repeater cards in a form card), 12's arrays, 14, 15, 16
  // (a CodeBlock in a card) and 20-24 (an embed, a plugin view and the narrow properties sheet)
  // were fixed in the design package by wave 1: those pieces draw their unboxed form inside a box
  // by themselves. Wave 2 rewired the pages for 1-4, 6-13 and 17-19 (item rows, subsections, the
  // Callout above the card, warn lines and headings inside the overlays).
];

type Box = { name: string; flush: boolean } | null;
/** A node of a file: a component, a helper, a `const` initializer, a hook's render function. */
type Located = { node: Node; file: string };

/** A name a file binds that the rule may follow from a reference. */
interface Binding {
  name: string;
  /**
   * `const x = …` (the declarator), `const { x } = useY()` (the declarator), `function x() {}`,
   * or a function's parameter, which shadows outer names and is never followed.
   */
  kind: "const" | "destructure" | "function" | "param";
  node: Node;
  /** The innermost function (or the program) the binding lives in. */
  scope: [number, number];
}

interface FileInfo {
  parsed: ParsedFile;
  /** Local names bound to design exports: local -> exported name. */
  design: Map<string, string>;
  /** Components defined at the top level (function declarations, `const X = (…) =>`), by name. */
  local: Map<string, Node>;
  /** Every top-level function, any case (hooks and helpers an import may name). */
  functions: Map<string, Node>;
  /** Default export's function, when it is one. */
  defaultExport?: Node;
  /** Local names bound to imports from apps/web files: local -> [module path, imported name]. */
  imported: Map<string, [string, string]>;
  /** `export { a as b } from "./x"` / `export * from "./x"` re-exports. */
  reexports: { from: string; name?: string; local?: string }[];
  /** Every `const` / `let` declarator and function declaration, by name, with its scope. */
  bindings: Map<string, Binding[]>;
}

interface Traits {
  /** The boxes it draws (outside portals): inside another box each is a second box. */
  boxed?: string[];
  /** Draws a DataTable (outside portals): inside a non-flush form section it is padded in. */
  table?: boolean;
  /** Props it draws inside one of its boxes (`children`, `aside`, …): prop -> that box. */
  slots?: Record<string, string>;
}

/** A component's props as the scan sees them: destructured locals -> prop, or the props object. */
interface Props {
  aliases: Map<string, string>;
  object?: string;
}

const isCapitalized = (s: string) => /^[A-Z]/.test(s);
const SOURCE_EXTS = [".tsx", ".ts", "/index.tsx", "/index.ts"];
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
/** Keys that hold types or binding patterns, never a reference to follow. */
const SKIP_KEYS = new Set([
  "typeAnnotation",
  "returnType",
  "typeParameters",
  "typeArguments",
  "superTypeParameters",
  "params",
  "id",
  "label",
]);

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

function attributeName(a: Node): string | undefined {
  if (a.type !== "JSXAttribute") return undefined;
  const n = a.name as Node;
  return n.type === "JSXIdentifier" ? (n.name as string) : undefined;
}

/** A JSX attribute's presence and literal truth: `framed`, `framed={true}`, `flush`. */
function attrTrue(n: Node, attr: string): boolean {
  for (const a of ((n.openingElement as Node).attributes as Node[]) ?? []) {
    if (attributeName(a) !== attr) continue;
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

/** The function a variable declarator or declaration holds (memo(…) and forwardRef(…) too). */
function functionOf(n: Node | null | undefined): Node | undefined {
  if (!n) return undefined;
  if (FUNCTIONS.has(n.type)) return n;
  if (n.type === "CallExpression") return functionOf((n.arguments as Node[])[0]);
  return undefined;
}

function keyName(p: Node): string | undefined {
  if (p.computed) return undefined;
  const k = p.key as Node | undefined;
  if (!k) return undefined;
  if (k.type === "Identifier") return k.name as string;
  if (k.type === "Literal" && typeof k.value === "string") return k.value;
  return undefined;
}

function isNode(v: unknown): v is Node {
  return typeof v === "object" && v !== null && typeof (v as Node).type === "string";
}

/** The names a list of binding patterns binds (`a`, `{ b, c: d = 1 }`, `[e, ...f]`). */
function patternNames(patterns: (Node | null)[]): string[] {
  const out: string[] = [];
  const visit = (p: Node | null | undefined) => {
    if (!p) return;
    if (p.type === "Identifier") out.push(p.name as string);
    else if (p.type === "AssignmentPattern") visit(p.left as Node);
    else if (p.type === "RestElement") visit(p.argument as Node);
    else if (p.type === "ArrayPattern")
      for (const e of (p.elements as (Node | null)[]) ?? []) visit(e);
    else if (p.type === "ObjectPattern")
      for (const q of (p.properties as Node[]) ?? [])
        visit(q.type === "Property" ? (q.value as Node) : (q.argument as Node));
    else if (p.type === "TSParameterProperty") visit(p.parameter as Node);
  };
  for (const p of patterns) visit(p);
  return out;
}

/** The props a component's first parameter binds. */
function propsOf(fn: Node): Props {
  const props: Props = { aliases: new Map() };
  const first = ((fn.params as Node[] | undefined) ?? [])[0];
  if (!first) return props;
  if (first.type === "Identifier") props.object = first.name as string;
  if (first.type === "ObjectPattern") {
    for (const p of (first.properties as Node[]) ?? []) {
      if (p.type !== "Property") continue;
      const key = keyName(p);
      let v = p.value as Node;
      if (v.type === "AssignmentPattern") v = v.left as Node;
      if (key !== undefined && v.type === "Identifier") props.aliases.set(v.name as string, key);
    }
  }
  return props;
}

export class BoxReader {
  private files = new Map<string, FileInfo | null>();
  private traits = new Map<string, Traits>();
  private visiting = new Set<string>();
  /** Keys of the traits frames a cycle cut short (`traitsOf` met them while they were open). */
  private cycleHits: string[] = [];
  /** Hook returns being resolved (`file:hook start:key`), so a recursive hook cannot loop. */
  private hooksOpen = new Set<string>();

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
      functions: new Map(),
      imported: new Map(),
      reexports: [],
      bindings: new Map(),
    };
    let deferredDefault: string | undefined;
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
        const fn = functionOf(d);
        if (fn) {
          info.defaultExport = fn;
          const id = d.id as Node | undefined;
          if (id?.name) {
            info.functions.set(id.name as string, fn);
            if (isCapitalized(id.name as string)) info.local.set(id.name as string, fn);
          }
        } else if (d.type === "Identifier") deferredDefault = d.name as string;
        continue;
      }
      const decl = st.type === "ExportNamedDeclaration" ? (st.declaration as Node | null) : st;
      if (decl?.type === "FunctionDeclaration" && decl.id) {
        const name = (decl.id as Node).name as string;
        info.functions.set(name, decl);
        if (isCapitalized(name)) info.local.set(name, decl);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of (decl.declarations as Node[]) ?? []) {
          const id = d.id as Node;
          const fn = functionOf(d.init as Node | null);
          if (id.type !== "Identifier" || !fn) continue;
          info.functions.set(id.name as string, fn);
          if (isCapitalized(id.name as string)) info.local.set(id.name as string, fn);
        }
      }
    }
    if (deferredDefault !== undefined) {
      const found = info.functions.get(deferredDefault);
      if (found) info.defaultExport = found;
    }
    this.collectBindings(info);
    this.files.set(file, info);
    return info;
  }

  /** Every declarator and function declaration of the file, with its innermost function scope. */
  private collectBindings(info: FileInfo): void {
    const add = (b: Binding) => {
      const list = info.bindings.get(b.name) ?? [];
      list.push(b);
      info.bindings.set(b.name, list);
    };
    const program = info.parsed.program;
    const visit = (n: Node, scope: [number, number]) => {
      if (n.type === "VariableDeclarator") {
        const id = n.id as Node;
        if (id.type === "Identifier")
          add({ name: id.name as string, kind: "const", node: n, scope });
        if (id.type === "ObjectPattern")
          for (const p of (id.properties as Node[]) ?? []) {
            const v = p.type === "Property" ? (p.value as Node) : undefined;
            if (v?.type === "Identifier")
              add({ name: v.name as string, kind: "destructure", node: n, scope });
          }
      }
      if (n.type === "FunctionDeclaration" && n.id)
        add({ name: (n.id as Node).name as string, kind: "function", node: n, scope });
      const inner: [number, number] = FUNCTIONS.has(n.type) ? [n.start, n.end] : scope;
      if (FUNCTIONS.has(n.type))
        for (const name of patternNames((n.params as Node[] | undefined) ?? []))
          add({ name, kind: "param", node: n, scope: inner });
      for (const [k, v] of Object.entries(n)) {
        if (k === "type" || k === "start" || k === "end") continue;
        if (Array.isArray(v)) {
          for (const x of v) if (isNode(x)) visit(x, inner);
        } else if (isNode(v)) visit(v, inner);
      }
    };
    visit(program, [program.start, program.end]);
  }

  /** The function an apps/web module exports under `name` (any case), following re-exports. */
  private exported(file: string, name: string, depth = 0): Located | undefined {
    if (depth > 8) return undefined;
    const info = this.info(file);
    if (!info) return undefined;
    if (name === "default")
      return info.defaultExport ? { node: info.defaultExport, file } : undefined;
    const fn = info.functions.get(name);
    if (fn) return { node: fn, file };
    for (const r of info.reexports) {
      if (r.name === undefined) {
        const found = this.exported(r.from, name, depth + 1);
        if (found) return found;
      } else if (r.name === name) return this.exported(r.from, r.local ?? name, depth + 1);
    }
    return undefined;
  }

  /** The component a JSX name in `file` stands for (same file or an apps/web import). */
  componentFor(file: string, name: string): Located | undefined {
    const info = this.info(file);
    if (!info) return undefined;
    const local = info.local.get(name);
    if (local) return { node: local, file };
    const imp = info.imported.get(name);
    if (imp) return this.exported(imp[0], imp[1]);
    return undefined;
  }

  /** The binding of `name` visible at `pos`: the one in the innermost scope holding `pos`. */
  private bindingAt(info: FileInfo, name: string, pos: number): Binding | undefined {
    let best: Binding | undefined;
    for (const b of info.bindings.get(name) ?? []) {
      if (pos < b.scope[0] || pos > b.scope[1]) continue;
      if (!best || b.scope[1] - b.scope[0] < best.scope[1] - best.scope[0]) best = b;
    }
    return best;
  }

  /** A function `name` stands for at `pos` in `file`: a local binding or an import. */
  private functionAt(file: string, info: FileInfo, name: string, pos: number): Located | undefined {
    const b = this.bindingAt(info, name, pos);
    if (b?.kind === "param") return undefined;
    if (b?.kind === "function") return { node: b.node, file };
    if (b?.kind === "const") {
      const fn = functionOf(b.node.init as Node | null);
      return fn ? { node: fn, file } : undefined;
    }
    const imp = info.imported.get(name);
    return imp ? this.exported(imp[0], imp[1]) : undefined;
  }

  /** What a hook returns under `key`: `return { key }` / `return { key: … }` in its own body. */
  private hookReturn(hook: Located, key: string): Located | undefined {
    const info = this.info(hook.file);
    if (!info) return undefined;
    // A hook that returns what it (or a hook it calls) returns under the same key: a cycle with
    // nothing to draw at its end, read as nothing.
    const open = `${hook.file}:${hook.node.start}:${key}`;
    if (this.hooksOpen.has(open)) return undefined;
    this.hooksOpen.add(open);
    try {
      return this.hookReturnOf(hook, info, key);
    } finally {
      this.hooksOpen.delete(open);
    }
  }

  private hookReturnOf(hook: Located, info: FileInfo, key: string): Located | undefined {
    let found: Located | undefined;
    const visit = (n: Node) => {
      if (found) return;
      if (n !== hook.node && FUNCTIONS.has(n.type)) return;
      if (
        n.type === "ReturnStatement" &&
        (n.argument as Node | null)?.type === "ObjectExpression"
      ) {
        for (const p of ((n.argument as Node).properties as Node[]) ?? []) {
          if (p.type !== "Property" || keyName(p) !== key) continue;
          const v = p.value as Node;
          found =
            v.type === "Identifier"
              ? this.renderable(hook.file, info, v.name as string, v.start)
              : { node: v, file: hook.file };
        }
      }
      for (const [k, v] of Object.entries(n)) {
        if (k === "type" || k === "start" || k === "end") continue;
        if (Array.isArray(v)) {
          for (const x of v) if (isNode(x)) visit(x);
        } else if (isNode(v)) visit(v);
      }
    };
    visit(hook.node);
    return found;
  }

  /**
   * What a reference to `name` at `pos` draws, when the rule can follow it: a `const` initializer
   * (a `.map(...)` result too), a lowercase helper function, or a render function a hook returns
   * (`const { editor } = useX()`).
   */
  renderable(file: string, info: FileInfo, name: string, pos: number): Located | undefined {
    const b = this.bindingAt(info, name, pos);
    if (!b || b.kind === "param") return undefined;
    if (b.kind === "function") return isCapitalized(name) ? undefined : { node: b.node, file };
    const init = b.node.init as Node | null;
    if (!init) return undefined;
    if (b.kind === "const") return { node: init, file };
    // `const { editor } = useX(...)`: the hook's returned `editor`.
    if (init.type !== "CallExpression" || (init.callee as Node).type !== "Identifier")
      return undefined;
    let key: string | undefined;
    for (const p of ((b.node.id as Node).properties as Node[]) ?? []) {
      if (p.type === "Property" && (p.value as Node).type === "Identifier")
        if ((p.value as Node).name === name) key = keyName(p);
    }
    if (key === undefined) return undefined;
    const hook = this.functionAt(file, info, (init.callee as Node).name as string, init.start);
    return hook ? this.hookReturn(hook, key) : undefined;
  }

  /** What a node of apps/web draws (memoized; a cycle reads as nothing). */
  traitsOf(c: Located): Traits {
    const key = `${c.file}:${c.node.start}:${c.node.end}`;
    const known = this.traits.get(key);
    if (known) return known;
    if (this.visiting.has(key)) {
      this.cycleHits.push(key);
      return {};
    }
    this.visiting.add(key);
    const hits = this.cycleHits.length;
    const t: Traits = {};
    const info = this.info(c.file);
    const props = FUNCTIONS.has(c.node.type) ? propsOf(c.node) : { aliases: new Map() };
    if (info) this.scan(c.node, info, c.file, null, null, t, props);
    this.visiting.delete(key);
    // Traits read while an outer frame was still open miss what that frame draws: they are not
    // kept, so a later reference from outside the cycle reads them whole.
    const cut = this.cycleHits.slice(hits).some((k) => this.visiting.has(k));
    if (!cut) this.traits.set(key, t);
    if (this.visiting.size === 0) this.cycleHits = [];
    return t;
  }

  /**
   * Walks `root` with the nearest enclosing box (`box`, with whether it is a flush form card) and
   * reports nested boxes to `report`, or collects the root's traits into `traits` (with `props`,
   * the component's own props, to find the ones it draws inside a box).
   */
  scan(
    root: Node,
    info: FileInfo,
    file: string,
    report: ((inner: string, outer: string, at: Node, how: string) => void) | null,
    start: Box,
    traits: Traits | null,
    props: Props = { aliases: new Map() },
  ): void {
    const merge = (t: Traits, portal: boolean) => {
      if (!traits || portal) return;
      if (t.boxed) traits.boxed = [...new Set([...(traits.boxed ?? []), ...t.boxed])];
      if (t.table) traits.table = true;
    };
    /** A followed node (a component, a const, a helper) drawn here, inside `box`. */
    const drawn = (t: Traits, name: string, at: Node, box: Box, portal: boolean) => {
      const second = (t.boxed ?? []).filter((b) => ALLOWED[b]?.outer !== box?.name);
      if (second.length > 0 && box) report?.(name, box.name, at, ` (draws ${second[0]})`);
      if (t.table && box?.name === "FormSection" && !box.flush)
        report?.(name, box.name, at, " (draws a DataTable)");
      merge(t, portal);
    };
    /** A prop of the scanned component drawn inside a box: the component's slot. */
    const slot = (prop: string, box: Box, portal: boolean) => {
      if (!traits || !box || portal) return;
      traits.slots = { ...traits.slots };
      if (traits.slots[prop] === undefined) traits.slots[prop] = box.name;
    };
    const follow = (name: string, at: Node, box: Box, portal: boolean) => {
      const prop = props.aliases.get(name);
      if (prop !== undefined) return slot(prop, box, portal);
      const r = this.renderable(file, info, name, at.start);
      if (r) drawn(this.traitsOf(r), name, at, box, portal);
    };
    const visit = (n: Node, box: Box, portal: boolean) => {
      if (n.type === "JSXElement") return element(n, box, portal);
      if (n.type === "Identifier") {
        if (box !== null || traits !== null) follow(n.name as string, n, box, portal);
        return;
      }
      if (n.type === "MemberExpression") {
        const o = n.object as Node;
        const p = n.property as Node;
        if (
          !n.computed &&
          o.type === "Identifier" &&
          o.name === props.object &&
          p.type === "Identifier"
        )
          return slot(p.name as string, box, portal);
      }
      for (const [k, v] of Object.entries(n)) {
        if (k === "type" || k === "start" || k === "end" || SKIP_KEYS.has(k)) continue;
        if (k === "property" && n.type === "MemberExpression" && !n.computed) continue;
        if (k === "key" && n.type === "Property" && !n.computed) continue;
        walkInto(v, box, portal);
      }
    };
    const element = (n: Node, box: Box, portal: boolean) => {
      const name = elementName(n);
      let next = box;
      let nextPortal = portal;
      let slots: Record<string, string> = {};
      if (name !== undefined) {
        const design = info.design.get(name);
        if (design !== undefined) {
          if (BOXED.has(design)) {
            if (box && ALLOWED[design]?.outer !== box.name) report?.(design, box.name, n, "");
            merge({ boxed: [design] }, portal);
          }
          if (design === "DataTable") {
            if (box?.name === "FormSection" && !box.flush) report?.("DataTable", box.name, n, "");
            merge({ table: true }, portal);
          }
          if (FRAMED.has(design) && box && attrTrue(n, "framed"))
            report?.(design, box.name, n, " (framed)");
          if (OUTER.has(design)) next = { name: design, flush: attrTrue(n, "flush") };
          if (PORTALS.has(design)) {
            nextPortal = true;
            if (!OUTER.has(design)) next = null;
          }
          if (PANES.has(design)) next = null;
        } else if (isCapitalized(name)) {
          const c = this.componentFor(file, name);
          if (c) {
            const t = this.traitsOf(c);
            drawn(t, name, n, box, portal);
            slots = t.slots ?? {};
          }
        }
      }
      // The attributes (render props, `title`, `actions`) are inside the element's box too; a
      // local wrapper's slot prop is inside the box it draws that prop in.
      for (const a of ((n.openingElement as Node).attributes as Node[]) ?? []) {
        const slotBox = slots[attributeName(a) ?? ""];
        walkInto(a, slotBox ? { name: slotBox, flush: false } : next, nextPortal);
      }
      const inner = slots.children ? { name: slots.children, flush: false } : next;
      for (const ch of (n.children as Node[]) ?? []) walkInto(ch, inner, nextPortal);
    };
    const walkInto = (v: unknown, box: Box, portal: boolean) => {
      if (Array.isArray(v)) {
        for (const x of v) walkInto(x, box, portal);
        return;
      }
      if (isNode(v)) visit(v, box, portal);
    };
    visit(root, start, false);
  }
}

/** Every box-in-box finding of apps/web/src (test files aside), bounded by the pending list. */
export function boxFindings(
  webSrcDir: string,
  pending: readonly BoxPending[] = BOX_PENDING,
): Finding[] {
  const reader = new BoxReader(webSrcDir);
  const raw: (Finding & { inner: string })[] = [];
  const seen = new Set<string>();
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
          const line = info.parsed.lineOf(at.start);
          const message = `<${inner}>${how} inside <${outer}>: one box is enough (${SPEC}); use ${FIX[inner] ?? "headings, hairlines and space"} instead`;
          const key = `${file}:${line}:${message}`;
          if (seen.has(key)) return;
          seen.add(key);
          raw.push({ file, line, rule: BOX_RULE, inner, message });
        },
        null,
        null,
      );
    }
  }
  const rel = (f: string) => relative(webSrcDir, f).split(sep).join("/");
  const where = "BOX_PENDING in tools/checks/src/box-in-box.ts";
  const hidden = new Map<BoxPending, Finding[]>();
  const out: Finding[] = [];
  for (const { inner, ...f } of raw) {
    const e = pending.find((p) => p.path === rel(f.file) && p.inner === inner);
    if (e) hidden.set(e, [...(hidden.get(e) ?? []), f]);
    else out.push(f);
  }
  for (const e of pending) {
    const file = join(webSrcDir, ...e.path.split("/"));
    const found = hidden.get(e) ?? [];
    const entry = `"${e.path}" <${e.inner}>`;
    if (found.length > e.max) {
      // The ratchet: past its allowance every finding of the entry is reported.
      for (const f of found)
        out.push({
          ...f,
          message: `${f.message} (pending ${entry} allows ${e.max}, found ${found.length})`,
        });
    } else if (found.length < e.max) {
      out.push({
        file,
        line: 1,
        rule: BOX_STALE_RULE,
        message: !existsSync(file)
          ? `${entry}: the file does not exist; remove the entry from ${where}`
          : found.length === 0
            ? `no box-in-box finding left for ${entry}: remove the entry from ${where} (the list only shrinks)`
            : `${found.length} box-in-box finding(s) left for ${entry}: lower max to ${found.length} in ${where}`,
      });
    }
  }
  return out;
}
