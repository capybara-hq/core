import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checkThemeReadability, type ThemeScheme } from "@capybara-hq/plugin-sdk";
import type { Finding } from "./source.js";

export { compositeOver, contrastRatio, oklabL } from "@capybara-hq/plugin-sdk";
export type { Finding };

/** Where the source and the generated files live, relative to the repository root. */
export const TOKENS_JSON = "docs/design/tokens.json";
export const TOKENS_CSS = "packages/design/src/styles/tokens.css";
export const TOKENS_TS = "packages/design/src/tokens.ts";
export const THEME_TOKENS_TS = "packages/plugin-sdk/src/theme-tokens.generated.ts";

/** One themed value (a color or a shadow): emitted as `--cb-<name>` in each theme block. */
export type ThemedToken = { dark: string; light: string; purpose: string };

/** A scale step: a pixel value, or a pair (`pad`: [vertical, horizontal]; `type`: [size, line]). */
export type SizeStep = number | [number, number];

export type DesignTokens = {
  version: 1;
  color: Record<string, ThemedToken>;
  shadow: Record<string, ThemedToken>;
  size: {
    control: Record<string, number>;
    row: Record<string, number>;
    space: Record<string, number>;
    pad: Record<string, [number, number]>;
    radius: Record<string, number>;
    type: Record<string, [number, number]>;
    layout: Record<string, number>;
  };
  motion: Record<string, string>;
  font: { mono: string; prose: string };
  z: Record<string, number>;
  /** [foreground, background, floor] or, with a fourth element, the surface rgba values sit on. */
  contrast: ([string, string, number] | [string, string, number, string])[];
  /** [ground, surface, minimum OKLab lightness difference x100]; optional. */
  separation?: [string, string, number][];
};

const THEMES = ["dark", "light"] as const;
type Theme = (typeof THEMES)[number];

/** Size groups, and the variable suffixes of their pairs (absent = a single pixel value). */
const SIZE_GROUPS: Record<keyof DesignTokens["size"], [string, string] | undefined> = {
  control: undefined,
  row: undefined,
  space: undefined,
  pad: ["y", "x"],
  radius: undefined,
  type: ["size", "line"],
  layout: undefined,
};

const TOP_KEYS = [
  "version",
  "color",
  "shadow",
  "size",
  "motion",
  "font",
  "z",
  "contrast",
  "separation",
];
const NAME_RE = /^[a-z][a-z0-9-]*$/;
const STEP_RE = /^[a-z0-9][a-z0-9-]*$/;
const HEX_RE = /^#[0-9A-F]{6}$/;
const RGBA_RE = /^rgba\(\d{1,3},\d{1,3},\d{1,3},(?:0|1|0?\.\d+)\)$/;
const MIX_RE = /^color-mix\([^;{}]+\)$/;
/** A free-form CSS value (shadow, font stack) may not break out of its declaration. */
const SAFE_CSS_RE = /^[^;{}<>\n]+$/;
const MOTION_RE = /^\d+ms$/;

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const isPositiveInt = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0;

/** Best-effort line of a dot path in the JSON text (for the report only). */
function lineOf(text: string, path: string): number {
  let at = 0;
  for (const seg of path.split(".")) {
    const i = text.indexOf(`${JSON.stringify(seg)}:`, at);
    if (i < 0) break;
    at = i;
  }
  return text.slice(0, at).split("\n").length;
}

/** Parses and validates tokens.json. `tokens` is set only when there are no findings. */
export function parseTokens(
  text: string,
  file: string,
): { tokens?: DesignTokens; findings: Finding[] } {
  const findings: Finding[] = [];
  const bad = (path: string, message: string) =>
    findings.push({
      file,
      line: lineOf(text, path),
      rule: "tokens-invalid",
      message: `${path}: ${message}`,
    });

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    findings.push({
      file,
      line: 1,
      rule: "tokens-invalid",
      message: `not valid JSON (${(e as Error).message})`,
    });
    return { findings };
  }
  if (!isObject(json)) {
    bad("(root)", "must be a JSON object");
    return { findings };
  }
  for (const k of Object.keys(json)) {
    if (!TOP_KEYS.includes(k)) bad(k, `unknown key; allowed: ${TOP_KEYS.join(", ")}`);
  }
  if (json.version !== 1) bad("version", "must be 1");

  const themedNames = new Set<string>();
  const themed = (group: "color" | "shadow", valid: (v: string) => boolean, what: string) => {
    const g = json[group];
    if (!isObject(g) || Object.keys(g).length === 0) {
      bad(group, "must be a non-empty object");
      return;
    }
    for (const [name, entry] of Object.entries(g)) {
      const path = `${group}.${name}`;
      if (!NAME_RE.test(name)) bad(path, "name must match [a-z][a-z0-9-]*");
      if (themedNames.has(name)) bad(path, "name is already used by another color or shadow");
      themedNames.add(name);
      if (!isObject(entry)) {
        bad(path, "must be an object with dark, light and purpose");
        continue;
      }
      for (const theme of THEMES) {
        const v = entry[theme];
        if (v === undefined) bad(`${path}.${theme}`, "is missing");
        else if (typeof v !== "string" || !valid(v)) bad(`${path}.${theme}`, `must be ${what}`);
      }
      if (typeof entry.purpose !== "string" || entry.purpose.trim() === "") {
        bad(`${path}.purpose`, "must be a non-empty string");
      }
      for (const k of Object.keys(entry)) {
        if (k !== "dark" && k !== "light" && k !== "purpose") bad(`${path}.${k}`, "unknown key");
      }
    }
  };
  themed(
    "color",
    (v) => HEX_RE.test(v) || RGBA_RE.test(v) || MIX_RE.test(v),
    "an uppercase #RRGGBB, rgba(r,g,b,a) or color-mix(...)",
  );
  themed("shadow", (v) => SAFE_CSS_RE.test(v), "a CSS shadow value");

  const size = json.size;
  if (!isObject(size)) {
    bad("size", "must be an object");
  } else {
    for (const k of Object.keys(size)) {
      if (!(k in SIZE_GROUPS))
        bad(`size.${k}`, `unknown group; allowed: ${Object.keys(SIZE_GROUPS).join(", ")}`);
    }
    for (const [group, pair] of Object.entries(SIZE_GROUPS)) {
      const g = size[group];
      if (!isObject(g) || Object.keys(g).length === 0) {
        bad(`size.${group}`, "must be a non-empty object");
        continue;
      }
      for (const [step, v] of Object.entries(g)) {
        const path = `size.${group}.${step}`;
        if (!STEP_RE.test(step)) bad(path, "step name must match [a-z0-9][a-z0-9-]*");
        if (pair === undefined) {
          if (!isPositiveInt(v)) bad(path, "must be a positive integer (px)");
        } else if (!Array.isArray(v) || v.length !== 2 || !v.every(isPositiveInt)) {
          bad(path, `must be [${pair.join(", ")}], two positive integers (px)`);
        }
      }
    }
  }

  const motion = json.motion;
  if (!isObject(motion) || !("hover" in motion)) {
    bad("motion", "must be an object with at least hover");
  } else {
    for (const [name, v] of Object.entries(motion)) {
      if (!STEP_RE.test(name)) bad(`motion.${name}`, "name must match [a-z0-9][a-z0-9-]*");
      if (typeof v !== "string" || !MOTION_RE.test(v)) bad(`motion.${name}`, "must be like 120ms");
    }
  }

  const font = json.font;
  if (!isObject(font)) {
    bad("font", "must be an object with mono and prose");
  } else {
    for (const k of ["mono", "prose"]) {
      const v = font[k];
      if (typeof v !== "string" || !SAFE_CSS_RE.test(v)) bad(`font.${k}`, "must be a font stack");
    }
    for (const k of Object.keys(font)) {
      if (k !== "mono" && k !== "prose") bad(`font.${k}`, "unknown key");
    }
  }

  const z = json.z;
  if (!isObject(z)) {
    bad("z", "must be an object");
  } else {
    for (const [name, v] of Object.entries(z)) {
      if (!STEP_RE.test(name)) bad(`z.${name}`, "name must match [a-z0-9][a-z0-9-]*");
      if (!isPositiveInt(v)) bad(`z.${name}`, "must be a positive integer");
    }
  }

  const colors = isObject(json.color) ? json.color : {};
  if (!Array.isArray(json.contrast)) {
    bad("contrast", "must be an array of [foreground, background, floor]");
  } else {
    json.contrast.forEach((p: unknown, i: number) => {
      const ok =
        Array.isArray(p) &&
        (p.length === 3 || (p.length === 4 && typeof p[3] === "string")) &&
        typeof p[0] === "string" &&
        typeof p[1] === "string" &&
        typeof p[2] === "number" &&
        p[2] >= 1;
      if (!ok) {
        bad("contrast", `entry ${i} must be [foreground, background, floor >= 1, surface?]`);
        return;
      }
      for (const name of [p[0], p[1], ...p.slice(3)] as string[]) {
        if (!(name in colors)) bad("contrast", `entry ${i} names an unknown color token "${name}"`);
      }
    });
  }
  if (json.separation !== undefined) {
    if (!Array.isArray(json.separation)) {
      bad("separation", "must be an array of [ground, surface, minDeltaL]");
    } else {
      json.separation.forEach((p: unknown, i: number) => {
        const ok =
          Array.isArray(p) &&
          p.length === 3 &&
          typeof p[0] === "string" &&
          typeof p[1] === "string" &&
          typeof p[2] === "number" &&
          p[2] > 0;
        if (!ok) {
          bad("separation", `entry ${i} must be [ground, surface, minDeltaL > 0]`);
          return;
        }
        for (const name of [p[0], p[1]] as string[]) {
          if (!(name in colors))
            bad("separation", `entry ${i} names an unknown color token "${name}"`);
        }
      });
    }
  }

  if (findings.length > 0) return { findings };
  return { tokens: json as DesignTokens, findings };
}

const px = (n: number) => `${n}px`;

/** The generated tokens.css. */
export function renderTokensCss(t: DesignTokens): string {
  const root: string[] = [`--cb-font: ${t.font.mono};`, `--cb-font-prose: ${t.font.prose};`];
  for (const [name, v] of Object.entries(t.z)) root.push(`--cb-z-${name}: ${v};`);
  root.push(`--cb-motion: ${t.motion.hover};`);
  for (const [name, v] of Object.entries(t.motion)) root.push(`--cb-motion-${name}: ${v};`);
  for (const [group, pair] of Object.entries(SIZE_GROUPS)) {
    const steps = t.size[group as keyof DesignTokens["size"]] as Record<string, SizeStep>;
    for (const [step, v] of Object.entries(steps)) {
      if (pair === undefined) root.push(`--cb-${group}-${step}: ${px(v as number)};`);
      else {
        const [a, b] = v as [number, number];
        root.push(`--cb-${group}-${step}-${pair[0]}: ${px(a)};`);
        root.push(`--cb-${group}-${step}-${pair[1]}: ${px(b)};`);
      }
    }
  }
  const theme = (th: Theme) => {
    const lines = [...Object.entries(t.color), ...Object.entries(t.shadow)].map(
      ([name, v]) => `--cb-${name}: ${v[th]};`,
    );
    lines.push(`color-scheme: ${th};`);
    return `:root[data-theme="${th}"] {\n${lines.map((l) => `  ${l}`).join("\n")}\n}\n`;
  };
  return [
    "/* biome-ignore-all format: token values stay verbatim (uppercase hex, rgba spelling) */\n",
    "/* Generated by pnpm gen:tokens from docs/design/tokens.json; do not edit. */\n",
    "/* Color literals are allowed only in this file (design spec §2). Dark is the default theme. */\n",
    "\n",
    `:root {\n${root.map((l) => `  ${l}`).join("\n")}\n}\n`,
    "\n",
    theme("dark"),
    "\n",
    theme("light"),
  ].join("");
}

const WIDTH = 100;
const key = (k: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k));
const value = (v: SizeStep) => (Array.isArray(v) ? `[${v.join(", ")}]` : String(v));

/** The generated tokens.ts (biome-formatted; carries no color values). */
export function renderTokensTs(t: DesignTokens): string {
  const names = [...Object.keys(t.color), ...Object.keys(t.shadow)];
  const oneLine = `export const TOKEN_NAMES = [${names.map((n) => JSON.stringify(n)).join(", ")}] as const;`;
  const tokenNames =
    oneLine.length <= WIDTH
      ? oneLine
      : `export const TOKEN_NAMES = [\n${names.map((n) => `  ${JSON.stringify(n)},`).join("\n")}\n] as const;`;
  const groups = Object.keys(SIZE_GROUPS).map((group) => {
    const steps = t.size[group as keyof DesignTokens["size"]] as Record<string, SizeStep>;
    const entries = Object.entries(steps).map(([k, v]) => `${key(k)}: ${value(v)}`);
    const single = `  ${group}: { ${entries.join(", ")} },`;
    if (single.length <= WIDTH) return single;
    return `  ${group}: {\n${entries.map((e) => `    ${e},`).join("\n")}\n  },`;
  });
  return [
    "// Generated by pnpm gen:tokens from docs/design/tokens.json; do not edit.",
    "",
    "/** Every color and shadow token name (design spec §2), each a `--cb-<name>` variable. */",
    tokenNames,
    "",
    "export type TokenName = (typeof TOKEN_NAMES)[number];",
    "",
    "/**",
    " * The sizing scales (spec §4.3) in px, each step also a `--cb-<group>-<step>` variable.",
    " * `pad` is [vertical, horizontal] and `type` is [size, line height].",
    " */",
    "export const SIZES = {",
    ...groups,
    "} as const;",
    "",
  ].join("\n");
}

/** A color whose value derives from other tokens (`color-mix`) is never overridden directly. */
const isDerived = (v: ThemedToken) => MIX_RE.test(v.dark) || MIX_RE.test(v.light);

/** The generated SDK file: built-in token values, the overridable allowlist and the rules. */
export function renderThemeTokensTs(t: DesignTokens): string {
  const json = (v: unknown) => JSON.stringify(v);
  const themed = (group: Record<string, ThemedToken>) =>
    Object.entries(group)
      .map(([n, v]) => `    ${json(n)}: { dark: ${json(v.dark)}, light: ${json(v.light)} },`)
      .join("\n");
  const list = (names: string[]) => names.map((n) => `    ${json(n)},`).join("\n");
  const overridable = Object.entries(t.color)
    .filter(([n, v]) => !n.startsWith("avatar-") && !isDerived(v))
    .map(([n]) => n);
  const radius = t.size.radius;
  return [
    "// Generated by pnpm gen:tokens from docs/design/tokens.json; do not edit.",
    "// biome-ignore-all format: token values stay verbatim (uppercase hex, rgba spelling)",
    "",
    "/** The built-in token values a theme overrides (design spec §2). */",
    "export const THEME_TOKENS = {",
    "  color: {",
    themed(t.color),
    "  },",
    "  shadow: {",
    themed(t.shadow),
    "  },",
    `  radius: { sm: ${radius.sm}, md: ${radius.md}, bubble: ${radius.bubble} },`,
    "} as const satisfies {",
    "  color: Record<string, { dark: string; light: string }>;",
    "  shadow: Record<string, { dark: string; light: string }>;",
    '  radius: Record<"sm" | "md" | "bubble", number>;',
    "};",
    "",
    "/** The tokens a theme may override: no avatar colors, no color-mix values (they derive). */",
    "export const THEME_OVERRIDABLE = {",
    "  color: [",
    list(overridable),
    "  ],",
    "  shadow: [",
    list(Object.keys(t.shadow)),
    "  ],",
    '  radius: ["sm", "md", "bubble"],',
    "} as const;",
    "",
    "/** [foreground, background, floor] or, with a fourth element, the surface it sits on. */",
    "export const THEME_CONTRAST: readonly (readonly [fg: string, bg: string, floor: number, over?: string])[] = [",
    ...t.contrast.map((c) => `  ${json(c)},`),
    "];",
    "",
    "/** [ground, surface, minimum OKLab lightness difference x100]. */",
    "export const THEME_SEPARATION: readonly (readonly [ground: string, surface: string, floor: number])[] = [",
    ...(t.separation ?? []).map((c) => `  ${json(c)},`),
    "];",
    "",
  ].join("\n");
}

/**
 * check:tokens: tokens.json is well-formed (`tokens-invalid`), the generated tokens.css / tokens.ts
 * equal what gen:tokens renders (`tokens-stale`), and every contrast pair meets its floor in both
 * themes (`tokens-contrast`). An rgba(...) value is composited over the theme's `bg` first (diff
 * tints are drawn on the page ground), or over the pair's fourth element, a surface token; pairs
 * with a color-mix value are skipped. Every `separation` entry's ground, composited over its
 * surface, differs from it by at least the floor in OKLab lightness x100 (`tokens-separation`), and
 * `selected` is further from a surface than `hover` on the same surface (`tokens-separation-order`).
 */
export function checkTokens(root: string): Finding[] {
  const jsonFile = join(root, TOKENS_JSON);
  if (!existsSync(jsonFile)) {
    return [{ file: jsonFile, line: 1, rule: "tokens-invalid", message: "tokens.json is missing" }];
  }
  const text = readFileSync(jsonFile, "utf8");
  const { tokens, findings } = parseTokens(text, jsonFile);
  if (!tokens) return findings;

  const out: Finding[] = [];
  for (const [rel, expected] of [
    [TOKENS_CSS, renderTokensCss(tokens)],
    [TOKENS_TS, renderTokensTs(tokens)],
    [THEME_TOKENS_TS, renderThemeTokensTs(tokens)],
  ] as const) {
    const file = join(root, rel);
    const actual = existsSync(file) ? readFileSync(file, "utf8") : undefined;
    if (actual === expected) continue;
    const a = (actual ?? "").split("\n");
    const e = expected.split("\n");
    let line = 0;
    while (line < e.length && a[line] === e[line]) line++;
    out.push({
      file,
      line: line + 1,
      rule: "tokens-stale",
      message:
        actual === undefined
          ? `${rel} is missing; run pnpm gen:tokens`
          : `${rel} differs from docs/design/tokens.json; run pnpm gen:tokens (never edit it by hand)`,
    });
  }

  const flat = (th: Theme) => {
    const pick = (g: Record<string, ThemedToken>) =>
      Object.fromEntries(Object.entries(g).map(([n, v]) => [n, v[th]]));
    return { color: pick(tokens.color), shadow: pick(tokens.shadow), radius: tokens.size.radius };
  };
  const rules = { contrast: tokens.contrast, separation: tokens.separation ?? [] };
  for (const theme of THEMES) {
    for (const issue of checkThemeReadability(theme as ThemeScheme, flat(theme), rules)) {
      if (issue.kind === "contrast") {
        out.push({
          file: jsonFile,
          line: lineOf(text, "contrast"),
          rule: "tokens-contrast",
          message: `${issue.pair} (${theme}): ${issue.detail} is ${issue.ratio.toFixed(2)}:1, below the floor ${issue.floor}:1`,
        });
      } else if (issue.kind === "separation") {
        out.push({
          file: jsonFile,
          line: lineOf(text, "separation"),
          rule: "tokens-separation",
          message: `${issue.pair} (${theme}): ${issue.detail} differs by ${issue.ratio.toFixed(2)} in OKLab L x100, below the floor ${issue.floor}`,
        });
      } else if (issue.kind === "unevaluable") {
        out.push({
          file: jsonFile,
          line: lineOf(text, `color.${issue.pair}`),
          rule: "tokens-invalid",
          message: `color.${issue.pair} (${theme}): "${issue.detail}" cannot be evaluated for contrast`,
        });
      } else {
        out.push({
          file: jsonFile,
          line: lineOf(text, "separation"),
          rule: "tokens-separation-order",
          message: `${issue.pair} (${theme}) differs by ${issue.ratio.toFixed(2)}, not more than hover (${issue.floor.toFixed(2)}): selected must stand further from its surface than hover`,
        });
      }
    }
  }
  return out;
}
