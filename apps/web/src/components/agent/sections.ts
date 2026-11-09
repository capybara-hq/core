import type { FieldShape, FormSectionLayout, ItemShape } from "@capybara-hq/design";

/**
 * The agent page's sections (agent profile design §3.2), in nav order. The URL keeps the open one
 * as `/agents/<id>?s=<section>`; without `s` (or with an unknown one) the page opens `basics`.
 */
export const AGENT_SECTIONS = [
  "basics",
  "quick-actions",
  "prompt",
  "model",
  "tools",
  "skills",
  "subagents",
  "channels",
] as const;

export type AgentSection = (typeof AGENT_SECTIONS)[number];

/**
 * What someone who may use but not change the agent sees (§3.2, builder check B3), read-only:
 * the prompt files, tools, skills, sub-agents and channels stay hidden from them.
 */
export const READ_ONLY_SECTIONS: readonly AgentSection[] = ["basics", "quick-actions", "model"];

const isSection = (s: string): s is AgentSection =>
  (AGENT_SECTIONS as readonly string[]).includes(s);

/** An extension's section (`agent.detail.section`): `ext.<plugin>.<id>`. */
export type ExtSectionId = `ext.${string}.${string}`;

/** A built-in section or an extension's. */
export type AgentSectionId = AgentSection | ExtSectionId;

/** The `?s=` value of an extension's section. */
export const extSectionId = (c: { plugin: string; id: string }): ExtSectionId =>
  `ext.${c.plugin}.${c.id}`;

/** The sections the viewer's nav lists. */
export const sectionsFor = (editable: boolean): readonly AgentSection[] =>
  editable ? AGENT_SECTIONS : READ_ONLY_SECTIONS;

/**
 * The section `?s=` opens for this viewer: an unknown or hidden one opens `basics`; an extension's
 * (`ext.<plugin>.<id>`) only when `ext` (the viewer's `agent.detail.section` contributions) has it.
 */
export function sectionOf(
  s: string | undefined,
  editable: boolean,
  ext: readonly { plugin: string; id: string }[] = [],
): AgentSectionId {
  if (s === undefined) return "basics";
  if (s.startsWith("ext."))
    return ext.some((c) => extSectionId(c) === s) ? (s as ExtSectionId) : "basics";
  if (!isSection(s)) return "basics";
  return sectionsFor(editable).includes(s) ? s : "basics";
}

/** The built-in section a loading frame draws for `s` (an extension's section has none: basics). */
export const builtinSection = (s: AgentSectionId): AgentSection => (isSection(s) ? s : "basics");

/** The URL of a section of the agent page. */
export const sectionHref = (agentId: string, s: AgentSectionId) =>
  `/agents/${encodeURIComponent(agentId)}?s=${s}`;

/**
 * Each section's static field layout, for the template's loading state (`SettingsPage
 * loading.sections`), so the skeleton sits in the loaded section's boxes. Lists and checkbox
 * groups count as one field each.
 */
export const SECTION_FIELDS: Record<AgentSection, FieldShape[]> = {
  // the avatar tiles, name, description, visibility
  basics: [
    { control: "radios", options: 11 },
    { control: "input" },
    { control: "textarea", rows: 3 },
    { control: "select" },
  ],
  "quick-actions": [{ control: "item-group", options: 2 }],
  // the file list (one row: AGENTS.md) beside the open file's name and 16-line content
  prompt: [{ control: "list-editor", options: 1, rows: 16 }],
  model: [{ control: "select" }, { control: "select" }],
  tools: [{ control: "item-group", options: 2 }],
  skills: [{ control: "item-group", options: 2 }],
  subagents: [{ control: "item-group", options: 1 }],
  // not drawn: 渠道 has no card; it draws its own frame with skeleton cards (AgentChannels loading)
  channels: [],
};

/**
 * A section's loading layout: its fields, or, for a section whose card is a flush list of item
 * rows (FormSection `flush` + ItemList `inset="flush"`), those rows (`items`: the card goes flush).
 */
export type SectionShape = FieldShape[] | { items: ItemShape[] };

/**
 * The read-only variant's layout (key-value rows, or the quick actions: a flush card of item rows,
 * each a title over its body, as `QuickActionsReadOnly` draws them).
 */
export const READ_ONLY_FIELDS: Partial<Record<AgentSection, SectionShape>> = {
  basics: [{ control: "text" }, { control: "key-value" }],
  "quick-actions": { items: [{ lines: 2 }, { lines: 2 }] },
  model: [{ control: "key-value" }],
};

/**
 * The description a section's `FormSection` shows under its title, when it has one the page
 * knows before the data (its loading frame draws it for real): an `agents.page` message key.
 */
export const SECTION_DESCRIPTIONS: Partial<Record<AgentSection, "prompt.hint">> = {
  prompt: "prompt.hint",
};

/** Sections whose `FormSection` is stacked (the head above a full-width card): the editors. */
export const SECTION_LAYOUTS: Partial<Record<AgentSection, FormSectionLayout>> = {
  prompt: "stacked",
};
