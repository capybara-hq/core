import type { Finding } from "./source.js";

export const BREAKPOINT_RULE = "design-breakpoint";

/**
 * The only widths a media query of the design CSS may use (mobile layout spec §3.1, §3.3): the
 * size classes' 599 / 600 / 840 / 841 and the right area's fit threshold 1279 / 1280. The one
 * list; `shell/size-class.ts` exports the same queries.
 */
export const ALLOWED_WIDTHS = ["599px", "600px", "840px", "841px", "1279px", "1280px"] as const;
/** The short window (height below 480, spec §4.7). */
export const ALLOWED_HEIGHTS = ["479px"] as const;

/**
 * The viewport segment media features (mobile layout spec §8): only the two-segment form, which is
 * the one a foldable reports; any other count is not a layout the design has.
 */
export const ALLOWED_SEGMENT_COUNTS = ["2"] as const;
const SEGMENTS = /\b(horizontal|vertical)-viewport-segments\s*:\s*([^\s)]*)/gi;

const FEATURE = /\b(min|max)-(width|height)\s*:\s*([\d.]+[a-z%]*)/gi;
const MEDIA = /@media\b([^{]*)\{/gi;
const VH = /\b100vh\b/;

/**
 * `design-breakpoint`: a width or height media query in the design CSS uses only the class widths,
 * 1279 / 1280 and the short window's height, and no box is `100vh` high (use `100dvh`, which
 * follows the visible window on a phone). Container queries are not media queries and are not
 * covered. `css` has its comments stripped (line numbers kept).
 */
export function breakpointFindings(file: string, css: string): Finding[] {
  const out: Finding[] = [];
  const lineAt = (offset: number) => css.slice(0, offset).split("\n").length;
  for (const m of css.matchAll(MEDIA)) {
    const start = (m.index ?? 0) + "@media".length;
    for (const f of (m[1] ?? "").matchAll(SEGMENTS)) {
      if ((ALLOWED_SEGMENT_COUNTS as readonly string[]).includes(f[2] ?? "")) continue;
      out.push({
        file,
        line: lineAt(start + (f.index ?? 0)),
        rule: BREAKPOINT_RULE,
        message: `${f[1]}-viewport-segments: ${f[2]} is not a segment query of the design system; only (horizontal-viewport-segments: 2) and (vertical-viewport-segments: 2) are allowed (spec §8)`,
      });
    }
    for (const f of (m[1] ?? "").matchAll(FEATURE)) {
      const dimension = f[2]?.toLowerCase();
      const value = (f[3] ?? "").toLowerCase();
      const allowed: readonly string[] = dimension === "width" ? ALLOWED_WIDTHS : ALLOWED_HEIGHTS;
      if (allowed.includes(value)) continue;
      out.push({
        file,
        line: lineAt(start + (f.index ?? 0)),
        rule: BREAKPOINT_RULE,
        message: `${f[1]}-${dimension}: ${value} is not a breakpoint of the design system; use the size classes' 599px / 600px / 840px / 841px, 1279px / 1280px for the right area${dimension === "height" ? " or the short window's max-height: 479px" : ""}, or a container query for a component's own fit (spec §4)`,
      });
    }
  }
  css.split("\n").forEach((text, i) => {
    if (VH.test(text)) {
      out.push({
        file,
        line: i + 1,
        rule: BREAKPOINT_RULE,
        message:
          "100vh is the largest window height (it ignores a phone's browser bars); use 100dvh (spec §4.7)",
      });
    }
  });
  return out.sort((a, b) => a.line - b.line);
}
