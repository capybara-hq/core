import { THEME_CONTRAST, THEME_SEPARATION } from "./theme-tokens.generated.js";

export type ThemeScheme = "dark" | "light";

/** A theme scheme after merging its overrides onto the built-in values. */
export type MergedScheme = {
  color: Record<string, string>;
  shadow: Record<string, string>;
  radius: Record<string, number>;
};

export type ReadabilityIssue = {
  kind: "contrast" | "separation" | "separation-order" | "unevaluable";
  /** `<fg> on <bg>` (with ` over <surface>` for a surface pair) or `<ground> on <surface>`. */
  pair: string;
  /** The measured value: contrast ratio, or OKLab lightness difference x100. */
  ratio: number;
  /** The floor it had to reach (for `separation-order`: the hover difference selected must beat). */
  floor: number;
  /** The composited colors compared, or for `unevaluable` the offending value. */
  detail?: string;
};

const HEX_RE = /^#[0-9A-F]{6}$/;
const LOOSE_HEX_RE = /^#[0-9A-Fa-f]{6}$/;
const RGBA_PARTS_RE = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0|1|0?\.\d+)\)$/;

function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (ch[0] as number) + 0.7152 * (ch[1] as number) + 0.0722 * (ch[2] as number);
}

/** WCAG 2 contrast ratio of two #RRGGBB colors. */
export function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return ((hi as number) + 0.05) / ((lo as number) + 0.05);
}

/** OKLab lightness (x100) of a #RRGGBB color. */
export function oklabL(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return (0.2104542553 * l + 0.793617785 * m - 0.0040720958 * s) * 100;
}

/**
 * The opaque #RRGGBB of `color` drawn over the opaque `ground`: a hex color passes through, an
 * rgba(...) color is alpha-blended (per channel, rounded), anything else (color-mix) is undefined.
 */
export function compositeOver(color: string, ground: string): string | undefined {
  if (HEX_RE.test(color)) return color;
  const m = RGBA_PARTS_RE.exec(color);
  if (!m || !HEX_RE.test(ground)) return undefined;
  const a = Number(m[4]);
  const hex = [1, 2, 3]
    .map((i) => {
      const fg = Number(m[i]);
      const bg = Number.parseInt(ground.slice(2 * i - 1, 2 * i + 1), 16);
      return Math.round(fg * a + bg * (1 - a))
        .toString(16)
        .padStart(2, "0");
    })
    .join("");
  return `#${hex.toUpperCase()}`;
}

/**
 * Evaluates the readability rules (every contrast pair and separation entry of the design tokens)
 * on one merged scheme. An rgba(...) value is composited over the scheme's `bg` first, or over a
 * pair's surface token; pairs with a color-mix value are skipped. `selected` must stand further
 * from a surface than `hover` on the same surface. `rules` defaults to the built-in lists.
 */
export function checkThemeReadability(
  _scheme: ThemeScheme,
  merged: MergedScheme,
  rules: {
    contrast: readonly (readonly [string, string, number, string?])[];
    separation: readonly (readonly [string, string, number])[];
  } = { contrast: THEME_CONTRAST, separation: THEME_SEPARATION },
): ReadabilityIssue[] {
  const issues: ReadabilityIssue[] = [];
  // Hex case is not significant in CSS: evaluate `#rrggbb` like `#RRGGBB`.
  const color: Record<string, string> = Object.fromEntries(
    Object.entries(merged.color).map(([n, v]) => [n, LOOSE_HEX_RE.test(v) ? v.toUpperCase() : v]),
  );
  const bg = color.bg ?? "";
  // A value the rules read that cannot be evaluated is reported, never silently skipped. A
  // color-mix value is legitimate (it derives) and is skipped; `bg` must be a plain hex ground.
  const used = new Set<string>(["bg"]);
  for (const [fg, back, , surface] of rules.contrast) {
    for (const n of [fg, back, surface]) if (n !== undefined) used.add(n);
  }
  for (const [ground, surface] of rules.separation) {
    used.add(ground);
    used.add(surface);
  }
  for (const name of used) {
    const v = color[name];
    if (v === undefined || v.startsWith("color-mix(")) continue;
    const ok = name === "bg" ? HEX_RE.test(v) : HEX_RE.test(v) || RGBA_PARTS_RE.test(v);
    if (!ok) {
      issues.push({ kind: "unevaluable", pair: name, ratio: Number.NaN, floor: 0, detail: v });
    }
  }
  /** The opaque value of a surface token: an rgba surface is composited over `bg`. */
  const surfaceOf = (name: string): string | undefined => {
    const raw = color[name];
    return raw === undefined ? undefined : compositeOver(raw, bg);
  };

  for (const [fg, back, floor, surface] of rules.contrast) {
    const ground = surfaceOf(surface ?? "bg");
    if (ground === undefined) continue;
    const rawA = color[fg];
    const rawB = color[back];
    if (rawA === undefined || rawB === undefined) continue;
    const a = compositeOver(rawA, ground);
    const b = compositeOver(rawB, ground);
    if (a === undefined || b === undefined) continue;
    const ratio = contrastRatio(a, b);
    if (ratio + 1e-9 < floor) {
      const composited =
        a !== rawA || b !== rawB ? ` (rgba composited over ${surface ?? "bg"})` : "";
      issues.push({
        kind: "contrast",
        pair: `${fg} on ${back}${surface === undefined ? "" : ` over ${surface}`}`,
        ratio,
        floor,
        detail: `${a} on ${b}${composited}`,
      });
    }
  }

  const delta = new Map<string, number>();
  for (const [ground, surface, floor] of rules.separation) {
    const s = surfaceOf(surface);
    const raw = color[ground];
    const g = s === undefined || raw === undefined ? undefined : compositeOver(raw, s);
    if (s === undefined || g === undefined) continue;
    const d = Math.abs(oklabL(g) - oklabL(s));
    delta.set(`${ground}@${surface}`, d);
    if (d + 1e-9 < floor) {
      issues.push({
        kind: "separation",
        pair: `${ground} on ${surface}`,
        ratio: d,
        floor,
        detail: `${g} on ${s}`,
      });
    }
  }
  for (const [k, hover] of delta) {
    if (!k.startsWith("hover@")) continue;
    const surface = k.slice("hover@".length);
    const selected = delta.get(`selected@${surface}`);
    if (selected !== undefined && selected <= hover) {
      issues.push({
        kind: "separation-order",
        pair: `selected on ${surface}`,
        ratio: selected,
        floor: hover,
      });
    }
  }
  return issues;
}
