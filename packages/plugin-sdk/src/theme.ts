import { z } from "zod";
import { CATALOG_ITEM_NAME_RE, isSafePackagePath, type LocalizedName } from "./plugin-package.js";
import { checkThemeReadability, type MergedScheme, type ThemeScheme } from "./theme-readability.js";
import { THEME_OVERRIDABLE, THEME_TOKENS } from "./theme-tokens.generated.js";

/**
 * A theme file `themes/<id>.json` (themes spec §4): a partial override of the design tokens per
 * scheme, optional fonts and an optional logo. The id is the file's base name
 * ({@link themeIdOf}, `CATALOG_ITEM_NAME_RE`).
 *
 * {@link parseThemeFile} is the CSS-injection boundary: every token value is parsed against the
 * grammar `tokens.json` uses (`#RRGGBB`, `rgba(r,g,b,a)`, shadows `<x> <y> <blur> [<spread>]
 * <color>`) and re-rendered from its parts in canonical form. Asset paths (`fonts[].file`,
 * `logo.*`) are relative to the plugin root (an optional leading `./`) and every segment is limited
 * to `[A-Za-z0-9._-]`, so they need no escaping inside `url(...)`. Font families are limited to
 * letters, digits, spaces and `-`. Free text (`name`, `description`, `logo.wordmark`) carries no
 * control, format, line / paragraph separator or lone surrogate characters; it is text for the UI,
 * never CSS. Whether the files exist and their size / signature / SVG rules are checked by
 * the reader of the package, with {@link THEME_LIMITS}.
 *
 * The committed JSON Schema (`schemas/theme.v1.schema.json`) is generated from
 * {@link ThemeFileSchema} (the shape only) by `pnpm gen:package-schemas`; token names, value
 * grammar, path safety and readability are decided only by {@link parseThemeFile}.
 */

/** Limits of theme files and their assets. */
export const THEME_LIMITS = {
  /** UTF-8 bytes of one theme file. */
  fileBytes: 64 * 1024,
  /** Themes per plugin. */
  perPlugin: 10,
  /** Total bytes of a plugin's theme assets (fonts and logos). */
  assetsBytes: 16 * 1024 * 1024,
  /** Fonts per theme. */
  fonts: 8,
  /** Bytes of one woff2 font. */
  fontBytes: 2 * 1024 * 1024,
  /** Bytes of a logo SVG. */
  svgBytes: 128 * 1024,
  /** Bytes of a logo PNG. */
  pngBytes: 256 * 1024,
  /** Minimum pixel height of a logo PNG. */
  pngMinHeight: 64,
  /** Characters of the wordmark. */
  wordmark: 24,
} as const;

/** A theme of the plugin: a `./…/<id>.json` file ({@link ThemeFile}). */
export interface PluginThemeRef {
  path: string;
}

/** One scheme's partial override; tokens left out keep the built-in value of that scheme. */
export interface ThemeSchemeOverride {
  /** Overridable color tokens (`THEME_OVERRIDABLE.color`): `#RRGGBB` or `rgba(r,g,b,a)`. */
  color?: Record<string, string>;
  /** Shadow tokens: `<x> <y> <blur> [<spread>] <color>`. */
  shadow?: Record<string, string>;
  /** Pixels, integers 0-16. */
  radius?: Partial<Record<"sm" | "md" | "bubble", number>>;
}

/** A woff2 font of the theme, put first in its role's font stack. */
export interface ThemeFont {
  /** Letters, digits, spaces and `-`, ≤ 64 characters. */
  family: string;
  /** A `.woff2` path inside the plugin. */
  file: string;
  /** 100-900. */
  weight: number;
  style?: "normal" | "italic";
  /** `prose` (`--cb-font-prose`) or `mono` (`--cb-font`, the UI's body font). */
  role: "prose" | "mono";
}

/** The theme's logo; each part omitted keeps the built-in one. */
export interface ThemeLogo {
  /** `.svg` or `.png` path inside the plugin. */
  mark?: string;
  /** Replaces `CAPYBARA`: ≤ 24 characters, no control or format characters. */
  wordmark?: string;
  /** `.svg` or `.png` path inside the plugin. */
  favicon?: string;
}

/** `themes/<id>.json`. */
export interface ThemeFile {
  name: LocalizedName;
  description?: { en: string; zh?: string };
  /** `dark`, `light` or both. */
  schemes: Partial<Record<ThemeScheme, ThemeSchemeOverride>>;
  fonts?: ThemeFont[];
  logo?: ThemeLogo;
}

/** A theme file after {@link parseThemeFile}: values canonical, schemes merged. */
export interface ParsedTheme extends ThemeFile {
  id: string;
  /** Each scheme the theme defines, merged onto the built-in values. */
  merged: Partial<Record<ThemeScheme, MergedScheme>>;
  /** The only scheme of a single-scheme theme, else null. */
  singleScheme: ThemeScheme | null;
}

/** `themes/night-city.json` → `night-city`. */
export function themeIdOf(path: string): string {
  return (path.split("/").pop() ?? "").replace(/\.json$/, "");
}

const MAX_ERRORS = 50;
const FAMILY_RE = /^[A-Za-z0-9 -]{1,64}$/;
/** Control, format, line / paragraph separator and lone surrogate characters. */
const FORBIDDEN_CHARS_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const FORBIDDEN_CHARS_MESSAGE =
  "must not contain control, format, line / paragraph separator or lone surrogate characters";
const IMAGE_RE = /\.(?:svg|png)$/i;
const MAX_VALUE_CHARS = 256;

const text = (max: number, what: string) =>
  z
    .string()
    .min(1)
    .max(max)
    .regex(/\S/, { message: `${what} must not be blank` })
    .refine((t) => !FORBIDDEN_CHARS_RE.test(t), { message: `${what} ${FORBIDDEN_CHARS_MESSAGE}` });

/** A plugin-root relative path (optional `./`), each segment `[A-Za-z0-9._-]`, no `.` / `..`. */
const isPlainAssetPath = (p: string) => {
  const rest = p.replace(/^\.\//, "");
  return (
    isSafePackagePath(rest) &&
    rest.split("/").every((seg) => PATH_SEGMENT_RE.test(seg) && seg !== "." && seg !== "..")
  );
};

const assetPath = (what: string, ext: RegExp, kind: string) =>
  z
    .string()
    .max(512)
    .refine((p) => isPlainAssetPath(p) && ext.test(p), {
      message: `${what} must be a relative ${kind} path inside the plugin, each segment of letters, digits, ".", "_" or "-"`,
    });

const tokenValues = z.record(z.string().max(64), z.string().max(MAX_VALUE_CHARS));
const radius = z.number().int().min(0).max(16);

const schemeOverride = z.strictObject({
  color: tokenValues.optional(),
  shadow: tokenValues.optional(),
  radius: z
    .strictObject({ sm: radius.optional(), md: radius.optional(), bubble: radius.optional() })
    .optional(),
});

const shape = z.strictObject({
  $schema: z.string().max(512).optional(),
  name: z.strictObject({ zh: text(100, "name.zh"), en: text(100, "name.en") }),
  description: z
    .strictObject({
      en: text(1024, "description.en"),
      zh: text(1024, "description.zh").optional(),
    })
    .optional(),
  schemes: z
    .strictObject({ dark: schemeOverride.optional(), light: schemeOverride.optional() })
    .refine((s) => s.dark !== undefined || s.light !== undefined, {
      message: "schemes must define dark, light or both",
    }),
  fonts: z
    .array(
      z.strictObject({
        family: z.string().regex(FAMILY_RE, {
          message: "family must be 1-64 letters, digits, spaces or '-'",
        }),
        file: assetPath("file", /\.woff2$/i, ".woff2"),
        weight: z.number().int().min(100).max(900),
        style: z.enum(["normal", "italic"]).optional(),
        role: z.enum(["prose", "mono"]),
      }),
    )
    .max(THEME_LIMITS.fonts)
    .optional(),
  logo: z
    .strictObject({
      mark: assetPath("mark", IMAGE_RE, ".svg or .png").optional(),
      wordmark: z
        .string()
        .regex(/\S/, { message: "wordmark must not be blank" })
        .refine((w) => [...w].length <= THEME_LIMITS.wordmark, {
          message: `wordmark must be at most ${THEME_LIMITS.wordmark} characters`,
        })
        .refine((w) => !FORBIDDEN_CHARS_RE.test(w), {
          message: `wordmark ${FORBIDDEN_CHARS_MESSAGE}`,
        })
        .optional(),
      favicon: assetPath("favicon", IMAGE_RE, ".svg or .png").optional(),
    })
    .optional(),
});

/**
 * The zod schema of a theme file's shape (strict objects). Token names and values are only
 * strings here; see {@link parseThemeFile}. The JSON Schema is generated with
 * `z.toJSONSchema(ThemeFileSchema, { io: "input" })`.
 */
export const ThemeFileSchema: z.ZodType<ThemeFile> = shape as unknown as z.ZodType<ThemeFile>;

const HEX_RE = /^#([0-9A-Fa-f]{6})$/;
const RGBA_RE = /^rgba\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(0|1|0?\.\d{1,4})\s*\)$/;
const LENGTH_RE = /^(-?)(\d{1,3})(px)?$/;

/** `#RRGGBB` uppercase or `rgba(r,g,b,a)` rendered from its parts; undefined outside the grammar. */
function parseColor(v: string): string | undefined {
  const hex = HEX_RE.exec(v);
  if (hex) return `#${(hex[1] as string).toUpperCase()}`;
  const m = RGBA_RE.exec(v);
  if (!m) return undefined;
  const ch = [m[1], m[2], m[3]].map(Number);
  if (ch.some((c) => c > 255)) return undefined;
  return `rgba(${ch.join(",")},${String(Number(m[4]))})`;
}

/** A shadow length: `0` or `<n>px` (unitless only for 0), rendered as `0` / `<n>px`. */
function parseLength(v: string, allowNegative: boolean): string | undefined {
  const m = LENGTH_RE.exec(v);
  if (!m) return undefined;
  const n = Number(m[2]);
  if (n !== 0 && m[3] === undefined) return undefined;
  if (n === 0) return "0";
  if (m[1] === "-" && !allowNegative) return undefined;
  return `${m[1]}${n}px`;
}

/** `<x> <y> <blur> [<spread>] <color>`, rendered canonically; undefined outside the grammar. */
function parseShadow(v: string): string | undefined {
  const s = v.trim();
  const at = s.endsWith(")") ? s.lastIndexOf("rgba(") : s.lastIndexOf(" ") + 1;
  if (at <= 0 || !/\s/.test(s.charAt(at - 1))) return undefined;
  const color = parseColor(s.slice(at));
  const lengths = s.slice(0, at).trim().split(/\s+/);
  if (color === undefined || lengths.length < 3 || lengths.length > 4) return undefined;
  // x, y and spread may be negative; blur may not.
  const parts = lengths.map((l, i) => parseLength(l, i !== 2));
  if (parts.some((p) => p === undefined)) return undefined;
  return `${parts.join(" ")} ${color}`;
}

const SCHEMES: readonly ThemeScheme[] = ["dark", "light"];
type TokenGroup = "color" | "shadow";
const OVERRIDABLE: Record<TokenGroup, ReadonlySet<string>> = {
  color: new Set(THEME_OVERRIDABLE.color),
  shadow: new Set(THEME_OVERRIDABLE.shadow),
};
const GRAMMAR: Record<TokenGroup, { parse: (v: string) => string | undefined; form: string }> = {
  color: { parse: parseColor, form: "#RRGGBB or rgba(r,g,b,a)" },
  shadow: {
    parse: parseShadow,
    form: "<x> <y> <blur> [<spread>] <color> with px lengths and a #RRGGBB or rgba(r,g,b,a) color",
  },
};

/**
 * The canonical form of a token value under the grammar of `group` (the one {@link parseThemeFile}
 * applies), or undefined when `value` is not a string within it. For readers of stored themes that
 * emit values again (the kernel's stylesheet, themes spec §8): a stored value is re-validated
 * before it reaches CSS, so a changed database row cannot inject CSS.
 */
export function canonicalThemeValue(group: "color" | "shadow", value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_VALUE_CHARS) return undefined;
  return GRAMMAR[group].parse(value);
}

/** Whether `v` is a font family a theme may name: 1-64 letters, digits, spaces or `-`. */
export function isThemeFontFamily(v: unknown): v is string {
  return typeof v === "string" && FAMILY_RE.test(v);
}

/**
 * Whether `v` is an asset path a theme may name: plugin-root relative (an optional leading `./`),
 * every segment of `[A-Za-z0-9._-]`, no `.` / `..` segments (the extension is not checked).
 */
export function isThemeAssetPath(v: unknown): v is string {
  return typeof v === "string" && v.length <= 512 && isPlainAssetPath(v);
}

/** The built-in values of one scheme. */
function builtIn(scheme: ThemeScheme): MergedScheme {
  const pick = (group: Record<string, { dark: string; light: string }>) =>
    Object.fromEntries(Object.entries(group).map(([n, v]) => [n, v[scheme]]));
  return {
    color: pick(THEME_TOKENS.color),
    shadow: pick(THEME_TOKENS.shadow),
    radius: { ...THEME_TOKENS.radius },
  };
}

function readJson(json: unknown): { value: unknown } | { errors: string[] } {
  let text: string;
  if (typeof json === "string") {
    text = json;
  } else {
    // An already parsed value is measured by its JSON serialization.
    try {
      text = JSON.stringify(json) ?? "";
    } catch {
      return { errors: ["theme file must be a JSON object"] };
    }
  }
  if (new TextEncoder().encode(text).length > THEME_LIMITS.fileBytes) {
    return { errors: [`theme file is larger than ${THEME_LIMITS.fileBytes} bytes`] };
  }
  if (typeof json !== "string") return { value: json };
  try {
    return { value: JSON.parse(json.startsWith("\uFEFF") ? json.slice(1) : json) };
  } catch (e) {
    const first = (e instanceof Error ? e.message : String(e)).split("\n")[0];
    return { errors: [`theme file is not valid JSON: ${first}`] };
  }
}

/**
 * Parses and validates a theme file: the parsed JSON value or the file text (larger than
 * {@link THEME_LIMITS}`.fileBytes`, measured as text or as the value's JSON, is refused). Checks the id, the shape, token names against
 * the generated allowlist (an unknown or non-overridable name is an error), the value grammar,
 * fonts and logo; then merges every defined scheme onto the built-in tokens and reports each
 * readability issue as an error starting `unreadable:`. Returned values are canonical (uppercase
 * hex, rgba and shadows re-rendered from their parts). Invalid input returns `{ errors }`
 * (`<path>: <reason>`, English, at most 50); never throws.
 */
export function parseThemeFile(id: string, json: unknown): ParsedTheme | { errors: string[] } {
  if (!CATALOG_ITEM_NAME_RE.test(id)) {
    return { errors: [`theme id "${id}" must match ^[a-z0-9][a-z0-9-]{0,63}$`] };
  }
  const read = readJson(json);
  if ("errors" in read) return read;
  const data = read.value;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { errors: ["theme file must be a JSON object"] };
  }
  const r = shape.safeParse(data);
  if (!r.success) {
    return {
      errors: r.error.issues.slice(0, MAX_ERRORS).map((i) => {
        const path = i.path.map(String).join(".");
        return path ? `${path}: ${i.message}` : i.message;
      }),
    };
  }
  const file = r.data as ThemeFile & { $schema?: string };
  const errors: string[] = [];

  const seenFonts = new Set<string>();
  file.fonts?.forEach((f, i) => {
    const key = `${f.family.toLowerCase()}|${f.weight}|${f.style ?? "normal"}|${f.role}`;
    if (seenFonts.has(key)) {
      errors.push(
        `fonts.${i}: duplicate font ${f.family} ${f.weight} ${f.style ?? "normal"} (${f.role})`,
      );
    }
    seenFonts.add(key);
  });

  const schemes: Partial<Record<ThemeScheme, ThemeSchemeOverride>> = {};
  const merged: Partial<Record<ThemeScheme, MergedScheme>> = {};
  for (const scheme of SCHEMES) {
    const over = file.schemes[scheme];
    if (over === undefined) continue;
    const out: ThemeSchemeOverride = {};
    const m = builtIn(scheme);
    // Token names come from the raw object's own keys: the zod record drops `__proto__`.
    const rawScheme = (data as { schemes: Record<string, Record<string, unknown>> }).schemes[
      scheme
    ];
    for (const group of ["color", "shadow"] as const) {
      const values = over[group];
      if (values === undefined) continue;
      const rawGroup = rawScheme?.[group];
      const names = rawGroup !== null && typeof rawGroup === "object" ? Object.keys(rawGroup) : [];
      const canonical: Record<string, string> = {};
      for (const name of names) {
        const path = `schemes.${scheme}.${group}.${name}`;
        if (!OVERRIDABLE[group].has(name)) {
          errors.push(
            Object.hasOwn(THEME_TOKENS[group], name)
              ? `${path}: token ${group}.${name} is not overridable`
              : `${path}: unknown token ${group}.${name}`,
          );
          continue;
        }
        const raw = values[name];
        const v = raw === undefined ? undefined : GRAMMAR[group].parse(raw);
        if (v === undefined) {
          errors.push(`${path}: must be ${GRAMMAR[group].form}`);
          continue;
        }
        canonical[name] = v;
        m[group][name] = v;
      }
      out[group] = canonical;
    }
    if (over.radius !== undefined) {
      out.radius = { ...over.radius };
      Object.assign(m.radius, over.radius);
    }
    schemes[scheme] = out;
    merged[scheme] = m;
  }
  if (errors.length > 0) return { errors: errors.slice(0, MAX_ERRORS) };

  for (const scheme of SCHEMES) {
    const m = merged[scheme];
    if (m === undefined) continue;
    for (const issue of checkThemeReadability(scheme, m)) {
      errors.push(
        issue.kind === "unevaluable"
          ? `unreadable: schemes.${scheme}: ${issue.pair} has a value the check cannot evaluate`
          : issue.kind === "separation-order"
            ? `unreadable: schemes.${scheme}: ${issue.pair} must stand further from the surface than hover (${issue.ratio.toFixed(1)} ≤ ${issue.floor.toFixed(1)})`
            : `unreadable: schemes.${scheme}: ${issue.pair} ${issue.kind} ${issue.ratio.toFixed(2)} is below ${issue.floor}${issue.detail === undefined ? "" : ` (${issue.detail})`}`,
      );
    }
  }
  if (errors.length > 0) return { errors: errors.slice(0, MAX_ERRORS) };

  const defined = SCHEMES.filter((s) => merged[s] !== undefined);
  const { $schema: _schema, ...rest } = file;
  return {
    ...rest,
    schemes,
    id,
    merged,
    singleScheme: defined.length === 1 ? (defined[0] as ThemeScheme) : null,
  };
}
