/**
 * Model-visible tool key grammar (aligned with Claude Code):
 *
 * - builtin: `^[A-Z][A-Za-z]{1,31}$` (PascalCase), e.g. `Edit`
 * - connector: `mcp__<slug>__<tool>`, e.g. `mcp__crm__search_accounts`
 * - extension: `plugin__<plugin>__<tool>`, e.g. `plugin__todo__write`
 *
 * Pure functions only; extensions that match keys (hooks) use `parseToolKey` instead of splitting.
 */

export type ParsedToolKey =
  | { kind: "builtin"; name: string }
  | { kind: "connector"; slug: string; tool: string }
  | { kind: "extension"; plugin: string; tool: string };

export const BUILTIN_TOOL_NAME_RE = /^[A-Z][A-Za-z]{1,31}$/;

const SEP = "__";

/** Parse a tool key; `null` when it fits none of the three forms. */
export function parseToolKey(key: string): ParsedToolKey | null {
  if (!key.includes(SEP)) {
    return BUILTIN_TOOL_NAME_RE.test(key) ? { kind: "builtin", name: key } : null;
  }
  const first = key.indexOf(SEP);
  const family = key.slice(0, first);
  if (family !== "mcp" && family !== "plugin") return null;
  const rest = key.slice(first + SEP.length);
  const second = rest.indexOf(SEP);
  if (second <= 0) return null;
  const owner = rest.slice(0, second);
  const tool = rest.slice(second + SEP.length);
  if (tool === "") return null;
  return family === "mcp"
    ? { kind: "connector", slug: owner, tool }
    : { kind: "extension", plugin: owner, tool };
}

/** `mcp__<slug>__<tool>` */
export function connectorToolKey(slug: string, tool: string): string {
  return `mcp${SEP}${slug}${SEP}${tool}`;
}

/** `plugin__<plugin>__<tool>` */
export function extensionToolKey(plugin: string, tool: string): string {
  return `plugin${SEP}${plugin}${SEP}${tool}`;
}
