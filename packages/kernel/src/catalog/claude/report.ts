/**
 * The translation report of a Claude Code plugin import (package ecosystem spec §8.4): every
 * component, field or file the allowlist translation did not take over unchanged becomes one item
 * with a reason, in five groups. The report is part of the one import review and of its
 * `reviewHash`; the web mirrors these types in `apps/web/src/lib/catalog.ts`.
 */

/** Report groups, in display order. */
export type TranslationGroup = "imported" | "converted" | "needsInput" | "ignored" | "warnings";

/** What an item is about. */
export type TranslationComponent =
  | "plugin"
  | "skill"
  | "command"
  | "agent"
  | "hook"
  | "mcpServer"
  | "field"
  | "file";

/** Why an item is in its group (one localized message per code in the web). */
export type TranslationCode =
  // imported
  | "skill_imported"
  | "agent_imported"
  // converted
  | "mcp_template"
  | "skill_root_relocated"
  | "version_from_entry"
  | "version_fallback"
  | "publisher_from_marketplace"
  | "dependency_mapped"
  | "entry_components_merged"
  | "agent_model_mapped"
  // needsInput
  | "mcp_header_variable"
  | "mcp_url_variable"
  | "dependency_not_imported"
  // ignored
  | "skill_manual_invocation"
  | "command_manual_invocation"
  | "skill_needs_subagents"
  /** Phase B only (agents were not imported); no longer emitted, kept for stored reports. */
  | "agent_needs_subagents"
  | "agent_invalid"
  | "agent_field_ignored"
  | "hooks_not_run"
  | "hooks_module"
  | "mcp_unsupported_transport"
  | "mcp_invalid"
  | "skill_invalid"
  | "not_applicable"
  | "unknown_field"
  | "other_harness"
  // warnings
  | "skill_ignored_restrictions"
  | "skill_claude_variables"
  | "session_start_pin_hint"
  | "mcp_auth_none"
  | "mcp_type_assumed"
  | "connector_not_loaded"
  | "agent_tools_unmapped"
  | "agent_skills_truncated";

/** One report item. */
export interface TranslationItem {
  group: TranslationGroup;
  component: TranslationComponent;
  /** Skill / server / hook event / field name. */
  name: string;
  /** Path relative to the plugin root, when the item is a file or directory. */
  path?: string;
  code: TranslationCode;
  /** Values for the localized message (e.g. { keys: "allowed-tools, model" }, { transport: "sse" }). */
  detail?: Record<string, string | number>;
}

/** The report of one translated plugin. */
export interface TranslationReport {
  format: "claude-code";
  /** `.claude-plugin/plugin.json`, or null when the tree has none. */
  manifestPath: string | null;
  /** The plugin has a SessionStart hook: the pinned suggestion is expanded by default (§8.4). */
  sessionStart: boolean;
  /** Items sorted by group order, then component, then name. At most {@link CLAUDE_REPORT_MAX_ITEMS} (then one "unknown_field" item named "…" with detail { more: n }). */
  items: TranslationItem[];
}

/** Most items a report keeps before the "{ more }" item. */
export const CLAUDE_REPORT_MAX_ITEMS = 500;

/** The group each code belongs to. */
export const TRANSLATION_CODE_GROUP: Readonly<Record<TranslationCode, TranslationGroup>> = {
  skill_imported: "imported",
  agent_imported: "imported",
  mcp_template: "converted",
  skill_root_relocated: "converted",
  version_from_entry: "converted",
  version_fallback: "converted",
  publisher_from_marketplace: "converted",
  dependency_mapped: "converted",
  entry_components_merged: "converted",
  agent_model_mapped: "converted",
  mcp_header_variable: "needsInput",
  mcp_url_variable: "needsInput",
  dependency_not_imported: "needsInput",
  skill_manual_invocation: "ignored",
  command_manual_invocation: "ignored",
  skill_needs_subagents: "ignored",
  agent_needs_subagents: "ignored",
  agent_invalid: "ignored",
  agent_field_ignored: "ignored",
  hooks_not_run: "ignored",
  hooks_module: "ignored",
  mcp_unsupported_transport: "ignored",
  mcp_invalid: "ignored",
  skill_invalid: "ignored",
  not_applicable: "ignored",
  unknown_field: "ignored",
  other_harness: "ignored",
  skill_ignored_restrictions: "warnings",
  skill_claude_variables: "warnings",
  session_start_pin_hint: "warnings",
  mcp_auth_none: "warnings",
  mcp_type_assumed: "warnings",
  connector_not_loaded: "warnings",
  agent_tools_unmapped: "warnings",
  agent_skills_truncated: "warnings",
};

const GROUP_ORDER: readonly TranslationGroup[] = [
  "imported",
  "converted",
  "needsInput",
  "ignored",
  "warnings",
];
const COMPONENT_ORDER: readonly TranslationComponent[] = [
  "plugin",
  "skill",
  "command",
  "agent",
  "hook",
  "mcpServer",
  "field",
  "file",
];

/**
 * Untrusted text made safe for terminals, logs and the web: C0, DEL and C1 control characters and
 * the bidirectional formatting characters (U+061C, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069)
 * become `?`.
 */
export const printable = (s: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are replaced
  s.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "?");

/**
 * Builds an item; the group follows from the code. The name, the path and every string detail
 * value pass through {@link printable}, so no route (a parser error, a template error, a file name)
 * can carry control or bidi characters into the report.
 */
export function item(
  code: TranslationCode,
  component: TranslationComponent,
  name: string,
  extra: { path?: string; detail?: Record<string, string | number> } = {},
): TranslationItem {
  const detail =
    extra.detail === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(extra.detail).map(([k, v]) => [
            k,
            typeof v === "string" ? printable(v) : v,
          ]),
        );
  return {
    group: TRANSLATION_CODE_GROUP[code],
    component,
    name: printable(name),
    ...(extra.path !== undefined && { path: printable(extra.path) }),
    code,
    ...(detail !== undefined && { detail }),
  };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sorts items by group order, component order, name, then path and code (code unit order, so the
 * order is stable across hosts), and caps them at {@link CLAUDE_REPORT_MAX_ITEMS}.
 */
export function sortItems(items: readonly TranslationItem[]): TranslationItem[] {
  const sorted = [...items].sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      COMPONENT_ORDER.indexOf(a.component) - COMPONENT_ORDER.indexOf(b.component) ||
      cmp(a.name, b.name) ||
      cmp(a.path ?? "", b.path ?? "") ||
      cmp(a.code, b.code),
  );
  if (sorted.length <= CLAUDE_REPORT_MAX_ITEMS) return sorted;
  const more = sorted.length - CLAUDE_REPORT_MAX_ITEMS;
  return [
    ...sorted.slice(0, CLAUDE_REPORT_MAX_ITEMS),
    item("unknown_field", "field", "…", { detail: { more } }),
  ];
}
