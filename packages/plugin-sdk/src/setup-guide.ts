/**
 * Plugin setup guides (spec `2026-11-08-plugin-setup-guides-design.md`): setup material a plugin
 * ships (steps and template files such as Slack's app manifest) that the kernel renders with a
 * fixed set of safe, deterministic variables and the web shows where the person needs it. The
 * format lives in `plugin.json` `setupGuides` ({@link PluginSetupGuide}); this module holds the
 * places, their modes and variables, the limits and the pure renderer.
 *
 * Placeholders are `{{name}}` (spaces inside the braces allowed) with `name` matching
 * `[A-Za-z][A-Za-z0-9]*`. There is no other syntax: no conditionals, loops, filters or escapes. A
 * placeholder the place does not define, or one without a value, stays as written.
 */

/** Where a guide is shown. `channel-connection`: 新建渠道 and the channel detail page. */
export const SETUP_GUIDE_PLACES = ["channel-connection"] as const;
export type SetupGuidePlace = (typeof SETUP_GUIDE_PLACES)[number];

/**
 * The modes of each place: a step or file with `mode` applies to that mode only.
 * `channel-connection`: the connection's `inboundMode`.
 */
export const SETUP_GUIDE_MODES: Readonly<Record<SetupGuidePlace, readonly string[]>> = {
  "channel-connection": ["long_connection", "webhook"],
};

/**
 * The variables of each place. None is a secret: the kernel fills them from public URLs, names and
 * versions only (`publicUrl`, `webhookUrl`, `signInCallbackUrl`, `connectionName`, `orgName`,
 * `pluginName`, `pluginVersion`, `mode`).
 */
export const SETUP_GUIDE_VARIABLES: Readonly<Record<SetupGuidePlace, readonly string[]>> = {
  "channel-connection": [
    "publicUrl",
    "webhookUrl",
    "signInCallbackUrl",
    "connectionName",
    "orgName",
    "pluginName",
    "pluginVersion",
    "mode",
  ],
};

/** Languages of a template file: the code block's label and how values are escaped. */
export const SETUP_GUIDE_LANGUAGES = ["yaml", "json", "text"] as const;
export type SetupGuideLanguage = (typeof SETUP_GUIDE_LANGUAGES)[number];

/** Limits of setup guides. */
export const SETUP_GUIDE_LIMITS = {
  /** Guides per plugin. */
  guides: 8,
  /** Steps per guide. */
  steps: 20,
  /** Files per guide. */
  files: 8,
  /** Characters of a step (each language). */
  stepChars: 2000,
  /** Characters of a title (each language). */
  titleChars: 100,
  /** Bytes of a template file. */
  fileBytes: 64 * 1024,
} as const;

/** File names a template file may have (checked on the path). */
export const SETUP_GUIDE_FILE_RE = /\.(?:tmpl|ya?ml|json|txt)$/i;

/** Localized text: English, optional Chinese (falls back to English). */
export interface SetupGuideText {
  en: string;
  zh?: string;
}

/** A step: plain text (a backtick pair is shown as inline code), optionally for one mode. */
export interface SetupGuideStep extends SetupGuideText {
  mode?: string;
}

/** A template file of a guide. */
export interface SetupGuideFile {
  /** `./…` inside the plugin, `.tmpl` / `.yaml` / `.yml` / `.json` / `.txt`. */
  path: string;
  title: SetupGuideText;
  language: SetupGuideLanguage;
  mode?: string;
}

/** A setup guide in `plugin.json` `setupGuides`. */
export interface PluginSetupGuide {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the plugin. */
  id: string;
  place: SetupGuidePlace;
  title: SetupGuideText;
  steps?: SetupGuideStep[];
  files?: SetupGuideFile[];
}

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9]*)\s*\}\}/g;

/** The placeholder names a text uses, each once, in order of first use. */
export function setupGuidePlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const name = m[1] as string;
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/** The placeholders of a text that the place does not define (the toolchain refuses them). */
export function unknownSetupGuidePlaceholders(text: string, place: SetupGuidePlace): string[] {
  const known = SETUP_GUIDE_VARIABLES[place];
  return setupGuidePlaceholders(text).filter((n) => !known.includes(n));
}

/** The modes a guide's steps and files use, in the place's order (empty: no mode switch). */
export function setupGuideModes(guide: PluginSetupGuide): string[] {
  const used = new Set<string>();
  for (const s of guide.steps ?? []) if (s.mode !== undefined) used.add(s.mode);
  for (const f of guide.files ?? []) if (f.mode !== undefined) used.add(f.mode);
  return SETUP_GUIDE_MODES[guide.place].filter((m) => used.has(m));
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

/** A value as inserted into a text of the language (see {@link renderSetupGuideText}). */
function escapeValue(value: string, language: SetupGuideLanguage): string {
  if (language === "text") return value.replace(CONTROL_RE, " ");
  // JSON string escaping without the quotes: valid inside a JSON string and a YAML double-quoted
  // scalar, whatever the value holds
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Renders a guide text: each `{{name}}` with a value in `values` is replaced by it, escaped for
 * `language` (`yaml` / `json`: JSON-string-escaped without quotes, so a placeholder inside double
 * quotes stays one string; `text`: control characters become spaces). A placeholder whose value is
 * null or undefined stays as written and is listed in `unresolved` when `known` holds it; one not
 * in `known` stays as written and is not listed. Never runs code; deterministic.
 */
export function renderSetupGuideText(
  text: string,
  values: Readonly<Record<string, string | null | undefined>>,
  language: SetupGuideLanguage,
  known: readonly string[] = Object.keys(values),
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = text.replace(PLACEHOLDER_RE, (whole, name: string) => {
    if (!known.includes(name)) return whole;
    const v = Object.hasOwn(values, name) ? values[name] : undefined;
    if (v === null || v === undefined) {
      if (!unresolved.includes(name)) unresolved.push(name);
      return whole;
    }
    return escapeValue(v, language);
  });
  return { text: out, unresolved };
}

/**
 * Whether a guide's template file is usable: present, at most {@link SETUP_GUIDE_LIMITS}`.fileBytes`,
 * valid UTF-8 text without NUL. The problem (English, naming the path), or undefined when it is.
 * Shared by the packer and the kernel's package reader.
 */
export function setupGuideFileProblem(
  path: string,
  data: Uint8Array | undefined,
): string | undefined {
  if (data === undefined) return `${path} not found in the package`;
  if (data.byteLength > SETUP_GUIDE_LIMITS.fileBytes) {
    return `${path} is larger than ${SETUP_GUIDE_LIMITS.fileBytes} bytes`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return `${path} is not valid UTF-8 text`;
  }
  return text.includes("\u0000") ? `${path} is not a text file (it contains NUL)` : undefined;
}
