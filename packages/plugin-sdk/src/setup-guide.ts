/**
 * Plugin setup guides v2 (spec `2026-11-09-setup-guides-v2-design.md`): Markdown documents a plugin
 * ships (`guides/<id>.md`, optional `guides/<id>.zh.md`) that the kernel renders for a place with a
 * fixed set of safe, deterministic variables, mode and audience sections and live check rows. The
 * declaration lives in `plugin.json` `setupGuides` ({@link PluginSetupGuide}); this module holds the
 * place registry, the limits, the validator and the drift hash. The parser is
 * `setup-guide-parse.ts`, the renderer `setup-guide-render.ts`.
 *
 * Variables are `{{name}}` (spaces inside the braces allowed) with `name` matching
 * `[A-Za-z][A-Za-z0-9]*`. There is no other template syntax.
 */
import { createHash } from "node:crypto";
import type { Nodes } from "mdast";
import {
  analyzeSetupGuide,
  checkMarkerIndex,
  ENCODED_SENTINEL_RE,
  lineSelected,
  normalizeGuideSource,
  type ParsedSetupGuide,
  parseGuideMarkdown,
  preparedGuideText,
  SENTINEL_RE,
  type SetupGuideParseIssue,
  scanGuide,
  visitGuide,
} from "./setup-guide-parse.js";

/**
 * Where a guide is shown. `channel-connection`: 新建渠道 and the channel detail page;
 * `connector-template`: the pages of a connector template and the connectors made from it.
 */
export const SETUP_GUIDE_PLACES = ["channel-connection", "connector-template"] as const;
export type SetupGuidePlace = (typeof SETUP_GUIDE_PLACES)[number];

/** Who the rendered text is for: `admin` sets the integration up, `member` uses it. */
export type SetupGuideAudience = "admin" | "member";

/**
 * The type of a variable: `url` values are built by the kernel from deployment settings and ids,
 * `text` values hold whatever a person typed (names), `token` values are ids and enum values.
 */
export type SetupGuideVariableType = "url" | "text" | "token";

/** What a place defines: its modes, audiences and variables, and whether its targets record acks. */
export interface SetupGuidePlaceInfo {
  modes: readonly string[];
  audiences: readonly SetupGuideAudience[];
  variables: Readonly<Record<string, SetupGuideVariableType>>;
  drift: boolean;
}

const COMMON_VARIABLES = {
  publicUrl: "url",
  orgName: "text",
  pluginName: "token",
  pluginVersion: "token",
  mode: "token",
} as const satisfies Record<string, SetupGuideVariableType>;

/** The place registry. None of the variables is a secret. */
export const SETUP_GUIDE_PLACE_INFO: Readonly<Record<SetupGuidePlace, SetupGuidePlaceInfo>> = {
  "channel-connection": {
    modes: ["long_connection", "webhook"],
    audiences: ["admin"],
    variables: {
      ...COMMON_VARIABLES,
      webhookUrl: "url",
      signInCallbackUrl: "url",
      connectionName: "text",
    },
    drift: true,
  },
  "connector-template": {
    modes: [],
    audiences: ["admin", "member"],
    variables: {
      ...COMMON_VARIABLES,
      oauthCallbackUrl: "url",
      signInCallbackUrl: "url",
      templateId: "token",
      templateName: "text",
      connectorName: "text",
    },
    drift: true,
  },
};

/** Limits of setup guides. */
export const SETUP_GUIDE_LIMITS = {
  /** Guides per plugin. */
  guides: 8,
  /** Bytes per document (each language). */
  docBytes: 65536,
  /** Fenced code blocks per document. */
  codeBlocks: 24,
  /** Check lines per document. */
  checks: 16,
  /** Sections per document. */
  sections: 16,
  /** Characters of the title and of a heading. */
  titleChars: 100,
  /** Characters of a check label. */
  checkLabelChars: 80,
  /** Characters of a code fence title. */
  fenceTitleChars: 100,
  /** Markdown nesting depth. */
  depth: 16,
} as const;

/** A setup guide in `plugin.json` `setupGuides`. */
export interface PluginSetupGuide {
  /** `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the plugin; the documents are `guides/<id>.md`. */
  id: string;
  place: SetupGuidePlace;
  /** Only and required for `connector-template`: one of the plugin's connector template ids. */
  template?: string;
}

/** The package path of a guide's document: `guides/<id>.md` (en) or `guides/<id>.zh.md` (zh). */
export function setupGuideDocPath(id: string, locale: "en" | "zh"): string {
  return locale === "zh" ? `guides/${id}.zh.md` : `guides/${id}.md`;
}

/**
 * Whether a guide document is usable as a file: present, at most
 * {@link SETUP_GUIDE_LIMITS}`.docBytes`, valid UTF-8 without NUL and without U+E000–U+E0FF. The
 * problem (English, naming the path), or undefined. Shared by the packer and the kernel's reader.
 */
export function setupGuideDocProblem(
  path: string,
  data: Uint8Array | undefined,
): string | undefined {
  if (data === undefined) return `${path} not found in the package`;
  if (data.byteLength > SETUP_GUIDE_LIMITS.docBytes) {
    return `${path} is larger than ${SETUP_GUIDE_LIMITS.docBytes} bytes`;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return `${path} is not valid UTF-8 text`;
  }
  if (text.includes("\u0000")) return `${path} is not a text file (it contains NUL)`;
  if (/[-]/.test(text)) {
    return `${path} contains a private-use character (U+E000–U+E0FF), which guides may not use`;
  }
  return undefined;
}

/** A problem {@link validateSetupGuide} found. */
export interface SetupGuideIssue {
  level: "error" | "warning";
  message: string;
}

const QUOTING_LANGUAGES = new Set(["yaml", "yml", "json"]);

const firstUrlSentinel = /^(?:|%EE%80%80)(\d+)(?:|%EE%80%81)/i;
const hasSentinel = (s: string | null | undefined) =>
  s !== null &&
  s !== undefined &&
  (new RegExp(SENTINEL_RE.source).test(s) || new RegExp(ENCODED_SENTINEL_RE.source, "i").test(s));
const sentinelIndexes = (s: string): number[] => [
  ...[...s.matchAll(SENTINEL_RE)].map((m) => Number(m[1])),
  ...[...s.matchAll(ENCODED_SENTINEL_RE)].map((m) => Number(m[1])),
];

/**
 * Validates a guide's documents for a place (spec §4.5): title, sections well formed and known to
 * the place, check lines, fence info strings, no indented code, limits, variables known to the place
 * and allowed where they stand (§6.2), language parity of the zh document (§4.3), and, when
 * `pluginChecks` is given, that every plugin check id is declared there (the extension's
 * `permissions.setupChecks`). Messages name the file (`guides/<id>.md` when `id` is given) and line.
 * `allowUnknownVariables` (the kernel's importer) accepts variables the place does not define: they
 * render as written. Pure.
 */
export function validateSetupGuide(input: {
  place: SetupGuidePlace;
  en: string;
  zh?: string;
  pluginChecks?: readonly string[];
  /** The guide id, to name the files in messages. */
  id?: string;
  allowUnknownVariables?: boolean;
}): SetupGuideIssue[] {
  const info = SETUP_GUIDE_PLACE_INFO[input.place];
  const fileOf = (locale: "en" | "zh") =>
    input.id !== undefined
      ? setupGuideDocPath(input.id, locale)
      : locale === "en"
        ? "the English document"
        : "the Chinese document";
  const out: SetupGuideIssue[] = [];
  const parsedBy: Partial<Record<"en" | "zh", ParsedSetupGuide>> = {};

  const one = (locale: "en" | "zh", source: string) => {
    const file = fileOf(locale);
    const push = (i: SetupGuideParseIssue) =>
      out.push({
        level: i.level,
        message: i.line !== undefined ? `${file}:${i.line}: ${i.message}` : `${file}: ${i.message}`,
      });
    const bytes = new TextEncoder().encode(source).byteLength;
    if (bytes > SETUP_GUIDE_LIMITS.docBytes) {
      push({ level: "error", message: `is larger than ${SETUP_GUIDE_LIMITS.docBytes} bytes` });
      return;
    }
    const { parsed, scan, tree, uses } = analyzeSetupGuide(source);
    parsedBy[locale] = parsed;
    const issues: SetupGuideParseIssue[] = [...parsed.issues];
    const err = (line: number | undefined, message: string, level: "error" | "warning" = "error") =>
      issues.push({ level, ...(line !== undefined && { line }), message });

    for (const s of parsed.sections) {
      if (s.type === "mode" && !info.modes.includes(s.value)) {
        err(
          s.line,
          info.modes.length === 0
            ? `place ${input.place} has no modes`
            : `mode "${s.value}" is not one of the modes of place ${input.place}: ${info.modes.join(", ")}`,
        );
      }
      if (s.type === "audience" && !(info.audiences as readonly string[]).includes(s.value)) {
        err(
          s.line,
          `audience "${s.value}" is not one of the audiences of place ${input.place}: ${info.audiences.join(", ")}`,
        );
      }
    }
    if (input.pluginChecks !== undefined) {
      for (const c of parsed.checks) {
        if (c.source === "plugin" && !input.pluginChecks.includes(c.id)) {
          err(c.line, `check ${c.id} is not declared in the extension's permissions.setupChecks`);
        }
      }
    }
    // a check id twice in one rendering
    const dupes = new Set<string>();
    for (const mode of [null, ...info.modes]) {
      for (const audience of info.audiences) {
        const seen = new Set<string>();
        parsed.checks.forEach((c) => {
          if (!lineSelected(scan, c.line - 1, mode, audience)) return;
          if (seen.has(c.id) && !dupes.has(c.id)) {
            dupes.add(c.id);
            err(c.line, `check ${c.id} appears twice in one rendering of the guide`);
          }
          seen.add(c.id);
        });
      }
    }

    // variables: known to the place, and allowed where they stand
    const reported = new Set<string>();
    for (const u of uses) {
      if (Object.hasOwn(info.variables, u.name) || input.allowUnknownVariables === true) continue;
      if (reported.has(u.name)) continue;
      reported.add(u.name);
      err(
        u.line,
        `unknown variable {{${u.name}}} for place ${input.place} (known: ${Object.keys(info.variables).join(", ")})`,
      );
    }
    const typeOf = (n: number) => {
      const name = uses[n]?.name;
      return name === undefined ? undefined : info.variables[name];
    };
    const nameOf = (n: number) => `{{${uses[n]?.name ?? "?"}}}`;
    const checkDestination = (url: string, line: number | undefined) => {
      const all = sentinelIndexes(url);
      if (all.length === 0) return;
      const m = firstUrlSentinel.exec(url);
      const ok = m !== null && all.length === 1 && typeOf(Number(m[1])) === "url";
      if (!ok) {
        err(
          line,
          `${all.map(nameOf).join(", ")} in a link destination: only a url variable may stand there, at its start`,
        );
      }
    };
    visitGuide(tree, (node: Nodes) => {
      const line = node.position?.start.line;
      switch (node.type) {
        case "code": {
          const lang = (node.lang ?? "").toLowerCase();
          if (QUOTING_LANGUAGES.has(lang)) {
            // values are JSON-escaped without the quotes: only safe inside a "…" string
            for (const lineText of node.value.split("\n")) {
              for (const m of lineText.matchAll(SENTINEL_RE)) {
                const n = Number(m[1]);
                if (typeOf(n) !== "text") continue;
                const before = lineText.slice(0, m.index).replace(/\\./g, "");
                if ((before.match(/"/g)?.length ?? 0) % 2 === 1) continue;
                err(
                  line,
                  `the text variable ${nameOf(n)} in a ${lang} code block is not inside double quotes; its value is escaped as a string and may break the block or change its type ("${nameOf(n)}")`,
                  "warning",
                );
              }
            }
            return;
          }
          for (const n of sentinelIndexes(node.value)) {
            if (typeOf(n) === "text") {
              err(
                line,
                `the text variable ${nameOf(n)} in a ${lang || "plain"} code block is not quoted; a value with spaces or quotes may break it (use a yaml or json block with "${nameOf(n)}")`,
                "warning",
              );
            }
          }
          return;
        }
        case "link":
        case "definition":
          checkDestination(node.url, line);
          if (hasSentinel(node.title)) err(line, "variables are not allowed in a link title");
          return;
        case "image":
        case "imageReference":
          if (
            hasSentinel(node.alt) ||
            (node.type === "image" && (hasSentinel(node.url) || hasSentinel(node.title)))
          ) {
            err(line, "variables are not allowed in an image");
          }
          return;
        default:
          return;
      }
    });
    issues.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
    issues.forEach(push);
  };

  one("en", input.en);
  if (input.zh !== undefined) one("zh", input.zh);

  const en = parsedBy.en;
  const zh = parsedBy.zh;
  if (en !== undefined && zh !== undefined) {
    const enFile = fileOf("en");
    const zhFile = fileOf("zh");
    const sec = (p: ParsedSetupGuide) =>
      JSON.stringify(p.sections.map((s) => [s.type, s.value, s.parent]));
    if (sec(en) !== sec(zh)) {
      out.push({
        level: "error",
        message: `${zhFile}: the sections differ from ${enFile}; both languages need the same sections in the same order`,
      });
    }
    const chk = (p: ParsedSetupGuide) => JSON.stringify(p.checks.map((c) => [c.section, c.id]));
    if (chk(en) !== chk(zh)) {
      out.push({
        level: "error",
        message: `${zhFile}: the checks differ from ${enFile}; both languages need the same check ids in the same sections`,
      });
    }
    if (en.codeBlocks.length !== zh.codeBlocks.length) {
      out.push({
        level: "error",
        message: `${zhFile}: has ${zh.codeBlocks.length} code blocks and ${enFile} has ${en.codeBlocks.length}; code blocks must be identical in every language`,
      });
    } else {
      en.codeBlocks.forEach((e, i) => {
        const z = zh.codeBlocks[i];
        if (z === undefined) return;
        const n = i + 1;
        const name = `code block ${n}${z.title !== null ? ` ("${z.title}")` : ""}`;
        if (z.section !== e.section) {
          out.push({
            level: "error",
            message: `${zhFile}: ${name} is in another section than ${enFile} block ${n}; code blocks must be identical in every language`,
          });
          return;
        }
        if (z.language === e.language && z.text === e.text) return;
        if (z.language !== e.language) {
          out.push({
            level: "error",
            message: `${zhFile}: ${name} is ${z.language || "without a language"} but ${enFile} block ${n} is ${e.language || "without a language"}; code blocks must be identical in every language`,
          });
          return;
        }
        const el = e.text.split("\n");
        const zl = z.text.split("\n");
        let line = 0;
        while (line < el.length && line < zl.length && el[line] === zl[line]) line++;
        out.push({
          level: "error",
          message: `${zhFile}: ${name} differs from ${enFile} block ${n} at line ${line + 1}; code blocks must be identical in every language`,
        });
      });
    }
  }
  return out;
}

/**
 * The drift hash of a guide for one mode and audience (spec §11): sha256 (hex) over the place, guide
 * id, mode and audience, then, in document order after section selection, each fenced code block
 * (language and text, title excluded) and each check id of the English document. Variables are not
 * substituted; line endings are normalized. Prose, headings and check labels do not move it.
 */
export function setupGuideHash(
  enSource: string,
  input: {
    place: SetupGuidePlace;
    guideId: string;
    mode: string | null;
    audience: SetupGuideAudience;
  },
): string {
  const scan = scanGuide(normalizeGuideSource(enSource));
  const tree = parseGuideMarkdown(
    preparedGuideText(scan, (i) => lineSelected(scan, i, input.mode, input.audience)),
  );
  const h = createHash("sha256");
  h.update(
    `capybara-guide-v2\0${input.place}\0${input.guideId}\0${input.mode ?? ""}\0${input.audience}\0`,
  );
  visitGuide(tree, (node) => {
    if (node.type === "code") {
      h.update(`code\0${node.lang ?? ""}\0${node.value}\0`);
      return;
    }
    const c = checkMarkerIndex(node);
    if (c !== undefined) h.update(`check\0${scan.checks[c]?.id ?? ""}\0`);
  });
  return h.digest("hex");
}
