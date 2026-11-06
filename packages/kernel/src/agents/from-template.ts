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
import {
  AGENT_TOOL,
  BASH_COMPANION_TOOLS,
  BUILTIN,
  BUILTIN_TOOL_NAMES,
  DEFAULT_AGENT_TOOLS,
} from "../tools/builtin-names.js";
import { canonicalJson } from "../tools/canonical-json.js";
import type {
  AgentToolRef,
  InlineAgentTemplate,
  ModelParams,
  ModelRef,
  PendingConnector,
  Subagents,
} from "./definition.js";
import { SUBAGENT_NAME_RE, SUBAGENT_ROSTER_MAX } from "./definition.js";
import type { AgentDefinitionInput } from "./instruction-files.js";
import { PROFILE_LIMITS, type QuickAction } from "./profile.js";
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
 * - tool: `default` (the template names no tools: the defaults of a new agent), `subagents`
 *   (`Agent` added because the template describes sub-agents); unavailable `plugin_unavailable`
 *   (its plugin is not enabled in the org or not loaded), `unknown_tool`, `connector_key` (a
 *   connector tool key: connectors carry over only through `connectors` entries);
 * - skill: `pinned`, `not_pinned_manual_only`, `not_pinned_too_large`, `subagent` (named only by an
 *   inline sub-agent); unavailable `not_found`;
 * - connector: `several` (the first of several connectors made from the template was bound);
 *   pending `no_connector`, `tools_missing` (the connector made from the template lacks every
 *   named tool), `needs`; unavailable `template_not_found`;
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
  items: PlanItem[];
  /**
   * Template fields (and inline sub-agent tool keys) that have no place in the agent: `maxSteps`,
   * `effort` when the model does not declare it, `description` when cut to the profile's limit,
   * `subagents.inline.<name>.tools.<key>` for a key the agent does not have.
   */
  dropped: string[];
  /**
   * The preview hash (`previewHash`): sha256 of the template id and version and everything
   * resolved above except the model, which the person chooses in the dialog.
   */
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
  /** The model the person chose; resolution stops there. */
  model?: ModelRef;
}

/** `provider/model` → a model ref; null when malformed. */
function parseModelRef(s: string): ModelRef | null {
  const i = s.indexOf("/");
  if (i <= 0 || i === s.length - 1) return null;
  return { provider: s.slice(0, i), model: s.slice(i + 1) };
}

/** P4-4: `modelRef` when usable, else the tier's purpose, else the org's default chat model. */
async function chooseModel(
  t: AgentTemplate,
  opts: PlanOptions,
): Promise<{
  ref: ModelRef;
  params: ModelParams;
  source: ModelSource;
  decl: ModelParameter[];
} | null> {
  if (opts.model !== undefined) {
    const decl = (await opts.resolveModel(opts.model)) ?? [];
    return { ref: opts.model, params: {}, source: "chosen", decl };
  }
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
 * The live platform connector template a `{ template }` entry names: `<plugin>:<id>` by its
 * plugin's catalog item; a bare `<id>` of the template's own plugin; otherwise a platform connector
 * template id (what 另存为模板 writes, P4-11).
 */
async function connectorTemplateOf(
  db: KernelSchemaDb,
  ref: string,
  own: { plugin: string | null; catalogItemId: string | null },
): Promise<{ id: string; file: ConnectorTemplateFile } | null> {
  const base = db
    .selectFrom("platform_connector_templates as p")
    .innerJoin("catalog_items as c", "c.id", "p.catalog_item_id")
    .select(["p.id", "p.file"])
    .where("p.deleted_at", "is", null)
    .where("c.deleted_at", "is", null);
  const i = ref.indexOf(":");
  let row: { id: string; file: unknown } | undefined;
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
  return row === undefined ? null : { id: row.id, file: row.file as ConnectorTemplateFile };
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
  return (typeof name === "string" && name.trim() !== "" ? name : fallback).slice(0, 80);
};

/** The pending connector key of the template's `connectors[i]` (stable per entry). */
export const pendingKeyOf = (i: number): string => `connector-${i + 1}`;

/**
 * Resolves what `row`'s template carries into a new agent of `orgId` (P4-4, P4-5, P4-6). Never
 * throws for the org's state: what does not resolve is listed and left out.
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

  // prompt, description, quick actions
  const files = t.instructionFiles;
  if (files !== undefined && files.length > 0) {
    for (const f of files) item("instruction_file", f.name, "carried");
  } else item("instruction_file", "AGENTS.md", "carried");
  const fullDescription = typeof t.description === "string" ? t.description : "";
  const description = [...fullDescription].slice(0, PROFILE_LIMITS.description).join("");
  if (description !== fullDescription) dropped.push("description");
  if (description !== "") item("description", "description", "carried");
  const quickActions = (t.quickActions ?? []).slice(0, PROFILE_LIMITS.quickActions);
  for (const q of quickActions) item("quick_action", q.title, "carried");
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

  // skills: by name against the org's usable skills (P4-5)
  const usable = await usableSkillVersions(db, orgId);
  const orgSkills: string[] = [];
  const select = (id: string) => {
    if (!orgSkills.includes(id)) orgSkills.push(id);
  };
  const pinned: string[] = [];
  let pinnedBytes = 0;
  const skillNames = [...(t.skills ?? []), ...(t.selectedSkills ?? [])];
  const seenSkills = new Set<string>();
  for (const name of skillNames) {
    if (seenSkills.has(name)) continue;
    seenSkills.add(name);
    const s = skillByName(usable, name, row.plugin);
    if (!s) {
      item("skill", name, "unavailable", "not_found");
      continue;
    }
    select(s.id);
    if (!(t.skills ?? []).includes(name)) {
      item("skill", name, "carried");
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
    } else if (!pinned.includes(s.id)) {
      pinned.push(s.id);
      pinnedBytes += bytes;
      item("skill", name, "carried", "pinned");
    }
  }

  // connectors (P4-5, P4-6)
  const pendingConnectors: PendingConnector[] = [];
  const slugs = new Map<string, OrgConnector>();
  for (const [i, entry] of (t.connectors ?? []).entries()) {
    const key = pendingKeyOf(i);
    if ("needs" in entry) {
      pendingConnectors.push({
        key,
        label: entry.needs.label,
        source: { needs: { ...entry.needs, tools: [...entry.needs.tools] } },
        tools: [...entry.needs.tools],
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
      pendingConnectors.push({
        key,
        label,
        source: { template: ct.id },
        ...(entry.tools !== undefined && { tools: [...entry.tools] }),
      });
      item("connector", label, "pending", reason);
    };
    const made = await connectorsFrom(db, orgId, ct.id);
    const first = made[0];
    if (first === undefined) {
      pending("no_connector");
      continue;
    }
    let names: "all" | string[] = "all";
    if (entry.tools !== undefined) {
      names = entry.tools.filter((n) => first.tools.includes(n));
      for (const n of entry.tools) {
        if (!first.tools.includes(n)) dropped.push(`connectors.${key}.tools.${n}`);
      }
      if (names.length === 0) {
        pending("tools_missing");
        continue;
      }
    }
    const existing = tools.find(
      (r): r is Extract<AgentToolRef, { kind: "connector" }> =>
        r.kind === "connector" && r.connectorId === first.id,
    );
    if (existing === undefined) {
      tools.push({ kind: "connector", connectorId: first.id, tools: names });
    } else if (existing.tools !== "all") {
      existing.tools =
        names === "all" ? "all" : [...new Set([...(existing.tools as string[]), ...names])];
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
          if (!templateIds.includes(found.id)) item("subagent", type, "unavailable", "type_taken");
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
          if (
            !skillNames.includes(name) &&
            !items.some((i) => i.kind === "skill" && i.name === name)
          ) {
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
      inline.push({
        name: x.name,
        description: x.description,
        instructions: x.instructions,
        // an empty list is the template's "no allowlist" (ruling P4-T3-6); filtered below
        ...(x.tools.length > 0 && { tools: [...x.tools] }),
        ...(skillIds.length > 0 && { skills: skillIds.slice(0, 3) }),
        ...(x.model !== undefined && { model: x.model }),
      });
      item("subagent", x.name, "carried");
    }
    if (inline.length > 0) out.inline = inline;
    subagents = out;
    // a roster needs the `Agent` tool to be offered (ruling P4-T3-5)
    const describes = templateIds.length > 0 || inline.length > 0 || sub.general === true;
    if (describes && !tools.some((r) => r.kind === "builtin" && r.name === AGENT_TOOL)) {
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
  for (const [key, p] of Object.entries(t.toolPolicies ?? {})) {
    if (keys.has(key) && (p === "ask" || p === "deny")) toolPolicies[key] = p;
  }
  for (const x of subagents?.inline ?? []) {
    if (x.tools === undefined) continue;
    const kept = x.tools.filter((k) => keys.has(k));
    for (const k of x.tools) {
      if (!keys.has(k)) dropped.push(`subagents.inline.${x.name}.tools.${k}`);
    }
    // nothing left of an allowlist: the sub-agent gets no tool rather than all of them
    x.tools = kept.length > 0 ? kept : [];
    if (x.tools.length === 0) delete x.tools;
  }

  const definition: PlannedDefinition = {
    name: row.name.slice(0, 80),
    avatarUrl: null,
    ...(files !== undefined && files.length > 0
      ? { instructionFiles: files.map((f) => ({ name: f.name, content: f.content })) }
      : { instructions: t.instructions }),
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

  // the model (P4-4); `effort` becomes the model parameter when the model declares it
  const chosen = await chooseModel(t, opts);
  let model: PlannedModel | null = null;
  if (chosen !== null) {
    const params: ModelParams = { ...chosen.params };
    if (t.effort !== undefined) {
      const decl = chosen.decl.find((p) => p.standard === "effort");
      const r = decl === undefined ? null : validateParams([decl], { [decl.key]: t.effort });
      if (decl !== undefined && r?.ok) params[decl.key] = t.effort;
      else dropped.push("effort");
    }
    model = { ref: chosen.ref, params, source: chosen.source };
  } else if (t.effort !== undefined) dropped.push("effort");

  const profile = { description, quickActions: quickActions.map((q) => ({ ...q })) };
  const hash = createHash("sha256")
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
  return { definition, profile, model, items, dropped, hash };
}
