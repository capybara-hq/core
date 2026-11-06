// Creating an agent from a template (plugin scope phase 4, rulings P4-3…P4-6, P4-8): what a
// template carries into a new agent, resolved against the org's state at preview and again at
// create. Pure resolution over read snapshots: the database reads go through `db`, the replica's
// extension state and the model lookups through `opts`; nothing is written here.
import { createHash } from "node:crypto";
import {
  type AgentTemplate,
  type AgentTemplateTier,
  type ConnectorTemplateFile,
  connectorToolKey,
  extensionToolKey,
  type ModelParameter,
  parseToolKey,
  SKILL_ENTRY_FILE,
  validateParams,
} from "@capybara-hq/plugin-sdk";
import type { KernelSchemaDb } from "../db/kernel-schema.js";
import { invocationOf, PINNED_SKILLS_LIMITS } from "../skills/catalog.js";
import { type SkillVersionRow, usableSkillVersions } from "../skills/usable.js";
import { CONTROL_OR_HIDDEN_RE } from "../text.js";
import {
  AGENT_TOOL,
  BASH_COMPANION_TOOLS,
  BUILTIN,
  BUILTIN_TOOL_NAMES,
  DEFAULT_AGENT_TOOLS,
} from "../tools/builtin-names.js";
import { canonicalJson } from "../tools/canonical-json.js";
import {
  AgentDefinitionSchema,
  type AgentToolRef,
  type InlineAgentTemplate,
  type ModelParams,
  type ModelRef,
  type PendingConnector,
  SUBAGENT_NAME_RE,
  SUBAGENT_ROSTER_MAX,
  type Subagents,
} from "./definition.js";
import {
  type AgentDefinitionInput,
  INSTRUCTION_FILE_LIMITS,
  INSTRUCTION_FILE_NAME_RE,
  type InstructionFile,
  joinInstructionFiles,
} from "./instruction-files.js";
import { PROFILE_LIMITS, ProfileInputSchema, type QuickAction } from "./profile.js";
import { type TemplateRow, templateTypeOf, usableTemplates } from "./templates.js";

/** What the preview lists (P4-5): 带入 / 待配置 / 不可用. */
export type PlanItemState = "carried" | "pending" | "unavailable";

export type PlanItemKind =
  | "instruction_file"
  | "description"
  | "quick_action"
  | "tool"
  | "skill"
  | "connector"
  | "subagent";

/**
 * One line of the preview. `reason` (a code) says why an item is pending or unavailable, and
 * qualifies some carried ones:
 * - instruction_file: unavailable `invalid_name`, `duplicate`, `too_many`, `too_long` (the joined
 *   files exceed the agent's limit);
 * - tool: `default` (the template names no tools: the defaults of a new agent), `subagents`
 *   (`Agent` added because the template describes sub-agents); unavailable `plugin_unavailable`
 *   (its plugin is not enabled in the org or not loaded), `unknown_tool`, `connector_key` (a
 *   connector tool key: connectors carry over only through `connectors` entries);
 * - skill: `pinned`, `not_pinned_manual_only`, `not_pinned_too_large`, `subagent` (named only by an
 *   inline sub-agent); unavailable `not_found`;
 * - connector: `several` (the first of several connectors made from the template was bound);
 *   pending `no_connector`, `tools_missing` (the connector made from the template lacks every
 *   named tool), `needs`; unavailable `template_not_found`, `disallowed` (`disallowedTools` left
 *   none of its tools);
 * - subagent: unavailable `type_not_found`, `type_taken`, `too_many`.
 */
export interface PlanItem {
  kind: PlanItemKind;
  name: string;
  state: PlanItemState;
  reason?: string;
}

/** Where the chosen model comes from (P4-4). */
export type ModelSource = "modelRef" | "tier" | "default" | "chosen";

export interface PlannedModel {
  ref: ModelRef;
  params: ModelParams;
  source: ModelSource;
}

/** The template's agent definition, without its model (chosen separately, P4-4). */
export type PlannedDefinition = Omit<AgentDefinitionInput, "model" | "modelParams">;

export interface TemplatePlan {
  definition: PlannedDefinition;
  /** The profile's description and quick actions. */
  profile: { description: string; quickActions: QuickAction[] };
  /** The model the new agent gets (`opts.model` when given); null when the org has none. */
  model: PlannedModel | null;
  /** The automatic choice (P4-4), whatever `opts.model` is; what the dialog preselects. */
  auto: PlannedModel | null;
  items: PlanItem[];
  /**
   * What has no place in the agent or was cut to its limits: `maxSteps`, `effort` when the model
   * does not declare it, `description` / `instructions` / `quickActions.<i>.title|body` /
   * `instructionFiles.<i>.content` / `subagents.inline.<name>.description|instructions` when cut to
   * the kernel's limits (UTF-16 units), `subagents.inline.<name>.tools.<key>` for a key the agent
   * does not have, `connectors.<key>.tools.<name>` / `connectors.<key>.policies.<name>` for a tool
   * the bound connector does not offer.
   */
  dropped: string[];
  /** sha256 of the template id and version and everything resolved except the model. */
  baseHash: string;
  /** The first 16 hex digits of sha256 of the automatic model choice (ref and params). */
  modelHash: string;
  /** The preview hash: `<baseHash>.<modelHash>`. */
  hash: string;
}

export interface PlanOptions {
  /** Extension tools loaded on this replica (`ExtensionHost.tools()`). */
  pluginTools: readonly { plugin: string; name: string }[];
  /** Extensions enabled in the org. */
  enabledPlugins: ReadonlySet<string>;
  /** The model's parameter declarations, or null when the deployment cannot use it. */
  resolveModel(ref: ModelRef): Promise<ModelParameter[] | null>;
  /** The org's target of a model purpose, or null when unmapped. */
  purpose(purpose: string): Promise<{ model: ModelRef; params: ModelParams } | null>;
  /**
   * The org's default chat model. There is no such setting today: the first model of the first
   * provider listed, as the agent form preselects (ruling P4-T3-2).
   */
  defaultModel(): Promise<ModelRef | null>;
  /** The model the person chose (the automatic choice keeps its params when it is the same). */
  model?: ModelRef;
}

/** `provider/model` → a model ref; null when malformed. */
function parseModelRef(s: string): ModelRef | null {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

type Choice = PlannedModel & { decl: ModelParameter[] };

/** P4-4: `modelRef` when usable, else the tier's purpose, else the org's default chat model. */
async function autoModel(t: AgentTemplate, opts: PlanOptions): Promise<Choice | null> {
  const fromRef = t.modelRef === undefined ? null : parseModelRef(t.modelRef);
  if (fromRef !== null) {
    const decl = await opts.resolveModel(fromRef);
    if (decl !== null) return { ref: fromRef, params: {}, source: "modelRef", decl };
  }
  const tier: AgentTemplateTier = t.model ?? "inherit";
  if (tier !== "inherit") {
    const target = await opts.purpose(`subagent_${tier}`);
    if (target !== null) {
      const decl = await opts.resolveModel(target.model);
      if (decl !== null) {
        return { ref: target.model, params: { ...target.params }, source: "tier", decl };
      }
    }
  }
  const def = await opts.defaultModel();
  if (def === null) return null;
  const decl = await opts.resolveModel(def);
  return decl === null ? null : { ref: def, params: {}, source: "default", decl };
}

/** A template `effort` on a choice: the model parameter when declared and valid (P4-4). */
function withEffort(c: Choice | null, effort: AgentTemplate["effort"]): PlannedModel | null {
  if (c === null) return null;
  const params: ModelParams = { ...c.params };
  if (effort !== undefined) {
    const decl = c.decl.find((p) => p.standard === "effort");
    if (decl !== undefined && validateParams([decl], { [decl.key]: effort }).ok) {
      params[decl.key] = effort;
    }
  }
  return { ref: c.ref, params, source: c.source };
}

/**
 * `s` cut to `max` UTF-16 units (what the kernel's zod schemas count), never splitting a
 * surrogate pair.
 */
export function cutUtf16(s: string, max: number): string {
  if (s.length <= max) return s;
  let out = s.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

/** A usable skill by name: `<plugin>:<name>`, or a bare name preferring the template's plugin. */
function skillByName(
  skills: readonly SkillVersionRow[],
  ref: string,
  ownPlugin: string | null,
): SkillVersionRow | undefined {
  const i = ref.indexOf(":");
  const found =
    i < 0
      ? skills.filter((s) => s.name === ref)
      : skills.filter((s) => s.name === ref.slice(i + 1) && s.plugin === ref.slice(0, i));
  const rank = (s: SkillVersionRow) => (ownPlugin !== null && s.plugin === ownPlugin ? 0 : 1);
  return [...found].sort(
    (a, b) => rank(a) - rank(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
}

interface OrgConnector {
  id: string;
  name: string;
  slug: string;
  tools: string[];
}

/**
 * The platform connector template a `{ template }` entry names: `<plugin>:<id>` by its plugin's
 * catalog item; a bare `<id>` of the template's own plugin; otherwise a platform connector template
 * id (what 另存为模板 writes, P4-11). A live row wins; a soft-deleted one (`deleted`) still names
 * the org connectors made from it, but nothing new can be made from it.
 */
async function connectorTemplateOf(
  db: KernelSchemaDb,
  ref: string,
  own: { plugin: string | null; catalogItemId: string | null },
): Promise<{ id: string; file: ConnectorTemplateFile; deleted: boolean } | null> {
  const base = db
    .selectFrom("platform_connector_templates as p")
    .innerJoin("catalog_items as c", "c.id", "p.catalog_item_id")
    .select(["p.id", "p.file", "p.deleted_at", "c.deleted_at as item_deleted_at"])
    // live first, then the most recently created
    .orderBy((eb) => eb.case().when("p.deleted_at", "is", null).then(0).else(1).end())
    .orderBy("p.created_at", "desc");
  const i = ref.indexOf(":");
  let row:
    | { id: string; file: unknown; deleted_at: Date | null; item_deleted_at: Date | null }
    | undefined;
  if (i > 0) {
    row = await base
      .where("c.name", "=", ref.slice(0, i))
      .where("p.template_id", "=", ref.slice(i + 1))
      .executeTakeFirst();
  } else {
    if (own.catalogItemId !== null) {
      row = await base
        .where("p.catalog_item_id", "=", own.catalogItemId)
        .where("p.template_id", "=", ref)
        .executeTakeFirst();
    }
    if (row === undefined && own.plugin !== null) {
      row = await base
        .where("c.name", "=", own.plugin)
        .where("p.template_id", "=", ref)
        .executeTakeFirst();
    }
    row ??= await base.where("p.id", "=", ref).executeTakeFirst();
  }
  if (row === undefined) return null;
  return {
    id: row.id,
    file: row.file as ConnectorTemplateFile,
    deleted: row.deleted_at !== null || row.item_deleted_at !== null,
  };
}

/** The org's live connectors made from platform connector template `id`, oldest first. */
async function connectorsFrom(
  db: KernelSchemaDb,
  orgId: string,
  id: string,
): Promise<OrgConnector[]> {
  const rows = await db
    .selectFrom("connectors")
    .select(["id", "name", "slug"])
    .where("org_id", "=", orgId)
    .where("platform_template_id", "=", id)
    .where("deleted_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  if (rows.length === 0) return [];
  const tools = await db
    .selectFrom("connector_tools")
    .select(["connector_id", "name"])
    .where(
      "connector_id",
      "in",
      rows.map((r) => r.id),
    )
    .orderBy("name")
    .execute();
  return rows.map((r) => ({
    ...r,
    tools: tools.filter((x) => x.connector_id === r.id).map((x) => x.name),
  }));
}

const labelOf = (file: ConnectorTemplateFile, fallback: string): string => {
  const name = file?.displayName?.en;
  return cutUtf16(typeof name === "string" && name.trim() !== "" ? name : fallback, 160);
};

/** The pending connector key of the template's `connectors[i]` (stable per entry). */
export const pendingKeyOf = (i: number): string => `connector-${i + 1}`;

const RANK = { ask: 1, deny: 2 } as const;

/**
 * The template's instruction files as the agent accepts them (InstructionFilesSchema): valid,
 * case-insensitively unique names, at most 20, the join within the limit (files past it dropped
 * from the end; a single file too long is cut).
 */
function instructionFilesOf(
  t: AgentTemplate,
  item: (name: string, state: PlanItemState, reason?: string) => void,
  dropped: string[],
): InstructionFile[] {
  const out: InstructionFile[] = [];
  const lines: { name: string; state: PlanItemState; reason?: string }[] = [];
  const seen = new Set<string>();
  for (const f of t.instructionFiles ?? []) {
    if (!INSTRUCTION_FILE_NAME_RE.test(f.name) || CONTROL_OR_HIDDEN_RE.test(f.name)) {
      lines.push({ name: f.name, state: "unavailable", reason: "invalid_name" });
    } else if (seen.has(f.name.toLowerCase())) {
      lines.push({ name: f.name, state: "unavailable", reason: "duplicate" });
    } else if (out.length >= INSTRUCTION_FILE_LIMITS.count) {
      lines.push({ name: f.name, state: "unavailable", reason: "too_many" });
    } else {
      seen.add(f.name.toLowerCase());
      out.push({ name: f.name, content: f.content });
      lines.push({ name: f.name, state: "carried" });
    }
  }
  while (out.length > 1 && joinInstructionFiles(out).length > INSTRUCTION_FILE_LIMITS.joinedChars) {
    const gone = out.pop() as InstructionFile;
    const line = lines.find((l) => l.name === gone.name && l.state === "carried");
    if (line) Object.assign(line, { state: "unavailable", reason: "too_long" });
  }
  const only = out[0];
  if (out.length === 1 && only && only.content.length > INSTRUCTION_FILE_LIMITS.joinedChars) {
    only.content = cutUtf16(only.content, INSTRUCTION_FILE_LIMITS.joinedChars);
    dropped.push("instructionFiles.0.content");
  }
  for (const l of lines) item(l.name, l.state, l.reason);
  return out;
}

/**
 * Resolves what `row`'s template carries into a new agent of `orgId` (P4-4, P4-5, P4-6). Never
 * throws for the org's state: what does not resolve is listed and left out, and text is cut to
 * the kernel's limits; the result is checked against the agent and profile schemas.
 */
export async function planFromTemplate(
  db: KernelSchemaDb,
  orgId: string,
  row: TemplateRow,
  opts: PlanOptions,
): Promise<TemplatePlan> {
  const t = row.template;
  const items: PlanItem[] = [];
  const dropped: string[] = [];
  const item = (kind: PlanItemKind, name: string, state: PlanItemState, reason?: string) =>
    items.push({ kind, name, state, ...(reason !== undefined && { reason }) });

  // prompt, description, quick actions (cut in UTF-16 units, as the kernel schemas count)
  const files = instructionFilesOf(t, (n, s, r) => item("instruction_file", n, s, r), dropped);
  let instructions: string | undefined;
  if (files.length === 0) {
    if ((t.instructionFiles ?? []).length === 0) item("instruction_file", "AGENTS.md", "carried");
    instructions = cutUtf16(t.instructions, INSTRUCTION_FILE_LIMITS.joinedChars);
    if (instructions !== t.instructions) dropped.push("instructions");
  }
  const fullDescription = typeof t.description === "string" ? t.description : "";
  const description = cutUtf16(fullDescription, PROFILE_LIMITS.description);
  if (description !== fullDescription) dropped.push("description");
  if (description !== "") item("description", "description", "carried");
  const quickActions = (t.quickActions ?? []).slice(0, PROFILE_LIMITS.quickActions).map((q, i) => {
    const title = cutUtf16(q.title, PROFILE_LIMITS.title);
    const body = cutUtf16(q.body, PROFILE_LIMITS.body);
    if (title !== q.title) dropped.push(`quickActions.${i}.title`);
    if (body !== q.body) dropped.push(`quickActions.${i}.body`);
    item("quick_action", title, "carried");
    return { title, body };
  });
  if (t.maxSteps !== undefined) dropped.push("maxSteps");

  // tools: builtin and plugin keys usable in the org (P4-5)
  const disallowed = new Set(t.disallowedTools ?? []);
  const tools: AgentToolRef[] = [];
  const builtinNames = new Set<string>(BUILTIN_TOOL_NAMES);
  if (t.tools === undefined) {
    for (const ref of DEFAULT_AGENT_TOOLS) {
      if (ref.kind === "builtin" && !disallowed.has(ref.name)) {
        tools.push(ref);
        item("tool", ref.name, "carried", "default");
      }
    }
  } else {
    for (const key of t.tools) {
      if (disallowed.has(key)) continue;
      const parsed = parseToolKey(key);
      if (parsed?.kind === "builtin" && builtinNames.has(parsed.name)) {
        tools.push({ kind: "builtin", name: parsed.name });
        item("tool", key, "carried");
      } else if (parsed?.kind === "extension") {
        const ok =
          opts.enabledPlugins.has(parsed.plugin) &&
          opts.pluginTools.some((x) => x.plugin === parsed.plugin && x.name === parsed.tool);
        if (ok) {
          tools.push({ kind: "plugin", plugin: parsed.plugin, name: parsed.tool });
          item("tool", key, "carried");
        } else item("tool", key, "unavailable", "plugin_unavailable");
      } else if (parsed?.kind === "connector") {
        item("tool", key, "unavailable", "connector_key");
      } else item("tool", key, "unavailable", "unknown_tool");
    }
  }

  // skills: by name against the org's usable skills (P4-5); every name gets its item
  const usable = await usableSkillVersions(db, orgId);
  const orgSkills: string[] = [];
  const select = (id: string) => {
    if (!orgSkills.includes(id)) orgSkills.push(id);
  };
  const pinned: string[] = [];
  let pinnedBytes = 0;
  const preloaded = new Set(t.skills ?? []);
  const skillNames = [...new Set([...(t.skills ?? []), ...(t.selectedSkills ?? [])])];
  for (const name of skillNames) {
    const s = skillByName(usable, name, row.plugin);
    if (!s) {
      item("skill", name, "unavailable", "not_found");
      continue;
    }
    select(s.id);
    if (!preloaded.has(name)) {
      item("skill", name, "carried", pinned.includes(s.id) ? "pinned" : undefined);
      continue;
    }
    if (pinned.includes(s.id)) {
      item("skill", name, "carried", "pinned");
      continue;
    }
    const bytes = s.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE)?.size ?? 0;
    if (!invocationOf(s.manifest).model) {
      item("skill", name, "carried", "not_pinned_manual_only");
    } else if (
      pinned.length >= PINNED_SKILLS_LIMITS.count ||
      pinnedBytes + bytes > PINNED_SKILLS_LIMITS.totalBytes
    ) {
      item("skill", name, "carried", "not_pinned_too_large");
    } else {
      pinned.push(s.id);
      pinnedBytes += bytes;
      item("skill", name, "carried", "pinned");
    }
  }

  // connectors (P4-5, P4-6)
  const pendingConnectors: PendingConnector[] = [];
  const slugs = new Map<string, OrgConnector>();
  const connectorPolicies: Record<string, "ask" | "deny"> = {};
  for (const [i, entry] of (t.connectors ?? []).entries()) {
    const key = pendingKeyOf(i);
    const policies = entry.policies !== undefined && Object.keys(entry.policies).length > 0;
    if ("needs" in entry) {
      pendingConnectors.push({
        key,
        label: entry.needs.label,
        source: { needs: { ...entry.needs, tools: [...entry.needs.tools] } },
        tools: [...entry.needs.tools],
        ...(policies && { policies: { ...entry.policies } }),
      });
      item("connector", entry.needs.label, "pending", "needs");
      continue;
    }
    const ct = await connectorTemplateOf(db, entry.template, {
      plugin: row.plugin,
      catalogItemId: row.catalogItemId,
    });
    if (ct === null) {
      item("connector", entry.template, "unavailable", "template_not_found");
      continue;
    }
    const label = labelOf(ct.file, entry.template);
    const pending = (reason: string) => {
      // nothing new can be made from a removed connector template
      if (ct.deleted) {
        item("connector", label, "unavailable", "template_not_found");
        return;
      }
      pendingConnectors.push({
        key,
        label,
        source: { template: ct.id },
        ...(entry.tools !== undefined && { tools: [...entry.tools] }),
        ...(policies && { policies: { ...entry.policies } }),
      });
      item("connector", label, "pending", reason);
    };
    const made = await connectorsFrom(db, orgId, ct.id);
    const first = made[0];
    if (first === undefined) {
      pending("no_connector");
      continue;
    }
    let names = entry.tools === undefined ? first.tools : entry.tools;
    if (entry.tools !== undefined) {
      const present = entry.tools.filter((n) => first.tools.includes(n));
      if (present.length === 0) {
        // pending keeps every name: none is dropped
        pending("tools_missing");
        continue;
      }
      for (const n of entry.tools) {
        if (!first.tools.includes(n)) dropped.push(`connectors.${key}.tools.${n}`);
      }
      names = present;
    }
    // `disallowedTools` naming its tools narrows it (P4-5)
    const allowed = names.filter((n) => !disallowed.has(connectorToolKey(first.slug, n)));
    if (allowed.length === 0) {
      item("connector", first.name, "unavailable", "disallowed");
      continue;
    }
    const narrowed = allowed.length !== names.length;
    const refTools: "all" | string[] = entry.tools === undefined && !narrowed ? "all" : allowed;
    for (const [name, p] of Object.entries(entry.policies ?? {})) {
      if (!allowed.includes(name)) {
        dropped.push(`connectors.${key}.policies.${name}`);
        continue;
      }
      const k = connectorToolKey(first.slug, name);
      const prev = connectorPolicies[k];
      if (prev === undefined || RANK[p] > RANK[prev]) connectorPolicies[k] = p;
    }
    const existing = tools.find(
      (r): r is Extract<AgentToolRef, { kind: "connector" }> =>
        r.kind === "connector" && r.connectorId === first.id,
    );
    if (existing === undefined) {
      tools.push({ kind: "connector", connectorId: first.id, tools: refTools });
    } else if (existing.tools !== "all") {
      existing.tools =
        refTools === "all" ? "all" : [...new Set([...(existing.tools as string[]), ...refTools])];
    }
    slugs.set(first.id, first);
    item("connector", first.name, "carried", made.length > 1 ? "several" : undefined);
  }

  // sub-agents (P4-5): types against the org's usable templates, inline definitions
  const sub = t.subagents;
  let subagents: Subagents | undefined;
  if (sub !== undefined) {
    const out: Subagents = {};
    if (sub.general !== undefined) out.general = sub.general;
    let room = SUBAGENT_ROSTER_MAX - (sub.general === false ? 0 : 1);
    const taken = new Set<string>(sub.general === false ? [] : ["general-purpose"]);
    const inlineNames = new Set((sub.inline ?? []).map((x) => x.name));
    const templateIds: string[] = [];
    if ((sub.types ?? []).length > 0) {
      const roster = (await usableTemplates(db, orgId)).map((u) => ({
        id: u.id,
        type: templateTypeOf(u.plugin, u.name),
      }));
      for (const type of sub.types ?? []) {
        // an exact type; a bare name prefers the template's own plugin, then a unique `<p>:<name>`
        const own =
          !type.includes(":") && row.plugin !== null
            ? roster.find((r) => r.type === templateTypeOf(row.plugin, type))
            : undefined;
        const bare = type.includes(":") ? [] : roster.filter((r) => r.type.endsWith(`:${type}`));
        const found =
          roster.find((r) => r.type === type) ?? own ?? (bare.length === 1 ? bare[0] : undefined);
        if (found === undefined) {
          item("subagent", type, "unavailable", "type_not_found");
        } else if (taken.has(found.type) || inlineNames.has(found.type)) {
          item("subagent", type, "unavailable", "type_taken");
        } else if (room <= 0 || templateIds.length >= 20) {
          item("subagent", type, "unavailable", "too_many");
        } else {
          taken.add(found.type);
          templateIds.push(found.id);
          room -= 1;
          item("subagent", found.type, "carried");
        }
      }
    }
    if (templateIds.length > 0) out.templates = templateIds;
    const inline: InlineAgentTemplate[] = [];
    for (const x of sub.inline ?? []) {
      if (!SUBAGENT_NAME_RE.test(x.name) || taken.has(x.name)) {
        item("subagent", x.name, "unavailable", "type_taken");
        continue;
      }
      if (room <= 0 || inline.length >= 10) {
        item("subagent", x.name, "unavailable", "too_many");
        continue;
      }
      taken.add(x.name);
      room -= 1;
      const skillIds: string[] = [];
      for (const name of x.skills ?? []) {
        const s = skillByName(usable, name, row.plugin);
        if (!s) {
          if (!items.some((i) => i.kind === "skill" && i.name === name)) {
            item("skill", name, "unavailable", "not_found");
          }
          continue;
        }
        if (!skillIds.includes(s.id)) skillIds.push(s.id);
        if (!orgSkills.includes(s.id)) {
          select(s.id);
          item("skill", name, "carried", "subagent");
        }
      }
      const description = cutUtf16(x.description, 4096);
      const instr = cutUtf16(x.instructions, 100_000);
      if (description !== x.description) dropped.push(`subagents.inline.${x.name}.description`);
      if (instr !== x.instructions) dropped.push(`subagents.inline.${x.name}.instructions`);
      inline.push({
        name: x.name,
        description,
        instructions: instr,
        // absent = no allowlist (all the agent's tools), `[]` = no tools (ruling P4-T3-8)
        ...(x.tools !== undefined && { tools: [...x.tools] }),
        ...(skillIds.length > 0 && { skills: skillIds.slice(0, 3) }),
        ...(x.model !== undefined && { model: x.model }),
      });
      item("subagent", x.name, "carried");
    }
    if (inline.length > 0) out.inline = inline;
    subagents = out;
    // a roster needs the `Agent` tool to be offered (ruling P4-T3-5), unless the template
    // disallows it
    const describes = templateIds.length > 0 || inline.length > 0 || sub.general === true;
    if (
      describes &&
      !disallowed.has(AGENT_TOOL) &&
      !tools.some((r) => r.kind === "builtin" && r.name === AGENT_TOOL)
    ) {
      tools.push({ kind: "builtin", name: AGENT_TOOL });
      item("tool", AGENT_TOOL, "carried", "subagents");
    }
  }

  // the tool keys the agent has, for policies and inline allowlists
  const keys = new Set<string>();
  for (const r of tools) {
    if (r.kind === "builtin") {
      keys.add(r.name);
      if (r.name === BUILTIN.Bash) for (const c of BASH_COMPANION_TOOLS) keys.add(c);
    } else if (r.kind === "plugin") keys.add(extensionToolKey(r.plugin, r.name));
    else {
      const c = slugs.get(r.connectorId);
      if (!c) continue;
      for (const n of r.tools === "all" ? c.tools : r.tools) keys.add(connectorToolKey(c.slug, n));
    }
  }
  const toolPolicies: Record<string, "ask" | "deny"> = {};
  for (const [key, p] of [
    ...Object.entries(t.toolPolicies ?? {}),
    ...Object.entries(connectorPolicies),
  ]) {
    if (!keys.has(key) || (p !== "ask" && p !== "deny")) continue;
    const prev = toolPolicies[key];
    if (prev === undefined || RANK[p] > RANK[prev]) toolPolicies[key] = p;
  }
  for (const x of subagents?.inline ?? []) {
    if (x.tools === undefined) continue;
    for (const k of x.tools) {
      if (!keys.has(k)) dropped.push(`subagents.inline.${x.name}.tools.${k}`);
    }
    // an allowlist stays one: all its tools dropped leaves `[]` (no tool), never all of them
    x.tools = x.tools.filter((k) => keys.has(k));
  }

  const definition: PlannedDefinition = {
    name: row.name.slice(0, 80),
    avatarUrl: null,
    ...(instructions === undefined ? { instructionFiles: files } : { instructions }),
    fallback: null,
    fallbackParams: {},
    tools,
    toolPolicies,
    ...((orgSkills.length > 0 || pinned.length > 0) && {
      skills: { orgSkills, ...(pinned.length > 0 && { pinned }) },
    }),
    ...(subagents !== undefined && { subagents }),
    ...(pendingConnectors.length > 0 && { pendingConnectors }),
  };
  const profile = { description, quickActions };

  // the model (P4-4): the automatic choice always; the person's choice keeps its params when equal
  const autoChoice = await autoModel(t, opts);
  const auto = withEffort(autoChoice, t.effort);
  let model = auto;
  if (
    opts.model !== undefined &&
    (auto === null ||
      auto.ref.provider !== opts.model.provider ||
      auto.ref.model !== opts.model.model)
  ) {
    const decl = (await opts.resolveModel(opts.model)) ?? [];
    model = withEffort({ ref: opts.model, params: {}, source: "chosen", decl }, t.effort);
  }
  // a standard knob's key is its name (`effort`)
  if (t.effort !== undefined && model?.params.effort !== t.effort) dropped.push("effort");

  // the result fits the kernel's schemas; a residue here is a bug in the cutting above
  const check = AgentDefinitionSchema.safeParse({
    ...definition,
    instructions: definition.instructions ?? joinInstructionFiles(files),
    model: model?.ref ?? { provider: "none", model: "none" },
    modelParams: model?.params ?? {},
  });
  const checkProfile = ProfileInputSchema.safeParse(profile);
  if (!check.success || !checkProfile.success) {
    const issues = [...(check.error?.issues ?? []), ...(checkProfile.error?.issues ?? [])];
    throw new Error(
      `template ${row.id} v${row.version} planned outside the agent schema: ${issues
        .map((x) => `${x.path.join(".")}: ${x.message}`)
        .join("; ")}`,
    );
  }

  const baseHash = createHash("sha256")
    .update(
      canonicalJson({
        templateId: row.id,
        version: row.version,
        definition,
        profile,
        items,
        dropped: dropped.filter((d) => d !== "effort"),
      }),
    )
    .digest("hex");
  const modelHash = createHash("sha256")
    .update(canonicalJson(auto === null ? null : { ref: auto.ref, params: auto.params }))
    .digest("hex")
    .slice(0, 16);
  return {
    definition,
    profile,
    model,
    auto,
    items,
    dropped,
    baseHash,
    modelHash,
    hash: `${baseHash}.${modelHash}`,
  };
}
