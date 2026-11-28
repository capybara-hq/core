import { projectFilePath } from "../devices/project-paths.js";

/** Marks each token's position in a message's `text` (U+FFFC, the object replacement character). */
export const TOKEN_MARKER = "￼";
export const MAX_TOKENS = 20;
export const MAX_CONNECTOR_MENTIONS = 3;
/** With tool search on, a mentioned connector offering at most this many tools has them loaded. */
export const MENTION_LOAD_MAX_TOOLS = 20;

const MAX_LABEL_POINTS = 80;
const MARKER_RE = new RegExp(TOKEN_MARKER, "g");
// invisible format characters, except the zero-width (non-)joiners that emoji and some scripts need
const FORMAT_CHARS = /(?![\u200C\u200D])\p{Cf}/gu;
// C0 and C1 control characters, DEL, and the Unicode line and paragraph separators
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it folds
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

export type MessageToken =
  | { type: "connector"; connectorId: string }
  | { type: "resource"; connectorId: string; uri: string }
  | { type: "file"; id: string }
  | { type: "projectFile"; path: string }
  | { type: "conversation"; id: string };

export type InlineRef =
  | { connectorId: string }
  | { connectorId: string; uri: string }
  | { fileId: string }
  | { path: string }
  | { id: string };

/** One token's placeholder in the rendered text: UTF-16 offsets covering the whole placeholder. */
export interface InlineEntry {
  kind: MessageToken["type"];
  start: number;
  end: number;
  label: string;
  ref: InlineRef;
}

export function countMarkers(text: string): number {
  let n = 0;
  for (let i = text.indexOf(TOKEN_MARKER); i !== -1; i = text.indexOf(TOKEN_MARKER, i + 1)) n++;
  return n;
}

/**
 * The identity of the entity a token names; a repeated entity counts and numbers once. A project
 * file path is normalized through `projectFilePath`, which throws an `ApiError`
 * `device.path_outside_project` for a path that is absolute, escapes the project, or names its root.
 */
export function tokenEntityKey(t: MessageToken): string {
  switch (t.type) {
    case "connector":
      return `connector:${t.connectorId}`;
    case "resource":
      return `resource:${t.connectorId}:${t.uri}`;
    case "file":
      return `file:${t.id}`;
    case "projectFile":
      return `projectFile:${projectFilePath(t.path)}`;
    case "conversation":
      return `conversation:${t.id}`;
  }
}

/**
 * A label safe inside a placeholder: control characters, line breaks and the token marker become
 * a space, other invisible format characters (Cf, except the zero-width joiners that emoji and
 * some scripts need) are dropped, square brackets become parentheses, trimmed, at most 80 code
 * points (then an ellipsis, after trimming the cut end).
 */
export function foldLabel(raw: string): string {
  const folded = raw
    .replace(CONTROLS, " ")
    .replace(MARKER_RE, " ")
    .replace(FORMAT_CHARS, "")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .trim();
  const points = Array.from(folded);
  return points.length > MAX_LABEL_POINTS
    ? `${points.slice(0, MAX_LABEL_POINTS).join("").trimEnd()}…`
    : folded;
}

/**
 * Numbers colliding labels: the first entity (by first appearance) keeps its label, a second
 * different entity with the same label gets " (2)", the third " (3)"; a numbered label that is
 * itself taken by another entity skips to the next free number. A repeated key keeps its first
 * label. Callers number per kind, passing file tokens before uploads.
 */
export function numberLabels(items: { key: string; label: string }[]): Map<string, string> {
  const out = new Map<string, string>();
  const used = new Set<string>();
  const next = new Map<string, number>();
  // plain labels are claimed first-come, so a later entity's real label is never numbered away
  for (const { key, label } of items) {
    if (out.has(key)) continue;
    if (!used.has(label)) {
      used.add(label);
      out.set(key, label);
      continue;
    }
    let n = next.get(label) ?? 2;
    while (used.has(`${label} (${n})`)) n++;
    next.set(label, n + 1);
    const numbered = `${label} (${n})`;
    used.add(numbered);
    out.set(key, numbered);
  }
  return out;
}

export function placeholder(
  kind: MessageToken["type"],
  label: string,
  connectorLabel?: string,
): string {
  switch (kind) {
    case "connector":
      return `[connector: ${label}]`;
    case "resource":
      return `[resource: ${label} from ${connectorLabel ?? ""}]`;
    case "file":
      return `[file: ${label}]`;
    case "projectFile":
      return `[project file: ${label}]`;
    case "conversation":
      return `[conversation: ${label}]`;
  }
}

function refOf(t: MessageToken): InlineRef {
  switch (t.type) {
    case "connector":
      return { connectorId: t.connectorId };
    case "resource":
      return { connectorId: t.connectorId, uri: t.uri };
    case "file":
      return { fileId: t.id };
    case "projectFile":
      return { path: t.path };
    case "conversation":
      return { id: t.id };
  }
}

/**
 * Replaces each marker with its token's placeholder. `labelOf` gives the (already folded and
 * numbered) label. Throws when the marker count differs from `tokens.length`; the controller
 * validates that first, so this is a guard.
 */
export function renderInline(
  text: string,
  tokens: readonly MessageToken[],
  labelOf: (t: MessageToken) => string,
  connectorLabelOf: (connectorId: string) => string,
): { text: string; inline: InlineEntry[] } {
  const parts = text.split(TOKEN_MARKER);
  if (parts.length - 1 !== tokens.length) {
    throw new Error(
      `renderInline: ${parts.length - 1} markers in text but ${tokens.length} tokens`,
    );
  }
  let out = parts[0] ?? "";
  const inline: InlineEntry[] = [];
  tokens.forEach((t, i) => {
    const label = labelOf(t);
    const ph = placeholder(
      t.type,
      label,
      t.type === "resource" ? connectorLabelOf(t.connectorId) : undefined,
    );
    inline.push({
      kind: t.type,
      start: out.length,
      end: out.length + ph.length,
      label,
      ref: refOf(t),
    });
    out += ph + (parts[i + 1] ?? "");
  });
  return { text: out, inline };
}

/** The connector mention block text; the last sentence is decided at send time. */
export function connectorMentionText(m: {
  label: string;
  name: string;
  slug: string;
  toolCount: number;
  toolSearch: boolean;
}): string {
  const head = `${placeholder("connector", m.label)} The person named the connector "${m.name}" for this message. Its tools are named mcp__${m.slug}__<tool>.`;
  if (!m.toolSearch) return head;
  return m.toolCount <= MENTION_LOAD_MAX_TOOLS
    ? `${head} Its ${m.toolCount} tools are loaded from this message on.`
    : `${head} It has ${m.toolCount} tools; load the ones this message needs with ToolSearch.`;
}

/** The text block that precedes each file's media block. */
export function fileLine(label: string): string {
  return placeholder("file", label);
}
