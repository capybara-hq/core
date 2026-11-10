// A theme version's stylesheet (themes spec §8), rendered from the stored, parsed theme. The
// definition was validated at import, but it is read back from a database row: every value is
// checked again here with the SDK's grammars before it is written into CSS, so a changed row cannot
// inject CSS. A value that fails is left out and reported.
import {
  canonicalThemeValue,
  isThemeAssetPath,
  isThemeFontFamily,
  type ParsedTheme,
  THEME_FONTS,
  THEME_OVERRIDABLE,
  THEME_TOKENS,
  type ThemeScheme,
} from "@capybara-hq/plugin-sdk";

const SCHEMES: readonly ThemeScheme[] = ["dark", "light"];
const GROUPS = ["color", "shadow"] as const;
const OVERRIDABLE = {
  color: new Set<string>(THEME_OVERRIDABLE.color),
  shadow: new Set<string>(THEME_OVERRIDABLE.shadow),
  radius: new Set<string>(THEME_OVERRIDABLE.radius),
};
/** The CSS variable of a stored token name (the design's `tokens.css` names). */
const VARIABLE = {
  color: (n: string) => `--cb-${n}`,
  shadow: (n: string) => `--cb-${n}`,
  radius: (n: string) => `--cb-radius-${n}`,
};
/** The CSS variable of each font role's stack. */
const STACK_VARIABLE = { mono: "--cb-font", prose: "--cb-font-prose" } as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * One scheme's declarations: the stored overrides that pass their checks, keyed by variable.
 * `full`: start from every built-in value of `scheme` (a single-scheme theme writes the whole
 * scheme, so the other selector draws it too); a skipped override then keeps the built-in value.
 */
function schemeDeclarations(
  theme: ParsedTheme,
  scheme: ThemeScheme,
  full: boolean,
  skip: (path: string) => void,
): Map<string, string> {
  const out = new Map<string, string>();
  if (full) {
    // Built-in values come from the generated tokens (code, not stored data)
    for (const g of GROUPS) {
      for (const [n, v] of Object.entries(THEME_TOKENS[g])) out.set(VARIABLE[g](n), v[scheme]);
    }
  }
  const over: unknown = (theme.schemes as Record<string, unknown> | undefined)?.[scheme];
  if (!isRecord(over)) return out;
  for (const g of GROUPS) {
    const values = over[g];
    if (!isRecord(values)) continue;
    for (const [n, raw] of Object.entries(values)) {
      const v = OVERRIDABLE[g].has(n) ? canonicalThemeValue(g, raw) : undefined;
      if (v === undefined) skip(`schemes.${scheme}.${g}.${n}`);
      else out.set(VARIABLE[g](n), v);
    }
  }
  const radius = over.radius;
  if (isRecord(radius)) {
    for (const [n, raw] of Object.entries(radius)) {
      const ok =
        OVERRIDABLE.radius.has(n) &&
        typeof raw === "number" &&
        Number.isInteger(raw) &&
        raw >= 0 &&
        raw <= 16;
      if (ok) out.set(VARIABLE.radius(n), `${raw}px`);
      else skip(`schemes.${scheme}.radius.${n}`);
    }
  }
  return out;
}

const declarations = (d: Map<string, string>, extra: string[] = []): string =>
  [...extra, ...[...d].map(([k, v]) => `${k}: ${v};`)].join(" ");

/**
 * The stylesheet of a stored theme (themes spec §8): each scheme's overrides under
 * `:root[data-theme="<scheme>"]` (a single-scheme theme: its whole scheme, the same block under
 * both selectors, with `color-scheme: <scheme>`), an `@font-face` per font (`src` from
 * `assetUrl(<the font's path as stored>)`, the one URL builder), and each font role's stack with
 * the theme's families first, then the built-in stack. Every stored value is re-validated (token
 * names against the overridable list, values against the SDK grammar, radius 0-16, families,
 * paths, weights, styles, roles); one that fails is left out, and `onSkipped` (when given and
 * something was skipped) is called once with the paths of every skipped value. The whole
 * stylesheet is one `@layer theme { … }` block (client extensions spec §7.2).
 */
export function renderThemeCss(
  theme: ParsedTheme,
  assetUrl: (pluginPath: string) => string,
  onSkipped?: (paths: string[]) => void,
): string {
  const skipped: string[] = [];
  const skip = (p: string) => skipped.push(p);
  const rules: string[] = [];

  const single = SCHEMES.includes(theme.singleScheme as ThemeScheme)
    ? (theme.singleScheme as ThemeScheme)
    : null;
  if (single !== null) {
    const body = declarations(schemeDeclarations(theme, single, true, skip), [
      `color-scheme: ${single};`,
    ]);
    for (const s of SCHEMES) rules.push(`:root[data-theme="${s}"] { ${body} }`);
  } else {
    for (const s of SCHEMES) {
      const d = schemeDeclarations(theme, s, false, skip);
      if (d.size > 0) rules.push(`:root[data-theme="${s}"] { ${declarations(d)} }`);
    }
  }

  const families: Record<keyof typeof STACK_VARIABLE, string[]> = { mono: [], prose: [] };
  const fonts: unknown = theme.fonts;
  (Array.isArray(fonts) ? fonts : []).forEach((f: unknown, i) => {
    const font = isRecord(f) ? f : {};
    const style = font.style ?? "normal";
    const role = font.role;
    const ok =
      isThemeFontFamily(font.family) &&
      isThemeAssetPath(font.file) &&
      /\.woff2$/i.test(font.file) &&
      typeof font.weight === "number" &&
      Number.isInteger(font.weight) &&
      font.weight >= 100 &&
      font.weight <= 900 &&
      (style === "normal" || style === "italic") &&
      (role === "mono" || role === "prose");
    if (!ok) {
      skip(`fonts.${i}`);
      return;
    }
    const family = font.family as string;
    rules.push(
      `@font-face { font-family: "${family}"; src: url("${assetUrl(font.file as string)}") format("woff2"); font-weight: ${font.weight}; font-style: ${style}; font-display: swap; }`,
    );
    const list = families[role];
    if (!list.includes(family)) list.push(family);
  });
  const stacks = (["mono", "prose"] as const)
    .filter((r) => families[r].length > 0)
    .map(
      (r) =>
        `${STACK_VARIABLE[r]}: ${families[r].map((f) => `"${f}"`).join(", ")}, ${THEME_FONTS[r]};`,
    );
  if (stacks.length > 0) rules.push(`:root { ${stacks.join(" ")} }`);

  if (skipped.length > 0) onSkipped?.(skipped);
  // One block in the `theme` cascade layer (client extensions spec §7.2): the design stylesheet
  // declares the order design, theme, extensions; an unlayered theme would beat plugin CSS.
  return `@layer theme {\n${rules.join("\n")}\n}\n`;
}
