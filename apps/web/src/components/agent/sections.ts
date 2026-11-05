import type { FieldShape, FormSectionLayout } from "@capybara-hq/design";

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

/** The sections the viewer's nav lists. */
export const sectionsFor = (editable: boolean): readonly AgentSection[] =>
  editable ? AGENT_SECTIONS : READ_ONLY_SECTIONS;

/** The section `?s=` opens for this viewer: an unknown or hidden one opens `basics`. */
export function sectionOf(s: string | undefined, editable: boolean): AgentSection {
  if (s === undefined || !isSection(s)) return "basics";
  return sectionsFor(editable).includes(s) ? s : "basics";
}

/** The URL of a section of the agent page. */
export const sectionHref = (agentId: string, s: AgentSection) =>
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
  "quick-actions": [{ control: "card-group", options: 2 }],
  // the file list (one row: AGENTS.md) beside the open file's name and 16-line content
  prompt: [{ control: "list-editor", options: 1, rows: 16 }],
  model: [{ control: "select" }, { control: "select" }],
  tools: [{ control: "card-group", options: 2 }],
  skills: [{ control: "card-group", options: 2 }],
  subagents: [{ control: "card-group", options: 1 }],
  channels: [{ control: "card-group", options: 1 }],
};

/** The read-only variant's field layout (key-value rows, or the quick-action cards). */
export const READ_ONLY_FIELDS: Partial<Record<AgentSection, FieldShape[]>> = {
  basics: [{ control: "text" }, { control: "key-value" }],
  "quick-actions": [{ control: "card-group", options: 2 }],
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
