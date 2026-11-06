import type { PresetId } from "@capybara-hq/design";
import type { Agent, AgentVisibility } from "./agents";
import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/**
 * Creating an agent from a template (rulings P4-3…P4-5, P4-18): the preview says what carries over
 * and gives the hash the create sends back; a changed plan answers 409
 * `agent.template_preview_stale`.
 */

/** 带入 / 待配置 / 不可用 (kernel `PlanItemState`). */
export type PlanItemState = "carried" | "pending" | "unavailable";

export type PlanItemKind =
  | "instruction_file"
  | "description"
  | "quick_action"
  | "tool"
  | "skill"
  | "connector"
  | "subagent";

/** One line of the preview (kernel `PlanItem`); `reason` is a code the dialog words. */
export interface PlanItem {
  kind: PlanItemKind;
  name: string;
  state: PlanItemState;
  reason?: string;
}

/** Where the preselected model comes from (P4-4). */
export type ModelSource = "modelRef" | "tier" | "default" | "chosen";

export interface TemplatePreview {
  items: PlanItem[];
  /** The automatic choice the dialog preselects; null when the org has no usable model. */
  model: (ModelRef & { source: ModelSource }) | null;
  /** Template fields with no place in the agent or cut to its limits (paths, see `droppedLine`). */
  dropped: string[];
  previewHash: string;
}

export interface CreateFromTemplateInput {
  templateId: string;
  name: string;
  /** Absent = private; another one needs `agents.manage` (403 `agent.visibility_forbidden`). */
  visibility?: AgentVisibility;
  members?: string[];
  /** Sent only when the person changed the preselected model. */
  model?: ModelRef;
  avatar?: { kind: "preset"; id: PresetId };
  previewHash: string;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/agents/from-template`;

export const previewFromTemplate = (orgId: string, templateId: string) =>
  apiFetch<TemplatePreview>(`${base(orgId)}/preview`, {
    method: "POST",
    body: JSON.stringify({ templateId }),
  });

export const createFromTemplate = (orgId: string, input: CreateFromTemplateInput) =>
  apiFetch<{ agent: Agent }>(base(orgId), { method: "POST", body: JSON.stringify(input) });

/** The preview's items by state, in the kernel's order. */
export function groupItems(items: readonly PlanItem[]): Record<PlanItemState, PlanItem[]> {
  const out: Record<PlanItemState, PlanItem[]> = { carried: [], pending: [], unavailable: [] };
  for (const i of items) out[i.state].push(i);
  return out;
}

/**
 * Each item with its identity across two previews: kind, name and its occurrence among items of
 * the same kind and name (two connectors with one label stay two items).
 */
function keyed(items: readonly PlanItem[]): [string, PlanItem][] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const base = `${i.kind}\u0000${i.name}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return [`${base}\u0000${n}`, i];
  });
}

/**
 * What changed between the preview the person saw and a fresh one (after a 409 stale): items that
 * appeared, went away, or moved to another state (with the old state), and dropped entries added
 * or gone.
 */
export interface PreviewChange {
  added: PlanItem[];
  removed: PlanItem[];
  moved: { item: PlanItem; from: PlanItemState }[];
  droppedAdded: string[];
  droppedRemoved: string[];
  modelChanged: boolean;
}

export function previewChanges(before: TemplatePreview, after: TemplatePreview): PreviewChange {
  const beforeKeyed = keyed(before.items);
  const afterKeyed = keyed(after.items);
  const old = new Map(beforeKeyed);
  const now = new Map(afterKeyed);
  const added = afterKeyed.filter(([k]) => !old.has(k)).map(([, i]) => i);
  const removed = beforeKeyed.filter(([k]) => !now.has(k)).map(([, i]) => i);
  const moved = afterKeyed.flatMap(([k, i]) => {
    const o = old.get(k);
    return o !== undefined && o.state !== i.state ? [{ item: i, from: o.state }] : [];
  });
  const m = (p: TemplatePreview) =>
    p.model === null ? "" : `${p.model.provider}/${p.model.model}`;
  return {
    added,
    removed,
    moved,
    droppedAdded: after.dropped.filter((d) => !before.dropped.includes(d)),
    droppedRemoved: before.dropped.filter((d) => !after.dropped.includes(d)),
    modelChanged: m(before) !== m(after),
  };
}

export const hasChanges = (c: PreviewChange): boolean =>
  c.added.length + c.removed.length + c.moved.length > 0 ||
  c.droppedAdded.length + c.droppedRemoved.length > 0 ||
  c.modelChanged;

/**
 * A dropped entry as a message key and its values (`agents.fromTemplate.dropped.<key>`): the
 * kernel's paths (`maxSteps`, `effort`, `description`, `instructions`, `quickActions.<i>.title`,
 * `instructionFiles.<i>.content`, `subagents.inline.<name>.description|instructions`,
 * `subagents.inline.<name>.tools.<key>`, `connectors.<key>.tools|policies.<name>`); anything else
 * is `other` with the path. A connector is named by `connectorName` (its key `connector-<n>` is
 * the kernel's, never shown).
 */
export function droppedLine(
  path: string,
  connectorName: (key: string) => string = (k) => k,
): { key: string; values: Record<string, string> } {
  if (path === "maxSteps" || path === "effort" || path === "description") {
    return { key: path, values: {} };
  }
  if (path === "instructions") return { key: "instructions", values: {} };
  let m = /^quickActions\.(\d+)\.(title|body)$/.exec(path);
  if (m) return { key: `quickAction_${m[2]}`, values: { n: String(Number(m[1]) + 1) } };
  m = /^instructionFiles\.(\d+)\.content$/.exec(path);
  if (m) return { key: "instructionFile", values: { n: String(Number(m[1]) + 1) } };
  m = /^subagents\.inline\.(.+)\.(description|instructions)$/.exec(path);
  if (m) return { key: `subagent_${m[2]}`, values: { name: m[1] as string } };
  m = /^subagents\.inline\.(.+)\.tools\.(.+)$/.exec(path);
  if (m) return { key: "subagentTool", values: { name: m[1] as string, tool: m[2] as string } };
  m = /^connectors\.([^.]+)\.(tools|policies)\.(.+)$/.exec(path);
  if (m) {
    return {
      key: m[2] === "tools" ? "connectorTool" : "connectorPolicy",
      values: { connector: connectorName(m[1] as string), tool: m[3] as string },
    };
  }
  return { key: "other", values: { path } };
}

/**
 * The name of a template's connector entry by its pending key `connector-<n>`: the kernel lists one
 * `connector` item per entry, in the template's order, so the n-th one names it; the key itself
 * only when the preview has no such item.
 */
export function connectorNamer(items: readonly PlanItem[]): (key: string) => string {
  const connectors = items.filter((i) => i.kind === "connector");
  return (key) => {
    const m = /^connector-(\d+)$/.exec(key);
    const item = m ? connectors[Number(m[1]) - 1] : undefined;
    return item?.name ?? key;
  };
}

/** The reason codes the dialog words (`agents.fromTemplate.reasons.<kind>_<reason>`). */
export const ITEM_REASONS: Readonly<Record<PlanItemKind, readonly string[]>> = {
  instruction_file: ["invalid_name", "duplicate", "too_many", "too_long"],
  description: [],
  quick_action: [],
  tool: ["default", "subagents", "plugin_unavailable", "unknown_tool", "connector_key"],
  skill: ["pinned", "not_pinned_manual_only", "not_pinned_too_large", "subagent", "not_found"],
  connector: [
    "several",
    "no_connector",
    "tools_missing",
    "needs",
    "template_not_found",
    "disallowed",
  ],
  subagent: ["type_not_found", "type_taken", "too_many"],
};

/** The message key of an item's reason, null when it has none or one this app doesn't know. */
export const reasonKey = (i: PlanItem): string | null =>
  i.reason !== undefined && ITEM_REASONS[i.kind].includes(i.reason)
    ? `${i.kind}_${i.reason}`
    : null;
