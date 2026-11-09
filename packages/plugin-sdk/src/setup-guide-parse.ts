/**
 * The line scanner and parser of setup guide documents (spec `2026-11-09-setup-guides-v2-design.md`
 * §4.2). A guide is CommonMark + GFM with three line shapes the scanner recognizes in column 0
 * outside fenced code: `::: mode <mode>` / `::: audience <audience>` (open a section), `:::` (close
 * it) and `::check <check-id> <label>`. The scanner keeps line numbers: directive lines become blank
 * lines and each check line becomes a level-6 heading holding a private-use marker, so it is a block
 * of its own and can be found again after parsing.
 */
import type { Nodes, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";
import { SETUP_CHECK_ID_RE } from "./setup-check.js";

/** Limits the parser enforces (equal to the matching entries of `SETUP_GUIDE_LIMITS`). */
const LIMITS = {
  codeBlocks: 24,
  checks: 16,
  sections: 16,
  titleChars: 100,
  checkLabelChars: 80,
  fenceTitleChars: 100,
  depth: 16,
} as const;

/** `{{name}}`, spaces inside the braces allowed. */
export const SETUP_GUIDE_VARIABLE_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;
// The plugin check id is the registration's (`ctx.setup.check`), so a guide can name only ids an
// extension can register; a kernel check is `capybara:` and the same id shape.
const PLUGIN_CHECK_RE = SETUP_CHECK_ID_RE;
const KERNEL_CHECK_RE = new RegExp(`^capybara:${SETUP_CHECK_ID_RE.source.slice(1)}`);
/** The private-use range the renderer reserves for its sentinels; refused in sources. */
export const SETUP_GUIDE_RESERVED_RE = /[-]/;
const FENCE_OPEN_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const SECTION_RE = /^(mode|audience)[ \t]+(\S+)$/;
const CHECK_LINE_RE = /^::check[ \t]+(\S+)(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_TITLE_RE = /^title="([^"]*)"$/;

/** Variable sentinel: `<n>`, n indexing the occurrences. */
export const SENTINEL_RE = /(\d+)/g;
/** The same sentinel percent-encoded, as micromark leaves it in a link destination. */
export const ENCODED_SENTINEL_RE = /%EE%80%80(\d+)%EE%80%81/gi;
const CHECK_MARKER_RE = /^(\d+)$/;

/** One issue of a document, with the 1-based source line when it has one. */
export interface SetupGuideParseIssue {
  level: "error" | "warning";
  line?: number;
  message: string;
}

/** A `::: mode` / `::: audience` section of a document. */
export interface SetupGuideSection {
  type: "mode" | "audience";
  value: string;
  /** Line of the opening directive. */
  line: number;
  /** Index of the enclosing section, or null. */
  parent: number | null;
}

/** A `::check` line of a document. */
export interface SetupGuideCheckLine {
  id: string;
  label: string;
  source: "plugin" | "kernel";
  line: number;
  /** Index of the innermost enclosing section, or null. */
  section: number | null;
}

/** A fenced code block of a document. */
export interface SetupGuideCodeBlock {
  /** The info string's first word; empty when missing. */
  language: string;
  title: string | null;
  text: string;
  line: number;
  /** Index of the innermost enclosing section, or null. */
  section: number | null;
}

/** The structure of a document (see {@link parseSetupGuide}). */
export interface ParsedSetupGuide {
  /** The level-1 heading the document starts with, or null when it does not. */
  title: string | null;
  sections: SetupGuideSection[];
  checks: SetupGuideCheckLine[];
  codeBlocks: SetupGuideCodeBlock[];
  /** Structural problems (place independent: modes, audiences and variables are not judged). */
  issues: SetupGuideParseIssue[];
}

type LineKind = "text" | "fence" | "section-open" | "section-close" | "check";

/** @internal The scanner's result. */
export interface GuideScan {
  lines: string[];
  kinds: LineKind[];
  /** The enclosing sections of each line, outermost first. */
  stacks: number[][];
  /** Check index of each check line. */
  checkAt: Map<number, number>;
  sections: SetupGuideSection[];
  checks: SetupGuideCheckLine[];
  issues: SetupGuideParseIssue[];
}

/** LF line endings. */
export function normalizeGuideSource(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

/** @internal Classifies the lines of a (normalized) document. */
export function scanGuide(source: string): GuideScan {
  const lines = source.split("\n");
  const kinds: LineKind[] = [];
  const stacks: number[][] = [];
  const checkAt = new Map<number, number>();
  const sections: SetupGuideSection[] = [];
  const checks: SetupGuideCheckLine[] = [];
  const issues: SetupGuideParseIssue[] = [];
  const err = (line: number, message: string) => issues.push({ level: "error", line, message });
  const stack: number[] = [];
  let fence: { char: string; len: number } | null = null;
  lines.forEach((text, i) => {
    const line = i + 1;
    stacks.push([...stack]);
    if (fence !== null) {
      kinds.push("fence");
      const c = FENCE_CLOSE_RE.exec(text);
      if (
        c !== null &&
        (c[1] as string)[0] === fence.char &&
        (c[1] as string).length >= fence.len
      ) {
        fence = null;
      }
      return;
    }
    const f = FENCE_OPEN_RE.exec(text);
    if (f !== null) {
      const seq = f[2] as string;
      if (!(seq[0] === "`" && (f[3] as string).includes("`"))) {
        kinds.push("fence");
        fence = { char: seq[0] as string, len: seq.length };
        return;
      }
    }
    if (text.startsWith(":::")) {
      const rest = text.slice(3).trim();
      if (rest === "") {
        const open = stack.pop();
        if (open === undefined) {
          err(line, "`:::` closes no section");
          kinds.push("text");
        } else kinds.push("section-close");
        return;
      }
      const m = SECTION_RE.exec(rest);
      if (m === null) {
        err(
          line,
          `"${text}" is not a section line; use "::: mode <mode>", "::: audience <audience>" or ":::"`,
        );
        kinds.push("text");
        return;
      }
      if (text.includes("{{")) err(line, "directive lines hold no variables");
      const type = m[1] as "mode" | "audience";
      const parentIndex = stack.at(-1);
      if (parentIndex !== undefined) {
        const parent = sections[parentIndex] as SetupGuideSection;
        if (!(stack.length === 1 && parent.type === "audience" && type === "mode")) {
          err(
            line,
            `sections do not nest (only a mode section inside an audience section); close the section of line ${parent.line} first`,
          );
        }
      }
      sections.push({ type, value: m[2] as string, line, parent: parentIndex ?? null });
      stack.push(sections.length - 1);
      kinds.push("section-open");
      return;
    }
    if (/^::check(?:\s|$)/.test(text)) {
      const m = CHECK_LINE_RE.exec(text);
      if (m === null) {
        err(line, "a check line is `::check <check-id> <label>`");
        kinds.push("text");
        return;
      }
      const id = m[1] as string;
      const label = (m[2] ?? "").trim();
      if (!PLUGIN_CHECK_RE.test(id) && !KERNEL_CHECK_RE.test(id)) {
        err(
          line,
          `check id "${id}" must match ^[a-z0-9][a-z0-9-]{0,47}$ (a plugin check) or capybara:<id> (a kernel check)`,
        );
      }
      if (label === "") err(line, `check ${id} needs a label: \`::check ${id} <label>\``);
      else if ([...label].length > LIMITS.checkLabelChars) {
        err(line, `the label of check ${id} is longer than ${LIMITS.checkLabelChars} characters`);
      }
      if (text.includes("{{"))
        err(line, "directive lines hold no variables (check labels are plain text)");
      checks.push({
        id,
        label,
        source: id.startsWith("capybara:") ? "kernel" : "plugin",
        line,
        section: stack.at(-1) ?? null,
      });
      checkAt.set(i, checks.length - 1);
      kinds.push("check");
      return;
    }
    kinds.push("text");
  });
  for (const open of stack) {
    const s = sections[open] as SetupGuideSection;
    err(s.line, `the section "::: ${s.type} ${s.value}" opened at line ${s.line} is not closed`);
  }
  return { lines, kinds, stacks, checkAt, sections, checks, issues };
}

/** @internal Whether line `i` is in the sections of `mode` and `audience`. */
export function lineSelected(
  scan: GuideScan,
  i: number,
  mode: string | null,
  audience: string | null,
): boolean {
  for (const s of scan.stacks[i] as number[]) {
    const sec = scan.sections[s] as SetupGuideSection;
    if (sec.type === "mode" ? sec.value !== mode : sec.value !== audience) return false;
  }
  return true;
}

/**
 * @internal The Markdown the parser sees, line for line: unselected and directive lines blank, check
 * lines as marker headings, other lines through `subst`.
 */
export function preparedGuideText(
  scan: GuideScan,
  include: (i: number) => boolean,
  subst: (text: string, i: number) => string = (t) => t,
): string {
  return scan.lines
    .map((text, i) => {
      if (!include(i)) return "";
      const kind = scan.kinds[i];
      if (kind === "section-open" || kind === "section-close") return "";
      if (kind === "check") return `###### ${scan.checkAt.get(i)}`;
      return subst(text, i);
    })
    .join("\n");
}

/** @internal Parses Markdown (CommonMark + GFM) to mdast. */
export function parseGuideMarkdown(text: string): Root {
  return fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
}

/** @internal The check index of a marker heading, or undefined. */
export function checkMarkerIndex(node: Nodes): number | undefined {
  if (node.type !== "heading" || node.depth !== 6 || node.children.length !== 1) return undefined;
  const t = node.children[0];
  if (t?.type !== "text") return undefined;
  const m = CHECK_MARKER_RE.exec(t.value);
  return m === null ? undefined : Number(m[1]);
}

/** @internal The plain text of a node (values and image alts, joined). */
export function nodeText(node: Nodes): string {
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if ("children" in node) return (node.children as Nodes[]).map(nodeText).join("");
  return "";
}

/** @internal Visits nodes depth first in document order, with their depth (root's children = 1). */
export function visitGuide(
  node: Nodes,
  fn: (node: Nodes, depth: number, parent: Nodes | null) => void,
  depth = 0,
  parent: Nodes | null = null,
): void {
  if (depth > 0) fn(node, depth, parent);
  if ("children" in node) {
    for (const c of node.children as Nodes[]) visitGuide(c, fn, depth + 1, node);
  }
}

/** @internal The title of a fence info string's meta: `{ title }`, or `{ bad }` for other text. */
export function fenceTitle(meta: string | null | undefined): {
  title: string | null;
  bad?: string;
} {
  if (meta === null || meta === undefined || meta.trim() === "") return { title: null };
  const m = FENCE_TITLE_RE.exec(meta.trim());
  return m === null ? { title: null, bad: meta.trim() } : { title: m[1] as string };
}

/** @internal A variable occurrence the analysis replaced by a sentinel. */
export interface GuideVariableUse {
  name: string;
  line: number;
}

/** @internal Everything validation needs: the scan, the sentinel tree of all sections, the uses. */
export interface GuideAnalysis {
  parsed: ParsedSetupGuide;
  scan: GuideScan;
  tree: Root;
  uses: GuideVariableUse[];
}

/** @internal Replaces the sentinels (plain or percent-encoded) of `s` with `{{name}}`. */
export function revertSentinels(s: string, names: readonly string[]): string {
  const back = (whole: string, n: string) => {
    const name = names[Number(n)];
    return name === undefined ? whole : `{{${name}}}`;
  };
  return s.replace(SENTINEL_RE, back).replace(ENCODED_SENTINEL_RE, back);
}

/** @internal Scans and parses a document with every section and every variable as a sentinel. */
export function analyzeSetupGuide(source: string): GuideAnalysis {
  const src = normalizeGuideSource(source);
  const scan = scanGuide(src);
  const issues: SetupGuideParseIssue[] = [...scan.issues];
  const err = (line: number | undefined, message: string) =>
    issues.push({ level: "error", ...(line !== undefined && { line }), message });
  scan.lines.forEach((text, i) => {
    if (text.includes("\u0000")) err(i + 1, "the document contains NUL");
    if (SETUP_GUIDE_RESERVED_RE.test(text)) {
      err(
        i + 1,
        "the document contains a private-use character (U+E000–U+E0FF), which guides may not use",
      );
    }
  });
  const uses: GuideVariableUse[] = [];
  const text = preparedGuideText(
    scan,
    () => true,
    (t, i) =>
      t.replace(SETUP_GUIDE_VARIABLE_RE, (_w, name: string) => {
        uses.push({ name, line: i + 1 });
        return `${uses.length - 1}`;
      }),
  );
  const names = uses.map((u) => u.name);
  const tree = parseGuideMarkdown(text);
  const lineOf = (n: Nodes) => n.position?.start.line;
  const sectionOf = (line: number | undefined) =>
    line === undefined ? null : (scan.stacks[line - 1]?.at(-1) ?? null);

  // the title
  let title: string | null = null;
  const firstLine = scan.lines.findIndex((l) => l.trim() !== "");
  const first = tree.children[0];
  if (
    first?.type === "heading" &&
    first.depth === 1 &&
    lineOf(first) === firstLine + 1 &&
    /^ {0,3}#(?:[ \t]|$)/.test(scan.lines[firstLine] ?? "")
  ) {
    title = revertSentinels(nodeText(first), names).trim();
    if (title === "") err(lineOf(first), "the title (the level-1 heading) is empty");
    if ([...title].length > LIMITS.titleChars) {
      err(lineOf(first), `the title is longer than ${LIMITS.titleChars} characters`);
    }
  } else {
    err(
      firstLine >= 0 ? firstLine + 1 : 1,
      "the document must start with a level-1 heading (# Title)",
    );
  }

  const codeBlocks: SetupGuideCodeBlock[] = [];
  let deepest = 0;
  let deepLine: number | undefined;
  visitGuide(tree, (node, depth) => {
    if (depth > deepest) {
      deepest = depth;
      deepLine = lineOf(node);
    }
    const line = lineOf(node);
    if (node.type === "heading") {
      if (checkMarkerIndex(node) !== undefined) return;
      if (node === first && title !== null) return;
      if (node.depth === 1) {
        err(line, "only the title may be a level-1 heading; use ## to #### for the structure");
      } else if (node.depth > 4) {
        err(line, "headings go from ## to ####");
      }
      if ([...revertSentinels(nodeText(node), names).trim()].length > LIMITS.titleChars) {
        err(line, `a heading is longer than ${LIMITS.titleChars} characters`);
      }
      return;
    }
    if (node.type !== "code") return;
    const start = node.position?.start.offset ?? 0;
    const fenced = /^[ \t]*(?:```|~~~)/.test(text.slice(start, start + 64));
    if (!fenced) {
      err(line, "indented code is not allowed; use a fenced code block with a language");
      return;
    }
    const lang = node.lang ?? "";
    const meta = node.meta ?? "";
    if (/\d+/.test(lang + meta)) {
      err(line, "variables are not allowed in a fence info string");
    }
    if (lang === "") err(line, "a code block needs a language (```yaml, ```json, ```sh, ...)");
    const t = fenceTitle(revertSentinels(meta, names));
    if (t.bad !== undefined) {
      err(
        line,
        `unexpected text in the info string ("${t.bad}"); only title="…" may follow the language`,
      );
    }
    if (t.title !== null && [...t.title].length > LIMITS.fenceTitleChars) {
      err(line, `a code block title is longer than ${LIMITS.fenceTitleChars} characters`);
    }
    codeBlocks.push({
      language: revertSentinels(lang, names),
      title: t.title,
      text: revertSentinels(node.value, names),
      line: line ?? 0,
      section: sectionOf(line),
    });
  });
  // a check line swallowed by an HTML block is no block of its own: its row would be missing
  const placed = new Set<number>();
  for (const n of tree.children) {
    const c = checkMarkerIndex(n);
    if (c !== undefined) placed.add(c);
  }
  scan.checks.forEach((c, i) => {
    if (!placed.has(i)) {
      err(
        c.line,
        `check ${c.id} is inside raw HTML and would not show; end the HTML with a blank line before the check line`,
      );
    }
  });
  if (deepest > LIMITS.depth) err(deepLine, `content is nested deeper than ${LIMITS.depth} levels`);
  if (codeBlocks.length > LIMITS.codeBlocks) {
    err(
      undefined,
      `the document has ${codeBlocks.length} code blocks; at most ${LIMITS.codeBlocks}`,
    );
  }
  if (scan.checks.length > LIMITS.checks) {
    err(undefined, `the document has ${scan.checks.length} check lines; at most ${LIMITS.checks}`);
  }
  if (scan.sections.length > LIMITS.sections) {
    err(undefined, `the document has ${scan.sections.length} sections; at most ${LIMITS.sections}`);
  }
  issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  return {
    parsed: { title, sections: scan.sections, checks: scan.checks, codeBlocks, issues },
    scan,
    tree,
    uses,
  };
}

/**
 * Parses a setup guide document into its title, sections, check lines and fenced code blocks, with
 * the structural problems found (missing title, nesting, malformed directive lines, indented code,
 * fence info strings, limits). Place-dependent rules are `validateSetupGuide`'s. Pure.
 */
export function parseSetupGuide(source: string): ParsedSetupGuide {
  return analyzeSetupGuide(source).parsed;
}
