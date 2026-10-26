import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "./source.js";

export type { Finding };

/** Where the source and the two generated files live, relative to the repository root. */
export const TOKENS_JSON = "docs/design/tokens.json";
export const TOKENS_CSS = "packages/design/src/styles/tokens.css";
export const TOKENS_TS = "packages/design/src/tokens.ts";

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
  contrast: [string, string, number][];
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

const TOP_KEYS = ["version", "color", "shadow", "size", "motion", "font", "z", "contrast"];
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
        p.length === 3 &&
        typeof p[0] === "string" &&
        typeof p[1] === "string" &&
        typeof p[2] === "number" &&
        p[2] >= 1;
      if (!ok) {
        bad("contrast", `entry ${i} must be [foreground, background, floor >= 1]`);
        return;
      }
      for (const name of [p[0], p[1]] as string[]) {
        if (!(name in colors)) bad("contrast", `entry ${i} names an unknown color token "${name}"`);
      }
    });
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

/**
 * check:tokens: tokens.json is well-formed (`tokens-invalid`), the generated tokens.css / tokens.ts
 * equal what gen:tokens renders (`tokens-stale`), and every contrast pair meets its floor in both
 * themes (`tokens-contrast`; pairs with a non-hex value such as color-mix are skipped).
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

  tokens.contrast.forEach(([fg, bg, floor]) => {
    for (const theme of THEMES) {
      const a = tokens.color[fg]?.[theme] as string;
      const b = tokens.color[bg]?.[theme] as string;
      if (!HEX_RE.test(a) || !HEX_RE.test(b)) continue;
      const ratio = contrastRatio(a, b);
      if (ratio + 1e-9 < floor) {
        out.push({
          file: jsonFile,
          line: lineOf(text, "contrast"),
          rule: "tokens-contrast",
          message: `${fg} on ${bg} (${theme}): ${a} on ${b} is ${ratio.toFixed(2)}:1, below the floor ${floor}:1`,
        });
      }
    }
  });
  return out;
}
