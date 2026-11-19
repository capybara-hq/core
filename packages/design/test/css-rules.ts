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
