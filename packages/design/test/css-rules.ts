import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** The source of one stylesheet of the design package. */
export const css = (f: string) =>
  readFileSync(resolve(import.meta.dirname, "../src/styles", f), "utf8");

export type CssRule = { at: string | null; selector: string; decls: Record<string, string> };

/**
 * The style rules of a stylesheet with the at-rule (`@media` / `@container` condition) they sit in,
 * one nesting level: `at` is e.g. `(max-width: 599px)` or `cb-body (max-width: 791px)`.
 */
export function parseCss(source: string): CssRule[] {
  const text = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: CssRule[] = [];
  const block = (from: number): number => {
    let depth = 0;
    for (let i = from; i < text.length; i++) {
      if (text[i] === "{") depth++;
      if (text[i] === "}" && --depth === 0) return i;
    }
    return text.length;
  };
  const rules = (chunk: string, scope: string | null) => {
    for (const m of chunk.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const decls: Record<string, string> = {};
      for (const d of (m[2] ?? "").split(";")) {
        const colon = d.indexOf(":");
        if (colon > 0)
          decls[d.slice(0, colon).trim()] = d
            .slice(colon + 1)
            .replace(/\s+/g, " ")
            .trim();
      }
      out.push({ at: scope, selector: (m[1] ?? "").replace(/\s+/g, " ").trim(), decls });
    }
  };
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    if (head.startsWith("@media") || head.startsWith("@container")) {
      const end = block(open);
      rules(text.slice(open + 1, end), head.replace(/^@(media|container)\s+/, ""));
      i = end + 1;
    } else if (head.startsWith("@")) {
      i = block(open) + 1;
    } else {
      const end = block(open);
      rules(text.slice(i, end + 1), null);
      i = end + 1;
    }
  }
  return out;
}

/** Hidden by a base rule: transparent, invisible or not displayed. */
const hides = (d: Record<string, string>) =>
  d.opacity === "0" || d.visibility === "hidden" || d.display === "none";
/** Shown by a rule: opaque, visible or displayed. */
const reveals = (d: Record<string, string>) =>
  d.opacity === "1" ||
  d.visibility === "visible" ||
  (d.display !== undefined && d.display !== "none");
/** The last compound selector of `selector` (`.a:hover .b > .c` → `.c`). */
const lastCompound = (selector: string) => selector.split(/\s*[\s>+~]\s*/).at(-1) ?? selector;

/**
 * Actions only a pointer hover reveals, from the stylesheets alone (mobile layout spec §11.3 "no
 * action reachable only by hover"): a rule `A:hover B { opacity: 1 | visibility: visible |
 * display: … }` whose B a base rule hides, with no `@media (hover: none)` rule showing B. Returns
 * the offending hover selectors.
 */
export function findHoverOnlyRules(rules: CssRule[]): string[] {
  const selectorsOf = (r: CssRule) => r.selector.split(",").map((s) => s.trim());
  const hiddenBy = (target: string) =>
    rules.some(
      (r) =>
        r.at === null &&
        hides(r.decls) &&
        selectorsOf(r).some(
          (s) => !s.includes(":hover") && (s === target || s === lastCompound(target)),
        ),
    );
  const touchShows = (target: string) =>
    rules.some(
      (r) =>
        r.at !== null &&
        /\bhover:\s*none\b/.test(r.at) &&
        reveals(r.decls) &&
        selectorsOf(r).some((s) => lastCompound(s) === lastCompound(target)),
    );
  const out: string[] = [];
  for (const r of rules) {
    if (r.at !== null && /\bhover:\s*none\b/.test(r.at)) continue;
    if (!reveals(r.decls)) continue;
    for (const s of selectorsOf(r)) {
      const m = /:hover[^\s>+~]*(?:\s*[>+~]\s*|\s+)(\S.*)$/.exec(s);
      const target = m?.[1]?.trim();
      if (!target || target.includes(":hover")) continue;
      if (hiddenBy(target) && !touchShows(target)) out.push(s);
    }
  }
  return out;
}
