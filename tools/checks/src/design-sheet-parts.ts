import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { type Finding, isParseError, listSourceFiles, type Node, parseFile } from "./source.js";

/**
 * `design-sheet-parts` (mobile interaction model spec §9): a bottom sheet's rows are drawn by the
 * sheet parts (`SheetGroup`, `SheetRow`, `SheetOptionList`, `SheetFootnote`), so every sheet gets
 * the same row height, separators and press state. The scan covers the non-test files of
 * `packages/design/src`: a raw `<button>`, `<a>` or `<li>` anywhere inside the children of a
 * `<BottomSheet>` or `<BottomSheetContent>` fails, except in `overlays/sheet-parts.tsx` and
 * `overlays/bottom-sheet.tsx`, which draw the parts themselves. A control inside a design
 * component (a `Button`, a `Select`) is that component's business and is not seen.
 */
export const SHEET_PARTS_RULE = "design-sheet-parts";
export const SHEET_PARTS_STALE_RULE = "design-sheet-parts-stale-pending";

/** The files that draw the parts. */
export const SHEET_PARTS_FILES = ["overlays/sheet-parts.tsx", "overlays/bottom-sheet.tsx"];

const SHEETS = new Set(["BottomSheet", "BottomSheetContent"]);
const RAW_ROWS = new Set(["button", "a", "li"]);

/** Today's raw rows, a ratchet like `DUAL_RENDER_PENDING`; new code adds no entry. */
export interface SheetPartsPending {
  /** Under packages/design/src, `/`-separated. */
  path: string;
  /** How many raw rows the file may still draw. */
  max: number;
  /** The task that moves them onto the parts. */
  fix: string;
}

export const SHEET_PARTS_PENDING: readonly SheetPartsPending[] = [];

function openingName(el: Node): string | undefined {
  const name = (el.openingElement as Node).name as Node;
  return name.type === "JSXIdentifier" ? (name.name as string) : undefined;
}

/** Every raw row inside the children of a sheet element of one parsed file. */
export function sheetPartsFindings(file: string, program: Node, lineOf: (o: number) => number) {
  const out: Finding[] = [];
  const seen = new Set<number>();
  const scan = (n: unknown, inSheet: boolean): void => {
    if (typeof n !== "object" || n === null) return;
    if (Array.isArray(n)) {
      for (const x of n) scan(x, inSheet);
      return;
    }
    const node = n as Node;
    const inside = inSheet;
    if (node.type === "JSXElement") {
      const name = openingName(node);
      if (inSheet && name && RAW_ROWS.has(name) && !seen.has(node.start)) {
        seen.add(node.start);
        out.push({
          file,
          line: lineOf(node.start),
          rule: SHEET_PARTS_RULE,
          message: `raw <${name}> row in a bottom sheet: a sheet's rows are SheetRow / SheetOptionList inside a SheetGroup (overlays/sheet-parts.tsx), so rows share one height, separator and press state`,
        });
      }
      if (name && SHEETS.has(name)) {
        // the sheet's own attributes are not its body; only its children are
        scan(node.children, true);
        scan(node.openingElement, inSheet);
        return;
      }
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === "type" || k === "start" || k === "end") continue;
      scan(v, inside);
    }
  };
  scan(program, false);
  return out;
}

/** The rule over `packages/design/src`, with the ratchet. */
export function sheetPartsTreeFindings(
  designSrcDir: string,
  pending: readonly SheetPartsPending[] = SHEET_PARTS_PENDING,
): Finding[] {
  const rel = (f: string) => relative(designSrcDir, f).split(sep).join("/");
  const raw: Finding[] = [];
  for (const { file, isTest } of listSourceFiles(designSrcDir)) {
    if (isTest || SHEET_PARTS_FILES.includes(rel(file))) continue;
    const p = parseFile(file);
    if (isParseError(p)) raw.push(p);
    else raw.push(...sheetPartsFindings(file, p.program, p.lineOf));
  }
  const where = "SHEET_PARTS_PENDING in tools/checks/src/design-sheet-parts.ts";
  const hidden = new Map<SheetPartsPending, Finding[]>();
  const out: Finding[] = [];
  for (const f of raw) {
    const e = pending.find((p) => p.path === rel(f.file));
    if (e) hidden.set(e, [...(hidden.get(e) ?? []), f]);
    else out.push(f);
  }
  for (const e of pending) {
    const file = join(designSrcDir, ...e.path.split("/"));
    const found = hidden.get(e) ?? [];
    if (!existsSync(file)) {
      out.push({
        file,
        line: 1,
        rule: SHEET_PARTS_STALE_RULE,
        message: `"${e.path}": the file does not exist; remove the entry from ${where}`,
      });
    } else if (found.length === 0) {
      out.push({
        file,
        line: 1,
        rule: SHEET_PARTS_STALE_RULE,
        message: `no raw sheet row left in "${e.path}": remove the entry from ${where} (the list only shrinks)`,
      });
    } else if (found.length > e.max) {
      out.push(...found);
    } else if (found.length < e.max) {
      out.push({
        file,
        line: 1,
        rule: SHEET_PARTS_STALE_RULE,
        message: `${found.length} raw sheet row(s) left in "${e.path}", the entry allows ${e.max}: lower max in ${where} (the list only shrinks)`,
      });
    }
  }
  return out;
}
