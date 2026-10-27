import {
  type AgentTemplate,
  type AgentTemplateTier,
  type ModelParameter,
  SKILL_ENTRY_FILE,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import type { AgentDefinition, AgentToolRef, ModelRef } from "../../agents/definition.js";
import { loadTemplates } from "../../agents/templates.js";
import type { KernelConfig } from "../../config/schema.js";
import type { EventPayload } from "../../conversations/events.js";
import type { KernelDb } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import type { ModelPurposesService } from "../../models/purposes.js";
import { PINNED_SKILLS_LIMITS } from "../../skills/catalog.js";
import { toolKey } from "../../tools/naming.js";
import type { ProviderRegistry } from "../providers.js";
import type { RosterEntry } from "./roster.js";

/**
 * Tools a sub-agent never gets (spec §5.3, §5.5): `agent` (depth 1), `ask_user` (the person does not
 * see the child), `sandbox_deliver` (delivering files is the parent's job) and `skill_write`.
 */
export const CHILD_REMOVED_TOOLS = ["agent", "ask_user", "sandbox_deliver", "skill_write"] as const;

/**
 * The roster entry's template is gone (an inline template edited away, a plugin template
 * uninstalled) between resolving the roster and reading it. The dispatch refuses the call as an
 * unknown type.
 */
export class SubagentTypeGoneError extends Error {
  constructor(readonly type: string) {
    super(`agent template ${type} not found`);
    this.name = "SubagentTypeGoneError";
  }
}

/** The effective (narrowed) definition of a sub-agent, frozen into its `subagent_started`. */
export interface EffectiveDefinition {
  definition: AgentDefinition;
  template: EventPayload<"subagent_started">["template"];
  maxSteps: number;
  /** Dispatch warnings (pinned skills dropped), recorded in `subagent_started.warnings`. */
  warnings: string[];
}

export interface EffectiveDefinitionDeps {
  db: KernelDb;
  purposes: Pick<ModelPurposesService, "resolve">;
  /** Reads the resolved model's parameter declarations (a template `effort`). */
  registry: Pick<ProviderRegistry, "resolve">;
  config: () => KernelConfig;
}

type Policy = "ask" | "deny";
const RANK: Record<Policy, number> = { ask: 1, deny: 2 };

const isPolicy = (p: unknown): p is Policy => p === "ask" || p === "deny";

/**
 * `base` with `over` applied on top, the stricter value winning per key (`deny` > `ask`). Values
 * other than `ask` / `deny` (stored template data is not re-validated) are skipped on both sides.
 */
export function stricterPolicies(
  base: Record<string, Policy>,
  over: Record<string, Policy>,
): Record<string, Policy> {
  const out: Record<string, Policy> = {};
  for (const [key, p] of Object.entries(base)) if (isPolicy(p)) out[key] = p;
  for (const [key, p] of Object.entries(over)) {
    if (!isPolicy(p)) continue;
    const prev = out[key];
    if (prev === undefined || RANK[p] > RANK[prev]) out[key] = p;
  }
  return out;
}

interface ConnectorInfo {
  slug: string;
  /** Tool names in the connector's snapshot (what `tools: "all"` means now). */
  tools: string[];
}

async function loadConnectors(
  db: KernelDb,
  orgId: string,
  refs: readonly AgentToolRef[],
): Promise<Map<string, ConnectorInfo>> {
  const ids = [...new Set(refs.flatMap((r) => (r.kind === "connector" ? [r.connectorId] : [])))];
  const out = new Map<string, ConnectorInfo>();
  if (ids.length === 0) return out;
  const rows = await db
    .selectFrom("connectors")
    .select(["id", "slug"])
    .where("org_id", "=", orgId)
    .where("deleted_at", "is", null)
    .where("id", "in", ids)
    .execute();
  const tools =
    rows.length === 0
      ? []
      : await db
          .selectFrom("connector_tools")
          .select(["connector_id", "name"])
          .where(
            "connector_id",
            "in",
            rows.map((r) => r.id),
          )
          .orderBy("name")
          .execute();
  for (const r of rows) {
    out.set(r.id, {
      slug: r.slug,
      tools: tools.filter((t) => t.connector_id === r.id).map((t) => t.name),
    });
  }
  return out;
}

/**
 * Narrows tool refs by resolved key (spec §5.3): keeps a key when `allow` (if given) lists it and
 * neither `deny` nor {@link CHILD_REMOVED_TOOLS} does. A connector ref with `tools: "all"` stays
 * live only when nothing can narrow it (no allowlist and no deny key under `<slug>__`), so a tool
 * the connector gains later never slips past the template; otherwise it becomes the kept names, or
 * is dropped. A connector that no longer exists keeps its ref only without an allowlist.
 */
function narrowTools(
  refs: readonly AgentToolRef[],
  connectors: Map<string, ConnectorInfo>,
  allow: ReadonlySet<string> | null,
  deny: ReadonlySet<string>,
): AgentToolRef[] {
  const removed = new Set<string>(CHILD_REMOVED_TOOLS);
  const keep = (key: string) =>
    !removed.has(key) && !deny.has(key) && (allow === null || allow.has(key));
  const out: AgentToolRef[] = [];
  for (const ref of refs) {
    if (ref.kind === "builtin") {
      if (keep(ref.name)) out.push(ref);
    } else if (ref.kind === "plugin") {
      if (keep(toolKey(ref.plugin, ref.name))) out.push(ref);
    } else {
      const c = connectors.get(ref.connectorId);
      if (!c) {
        if (allow === null) out.push(ref);
        continue;
      }
      const prefix = toolKey(c.slug, "");
      if (ref.tools === "all" && allow === null && ![...deny].some((k) => k.startsWith(prefix))) {
        out.push(ref);
        continue;
      }
      const names = ref.tools === "all" ? c.tools : ref.tools;
      const kept = names.filter((name) => keep(toolKey(c.slug, name)));
      if (kept.length > 0) out.push({ ...ref, tools: kept });
    }
  }
  return out;
}

/** The template fields the narrowing reads, from an inline or a plugin template. */
type TemplateLike = {
  [K in
    | "instructions"
    | "tools"
    | "disallowedTools"
    | "toolPolicies"
    | "model"
    | "effort"
    | "maxSteps"
    | "skills"]?: AgentTemplate[K] | undefined;
};

interface SkillRow {
  id: string;
  name: string;
  scope: "org" | "agent";
  plugin: string | null;
  bytes: number;
}

/**
 * The template's skills the parent selects (its `orgSkills` or the parent agent's own skills),
 * within the pinned limits (spec §5.3): inline templates name skill ids, plugin templates skill
 * names (`<name>` or `<plugin>:<name>`). A name that matches more than one selected skill picks, in
 * this order, the skill from the template's own plugin, the agent's own skill, the org skill (ties
 * by id), with a warning. Dropped ones get a warning.
 */
async function pinnedFor(
  db: KernelDb,
  a: { orgId: string; parent: AgentDefinition; parentAgentId: string },
  refs: readonly string[],
  byName: { plugin: string | undefined } | null,
): Promise<{ pinned: string[]; warnings: string[] }> {
  if (refs.length === 0) return { pinned: [], warnings: [] };
  const orgSkills = a.parent.skills?.orgSkills ?? [];
  const rows: SkillRow[] = (
    await db
      .selectFrom("skills as s")
      .innerJoin("skill_versions as v", (j) =>
        j.onRef("v.skill_id", "=", "s.id").onRef("v.version", "=", "s.current_version"),
      )
      .leftJoin("catalog_items as c", "c.id", "s.catalog_item_id")
      .select(["s.id", "s.name", "s.scope", "v.manifest", "c.name as plugin"])
      .where("s.org_id", "=", a.orgId)
      .where("s.deleted_at", "is", null)
      .where((eb) => {
        const own = eb.and([eb("s.scope", "=", "agent"), eb("s.agent_id", "=", a.parentAgentId)]);
        return orgSkills.length === 0
          ? own
          : eb.or([own, eb.and([eb("s.scope", "=", "org"), eb("s.id", "in", orgSkills)])]);
      })
      .orderBy("s.id")
      .execute()
  ).map((r) => ({
    id: r.id,
    name: r.name,
    scope: r.scope,
    plugin: r.plugin,
    bytes: r.manifest.files.find((f) => f.path === SKILL_ENTRY_FILE)?.size ?? 0,
  }));
  const pinned: string[] = [];
  const warnings: string[] = [];
  const own = byName?.plugin;
  const rank = (r: SkillRow) =>
    own !== undefined && r.plugin === own ? 0 : r.scope === "agent" ? 1 : 2;
  const match = (ref: string): SkillRow | undefined => {
    if (byName === null) return rows.find((r) => r.id === ref);
    const i = ref.indexOf(":");
    const found =
      i < 0
        ? rows.filter((r) => r.name === ref)
        : rows.filter((r) => r.name === ref.slice(i + 1) && r.plugin === ref.slice(0, i));
    // rows are ordered by id, and the sort is stable: ties keep that order
    const [first, ...rest] = found.sort((x, y) => rank(x) - rank(y));
    if (first && rest.length > 0) {
      const which = [`the one from the plugin ${own}`, "the agent's own skill", "the org skill"][
        rank(first)
      ];
      warnings.push(
        `The skill name "${ref}" matches more than one selected skill; ${which} was pinned.`,
      );
    }
    return first;
  };
  let total = 0;
  for (const ref of refs) {
    const r = match(ref);
    if (!r) {
      warnings.push(`The skill "${ref}" was not pinned: the agent does not select it.`);
      continue;
    }
    if (pinned.includes(r.id)) continue;
    if (pinned.length >= PINNED_SKILLS_LIMITS.count) {
      warnings.push(`The skill "${r.name}" was not pinned: at most 3 skills can be pinned.`);
      continue;
    }
    if (total + r.bytes > PINNED_SKILLS_LIMITS.totalBytes) {
      warnings.push(
        `The skill "${r.name}" was not pinned: pinned skills are limited to 32 KB in total.`,
      );
      continue;
    }
    total += r.bytes;
    pinned.push(r.id);
  }
  return { pinned, warnings };
}

/** The `effort` declaration of `model`, or null (or when the model cannot be resolved). */
async function effortDecl(
  registry: Pick<ProviderRegistry, "resolve">,
  model: ModelRef,
): Promise<ModelParameter | null> {
  try {
    const { info } = await registry.resolve(model);
    return info.parameters.find((p) => p.standard === "effort") ?? null;
  } catch {
    return null;
  }
}

/** Model, params and fallback of a sub-agent (spec §5.4). */
async function resolveTier(
  d: EffectiveDefinitionDeps,
  orgId: string,
  parent: AgentDefinition,
  tier: AgentTemplateTier,
): Promise<{
  model: ModelRef;
  modelParams: AgentDefinition["modelParams"];
  fallback: ModelRef | null;
  fallbackParams: AgentDefinition["fallbackParams"];
  tierFallback: boolean;
}> {
  const inherit = {
    model: parent.model,
    modelParams: parent.modelParams,
    fallback: parent.fallback,
    fallbackParams: parent.fallbackParams,
  };
  if (tier === "inherit") return { ...inherit, tierFallback: false };
  try {
    const target = await d.purposes.resolve(orgId, `subagent_${tier}`);
    return {
      model: target.model,
      modelParams: target.params,
      fallback: null,
      fallbackParams: {},
      tierFallback: false,
    };
  } catch (e) {
    if (e instanceof ApiError && e.code === "model.unconfigured") {
      return { ...inherit, tierFallback: true };
    }
    throw e;
  }
}

/** An org agent's version and definition as checked by its gates. */
export interface CheckedOrgAgent {
  version: number;
  definition: AgentDefinition;
}

/** `"{parent name} › {agent type}"`, within the 80-character name limit. */
const childName = (parent: string, type: string) => `${parent} › ${type}`.slice(0, 80);

function orgAgentDefinition(
  d: EffectiveDefinitionDeps,
  a: { parent: AgentDefinition; entry: RosterEntry; orgAgent?: CheckedOrgAgent },
): EffectiveDefinition & { model: ModelRef; tierFallback: boolean } {
  // the version the gates checked (checkOrgAgent), never read again here: a version saved in
  // between could be one the gates never saw (batch 3 review M1)
  if (a.orgAgent === undefined) {
    throw new Error(`org agent ${a.entry.type} dispatched without its checked version`);
  }
  const agentId = a.entry.agentId ?? "";
  const own = a.orgAgent.definition;
  const { subagents: _subagents, skills, ...rest } = own;
  const definition: AgentDefinition = {
    ...rest,
    // its own tools, not intersected with the parent's; only the child-removed ones go
    tools: narrowTools(own.tools, new Map(), null, new Set()),
    // its policies, then the parent's on top, stricter wins (keys outside its tools are inert)
    toolPolicies: stricterPolicies(own.toolPolicies ?? {}, a.parent.toolPolicies ?? {}),
    ...(skills !== undefined && {
      skills: {
        orgSkills: skills.orgSkills,
        ...(skills.pinned !== undefined && { pinned: skills.pinned }),
      },
    }),
  };
  return {
    definition,
    template: { source: "agent", id: agentId, version: a.orgAgent.version },
    maxSteps: d.config().runtime.maxSteps,
    warnings: [],
    model: own.model,
    tierFallback: false,
  };
}

/**
 * The effective definition of a sub-agent at its first dispatch (spec §5.3–§5.5):
 * - `general` / `inline` / `plugin`: the parent's definition narrowed by the template (tools by
 *   resolved key, `disallowedTools`, {@link CHILD_REMOVED_TOOLS}; policies stricter-wins), the
 *   template's instructions, pinned = the template's skills the parent selects (general pins
 *   nothing), `maxSteps = min(template ?? runtime.maxSteps, runtime.maxSteps)`, and the model tier
 *   `tier` (the call's) → the template's → `inherit`; an unmapped tier runs on the parent's model
 *   (`tierFallback`); a template `effort` is set when the resolved model declares it;
 * - `agent`: the org agent's version that passed the gates (`orgAgent`, from {@link checkOrgAgent}),
 *   its own tools minus the child-removed ones, its policies with the parent's on top (stricter
 *   wins), its skills and model; `tier` ignored.
 * The `subagents` block is never part of a child's definition (depth 1).
 */
export async function effectiveDefinition(
  d: EffectiveDefinitionDeps,
  a: {
    orgId: string;
    parent: AgentDefinition;
    parentAgentId: string;
    entry: RosterEntry;
    tier?: AgentTemplateTier;
    /** `source: "agent"`: the version and definition {@link checkOrgAgent} returned. */
    orgAgent?: CheckedOrgAgent;
  },
): Promise<EffectiveDefinition & { model: ModelRef; tierFallback: boolean }> {
  if (a.entry.source === "agent") return orgAgentDefinition(d, a);
  const runtimeMax = d.config().runtime.maxSteps;
  const { parent, entry } = a;

  let template: TemplateLike | null = null;
  let ref: EffectiveDefinition["template"] = { source: entry.source };
  if (entry.source === "inline") {
    template = parent.subagents?.inline?.find((t) => t.name === entry.type) ?? null;
    if (!template) throw new SubagentTypeGoneError(entry.type);
  } else if (entry.source === "plugin") {
    const row = (await loadTemplates(d.db, a.orgId, [entry.templateId ?? ""])).get(
      entry.templateId ?? "",
    );
    if (!row) throw new SubagentTypeGoneError(entry.type);
    template = row.template;
    ref = { source: "plugin", id: row.id, version: row.version, plugin: row.plugin };
  }

  const connectors = await loadConnectors(d.db, a.orgId, parent.tools);
  const tools = narrowTools(
    parent.tools,
    connectors,
    template?.tools !== undefined ? new Set(template.tools) : null,
    new Set(template?.disallowedTools ?? []),
  );
  const toolPolicies = stricterPolicies(parent.toolPolicies ?? {}, template?.toolPolicies ?? {});
  const { pinned, warnings } = await pinnedFor(
    d.db,
    a,
    template?.skills ?? [],
    entry.source === "plugin" ? { plugin: entry.plugin } : null,
  );
  const tier = a.tier ?? template?.model ?? "inherit";
  const m = await resolveTier(d, a.orgId, parent, tier);
  let modelParams = m.modelParams;
  if (template?.effort !== undefined) {
    const decl = await effortDecl(d.registry, m.model);
    if (decl) {
      const v = sanitizeParams([decl], { [decl.key]: template.effort }).value[decl.key];
      if (v !== undefined) modelParams = { ...modelParams, [decl.key]: v };
    }
  }
  const parentSkills = parent.skills;
  const definition: AgentDefinition = {
    name: childName(parent.name, entry.type),
    avatarUrl: parent.avatarUrl,
    instructions: template?.instructions ?? parent.instructions,
    model: m.model,
    fallback: m.fallback,
    modelParams,
    fallbackParams: m.fallbackParams,
    tools,
    toolPolicies,
    ...((parentSkills !== undefined || pinned.length > 0) && {
      skills: {
        orgSkills: parentSkills?.orgSkills ?? [],
        ...(pinned.length > 0 && { pinned }),
      },
    }),
  };
  return {
    definition,
    template: ref,
    maxSteps: Math.min(template?.maxSteps ?? runtimeMax, runtimeMax),
    warnings,
    model: m.model,
    tierFallback: m.tierFallback,
  };
}
