import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  appearanceIssues,
  CLIENT_API_VERSION,
  PLUGIN_MANIFEST_FILE,
  type PluginClientSection,
  type PluginManifest,
  UI_PARTS,
} from "@capybara-hq/plugin-sdk";
import { clientEntrySource, type PackRuleError } from "../pack/client.js";
import type { Finding } from "./source.js";

/**
 * The parts the host marks with `data-cap-part`: the names of the SDK's `UI_PARTS` catalog.
 */
export const KNOWN_UI_PARTS: readonly string[] = UI_PARTS.map((p) => p.name);

/** The finding a {@link PackRuleError} of the packer stands for (`client-size`, `client-undeclared`, …). */
export function ruleErrorFinding(file: string, e: PackRuleError): Finding {
  return { file, line: 1, rule: e.rule, message: e.message };
}

/** `client-api-version`: the packed client section was not built against the API this toolchain ships. */
export function clientApiVersionFindings(
  file: string,
  client: PluginClientSection | undefined,
): Finding[] {
  if (client === undefined || client.apiVersion === CLIENT_API_VERSION) return [];
  return [
    {
      file,
      line: 1,
      rule: "client-api-version",
      message: `the client section is built for apiVersion ${client.apiVersion}; the host supports ${CLIENT_API_VERSION}`,
    },
  ];
}

/** `appearance-invalid` for a suggested theme the plugin does not carry (after the theme scan). */
export function appearanceFindings(
  file: string,
  manifest: PluginManifest,
  themeIds: readonly string[],
): Finding[] {
  return appearanceIssues(manifest, themeIds).map((message) => ({
    file,
    line: 1,
    rule: "appearance-invalid",
    message,
  }));
}

const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

/** Blanks comments and string contents (keeping offsets and newlines) so scans do not trip on them. */
function blank(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (m) => m[0] + " ".repeat(m.length - 2) + m[0]);
}

interface Rule {
  selector: string;
  /** Offset of the selector in the text. */
  at: number;
  body: string;
}

/** Style rules (not at-rule preludes, not keyframe steps) of blanked CSS, nested blocks flattened. */
function styleRules(css: string): Rule[] {
  const rules: Rule[] = [];
  const walk = (from: number, to: number, keyframes: boolean): void => {
    let i = from;
    let start = from;
    while (i < to) {
      const c = css[i];
      if (c === ";") {
        start = i + 1;
        i++;
      } else if (c === "{") {
        let depth = 1;
        let j = i + 1;
        while (j < to && depth > 0) {
          if (css[j] === "{") depth++;
          else if (css[j] === "}") depth--;
          j++;
        }
        const prelude = css.slice(start, i);
        const trimmed = prelude.trim();
        const inner = css.slice(i + 1, j - 1);
        if (trimmed.startsWith("@")) {
          const isKeyframes = /^@(-\w+-)?keyframes\b/i.test(trimmed);
          if (!/^@(font-face|page|property|counter-style)\b/i.test(trimmed)) {
            walk(i + 1, j - 1, isKeyframes);
          }
        } else if (!keyframes && trimmed !== "") {
          rules.push({
            selector: trimmed,
            at: start + (prelude.length - prelude.trimStart().length),
            body: inner,
          });
          // nested rules (CSS nesting) are style rules too
          if (inner.includes("{")) walk(i + 1, j - 1, false);
        }
        start = j;
        i = j;
      } else i++;
    }
  };
  walk(0, css.length, false);
  return rules;
}

/** Splits a selector list at top-level commas. */
function selectorList(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * Why a selector is not built from what the client spec allows (§4.1): `[data-cap-part]`,
 * `[data-cap-state]`, the plugin's own classes (`cx-<plugin>-*`) and `:root`. Undefined when fine.
 */
function selectorProblem(selector: string, plugin: string): string | undefined {
  const own = `cx-${plugin}-`;
  // Attribute values (`[data-cap-part~="button.primary"]`) are not classes.
  const bare = selector.replace(/\[[^\]]*\]/g, "[]");
  const classes = [...bare.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] as string);
  const foreign = classes.find((c) => !c.startsWith(own));
  if (foreign !== undefined) return `uses the class .${foreign}`;
  if (/#[_a-zA-Z]/.test(selector.replace(/\[[^\]]*\]/g, ""))) return "uses an id";
  const anchored =
    /\[\s*data-cap-(part|state)\b/.test(selector) ||
    classes.length > 0 ||
    /(^|[\s>+~(])(:root|html)\b/.test(selector);
  return anchored
    ? undefined
    : "is not anchored on a [data-cap-part], [data-cap-state] or own class";
}

/** Names of the `[data-cap-part…=value]` values in a selector. */
function partValues(selector: string): string[] {
  const out: string[] = [];
  for (const m of selector.matchAll(
    /\[\s*data-cap-part\s*([~|^$*]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]+))/g,
  )) {
    const v = m[2] ?? m[3] ?? m[4] ?? "";
    out.push(
      ...v
        .trim()
        .split(/\s+/)
        .filter((x) => x !== ""),
    );
  }
  return out;
}

/**
 * The warnings of a plugin's client sources (client extensions spec §4.1; advice, not enforced):
 * `client-css-selector` for a selector in `client/styles/*.css` not built from `[data-cap-part]` /
 * `[data-cap-state]` / the plugin's own classes / `:root`, or a `:root` custom property not named
 * `--cx-<plugin>-*`; `ui-part-unknown` for a `data-cap-part` value (in a selector or in the entry
 * source) that is not in `parts`. With no known parts the second rule is silent.
 */
export function clientFindings(
  dir: string,
  styleNames: readonly string[],
  plugin: string,
  parts: readonly string[] = KNOWN_UI_PARTS,
): Finding[] {
  const out: Finding[] = [];
  const known = new Set(parts);
  const unknownPart = (file: string, line: number, value: string) => {
    if (known.size === 0 || known.has(value)) return;
    out.push({
      file,
      line,
      rule: "ui-part-unknown",
      message: `data-cap-part "${value}" is not a part of this host (known: ${[...known].join(", ")})`,
      severity: "warning",
    });
  };
  for (const name of styleNames) {
    const file = join(dir, "client/styles", name);
    const original = readFileSync(file, "utf8");
    const css = blank(original);
    for (const rule of styleRules(css)) {
      const line = lineAt(css, rule.at);
      // the selector text keeps its strings (the part names are in them)
      for (const sel of selectorList(original.slice(rule.at, rule.at + rule.selector.length))) {
        const problem = selectorProblem(sel, plugin);
        if (problem !== undefined) {
          out.push({
            file,
            line,
            rule: "client-css-selector",
            message: `selector "${sel}" ${problem}; style [data-cap-part], [data-cap-state] and cx-${plugin}-* classes`,
            severity: "warning",
          });
        }
        for (const v of partValues(sel)) unknownPart(file, line, v);
      }
      if (rule.selector.split(",").some((s) => /^(:root|html)$/.test(s.trim()))) {
        for (const m of rule.body.matchAll(/(?:^|[;{\s])(--[\w-]+)\s*:/g)) {
          const prop = m[1] as string;
          if (!prop.startsWith(`--cx-${plugin}-`)) {
            out.push({
              file,
              line,
              rule: "client-css-selector",
              message: `custom property ${prop} on :root is not named --cx-${plugin}-*`,
              severity: "warning",
            });
          }
        }
      }
    }
  }
  const entry = clientEntrySource(dir);
  if (entry !== undefined && known.size > 0) {
    const src = readFileSync(entry, "utf8");
    for (const m of src.matchAll(
      /data-cap-part\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*["'`]([^"'`]*)["'`]\s*\})/g,
    )) {
      for (const v of (m[1] ?? m[2] ?? m[3] ?? "").split(/\s+/).filter((x) => x !== "")) {
        unknownPart(entry, lineAt(src, m.index ?? 0), v);
      }
    }
  }
  return out;
}

/** The plugin name of a source dir's plugin.json (the `cx-<plugin>-` prefix), or undefined. */
export function pluginNameOf(dir: string): string | undefined {
  const file = join(dir, PLUGIN_MANIFEST_FILE);
  if (!existsSync(file)) return undefined;
  try {
    const name = (JSON.parse(readFileSync(file, "utf8")) as { name?: unknown }).name;
    return typeof name === "string" ? name : undefined;
  } catch {
    return undefined;
  }
}
