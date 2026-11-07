import {
  type AgentTemplate,
  type AgentTemplateTier,
  type ModelParameter,
  SKILL_ENTRY_FILE,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import {
  type AgentDefinition,
  canonicalDisabledTools,
  type DisabledToolRef,
  type ModelRef,
  type SubagentTools,
} from "../../agents/definition.js";
import { loadTemplates } from "../../agents/templates.js";
import type { EventPayload } from "../../conversations/events.js";
import type { KernelSchemaDb } from "../../db/kernel-schema.js";
import { ApiError } from "../../errors.js";
import type { KernelConfigService } from "../../infra/config/kernel-config.service.js";
import type { ModelPurposesService } from "../../models/purposes.js";
import { PINNED_SKILLS_LIMITS } from "../../skills/catalog.js";
import { selectedSkills } from "../../skills/usable.js";
import { AGENT_TOOL, CHILD_REMOVED_TOOLS } from "../../tools/builtin-names.js";
import type { ProviderRegistry } from "../providers.js";
import type { RosterEntry } from "./roster.js";

export { CHILD_REMOVED_TOOLS } from "../../tools/builtin-names.js";

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
  db: KernelSchemaDb;
  purposes: Pick<ModelPurposesService, "resolve">;
  /** Reads the resolved model's parameter declarations (a template `effort`). */
  registry: Pick<ProviderRegistry, "resolve">;
  config: Pick<KernelConfigService, "get">;
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

/**
 * A child's key filter (tools default-on spec §4): `deny` = the parent's own filter's (a nested
 * child), {@link CHILD_REMOVED_TOOLS}, `Agent` when the child is at the depth limit, and the
 * template's `disallowedTools`; `allow` = the template's `tools` allowlist met with the parent's
 * (absent on both = everything the parent has). Keys are deduplicated in first-seen order.
 */
function childFilter(
  removeAgent: boolean,
  template: {
    tools?: readonly string[] | undefined;
    disallowedTools?: readonly string[] | undefined;
  } | null,
  parent?: SubagentTools,
): SubagentTools {
  const deny = [
    ...new Set<string>([
      ...(parent?.deny ?? []),
      ...CHILD_REMOVED_TOOLS,
      ...(removeAgent ? [AGENT_TOOL] : []),
      ...(template?.disallowedTools ?? []),
    ]),
  ];
  const own = template?.tools === undefined ? undefined : [...new Set(template.tools)];
  const allow =
    own === undefined
      ? parent?.allow
      : parent?.allow === undefined
        ? own
        : own.filter((k) => parent.allow?.includes(k));
  return { ...(allow !== undefined && { allow: [...allow] }), deny };
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
    | "skills"
    | "selectedSkills"]?: AgentTemplate[K] | undefined;
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
  db: KernelSchemaDb,
  a: { orgId: string; parent: AgentDefinition; parentAgentId: string },
  refs: readonly string[],
  byName: { plugin: string | undefined } | null,
  /** Further names the template lists (`selectedSkills`): resolved the same way, never pinned. */
  selected: readonly string[] = [],
): Promise<{ pinned: string[]; warnings: string[] }> {
  if (refs.length === 0 && selected.length === 0) return { pinned: [], warnings: [] };
  // org and agent skills, linked org copies and platform skills on in the org (phase 2), by id
  const rows: SkillRow[] = (
    await selectedSkills(db, {
      orgId: a.orgId,
      agentId: a.parentAgentId,
      orgSkills: a.parent.skills?.orgSkills ?? [],
    })
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
  for (const ref of selected) {
    if (refs.includes(ref)) continue;
    if (!match(ref)) {
      warnings.push(`The skill "${ref}" is not available: the agent does not select it.`);
    }
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

/** Where a new child sits (agent map spec §6): its depth below the root and the tree's limit. */
export interface ChildDepth {
  /** The child's depth: 1 for a child of a root conversation. */
  childDepth: number;
  /** `subagents.maxDepth` for the organization; a child at it never gets `Agent`. */
  maxDepth: number;
}

const atMaxDepth = (a: ChildDepth) => a.childDepth >= a.maxDepth;

function orgAgentDefinition(
  d: EffectiveDefinitionDeps,
  a: ChildDepth & { parent: AgentDefinition; entry: RosterEntry; orgAgent?: CheckedOrgAgent },
): EffectiveDefinition & { model: ModelRef; tierFallback: boolean } {
  // the version the gates checked (checkOrgAgent), never read again here: a version saved in
  // between could be one the gates never saw (batch 3 review M1)
  if (a.orgAgent === undefined) {
    throw new Error(`org agent ${a.entry.type} dispatched without its checked version`);
  }
  const agentId = a.entry.agentId ?? "";
  const own = a.orgAgent.definition;
  // prompt files are authoring data: the child's model sees only `instructions` (their join), and
  // `subagent_started.definition` keeps its shape (spec 2026-11-04 §3.3); its own `subagents`
  // block stays: it is the roster the child dispatches from (agent map spec §4.1); pending
  // connectors are authoring data too (ruling P4-6)
  const { skills, instructionFiles: _files, pendingConnectors: _pending, ...rest } = own;
  const { subagentTools: _filter, ...ownRest } = rest;
  const definition: AgentDefinition = {
    ...ownRest,
    // its own tools, not intersected with the parent's; only the child-removed ones go
    disabledTools: own.disabledTools ?? [],
    subagentTools: childFilter(atMaxDepth(a), null),
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
    maxSteps: d.config.get().runtime.maxSteps,
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
 *   wins), its skills, model and `subagents` block; `tier` ignored.
 * Nesting (agent map spec §4.1): `Agent` stays unless the child is at `maxDepth`; the frozen
 * definition keeps a `subagents` block, the roster the child dispatches from: an org agent's own,
 * otherwise the parent definition's (a general-purpose, inline or plugin child inherits it).
 */
export async function effectiveDefinition(
  d: EffectiveDefinitionDeps,
  a: ChildDepth & {
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
  const runtimeMax = d.config.get().runtime.maxSteps;
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
    ref = {
      source: "plugin",
      id: row.id,
      version: row.version,
      ...(row.plugin ? { plugin: row.plugin } : {}),
      ...(row.platformTemplateId !== undefined && { platformTemplateId: row.platformTemplateId }),
    };
  }

  const toolPolicies = stricterPolicies(parent.toolPolicies ?? {}, template?.toolPolicies ?? {});
  const { pinned, warnings } = await pinnedFor(
    d.db,
    a,
    template?.skills ?? [],
    entry.source === "plugin" ? { plugin: entry.plugin } : null,
    template?.selectedSkills ?? [],
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
    disabledTools: parent.disabledTools ?? [],
    subagentTools: childFilter(atMaxDepth(a), template, parent.subagentTools),
    toolPolicies,
    ...((parentSkills !== undefined || pinned.length > 0) && {
      skills: {
        orgSkills: parentSkills?.orgSkills ?? [],
        ...(pinned.length > 0 && { pinned }),
      },
    }),
    ...(parent.subagents !== undefined && { subagents: parent.subagents }),
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

/**
 * What a follow-up (`resume`) may still use (final review I1, spec §5.3): the frozen definition's
 * turned-off tools together with the current version's (it can lose tools, never gain them), and
 * the frozen org skills intersected with the current ones. Recorded on the follow-up's task message
 * (`user_message.dispatch.narrowed`), so the run and its replay read it from the log.
 */
export interface FollowUpNarrowing {
  /** Absent in logs from before tools were on by default (no tool narrowing then). */
  disabledTools?: DisabledToolRef[] | undefined;
  skills?: { orgSkills: string[]; pinned?: string[] | undefined } | undefined;
}

/**
 * The narrowing of a follow-up (final review I1): `frozen` (the child's `subagent_started`
 * definition) against `current`, the definition a fresh dispatch would read now: the dispatching
 * parent run's version for `general` / inline / plugin children, the dispatched org agent's
 * current version for an org agent child (whose tools are its own at dispatch too, §5.5). Its
 * `disabledTools` are both lists together; its `orgSkills` keep only those `current` still
 * selects; a pinned id that was one of the frozen org skills goes with it (the agent's own skills
 * stay).
 */
export function narrowFollowUp(
  frozen: Pick<AgentDefinition, "disabledTools" | "skills">,
  current: Pick<AgentDefinition, "disabledTools" | "skills">,
): FollowUpNarrowing {
  const disabledTools = canonicalDisabledTools([
    ...(frozen.disabledTools ?? []),
    ...(current.disabledTools ?? []),
  ]);
  if (frozen.skills === undefined) return { disabledTools };
  const frozenOrg = new Set(frozen.skills.orgSkills);
  const now = new Set(current.skills?.orgSkills ?? []);
  const orgSkills = frozen.skills.orgSkills.filter((id) => now.has(id));
  const pinned = frozen.skills.pinned?.filter((id) => !frozenOrg.has(id) || now.has(id));
  return { disabledTools, skills: { orgSkills, ...(pinned !== undefined && { pinned }) } };
}

/**
 * The definition a child run uses: the frozen one with its trigger's follow-up narrowing. A
 * narrowing logged before tools were on by default (no `disabledTools`) narrows only skills.
 */
export function childRunDefinition(
  frozen: AgentDefinition,
  narrowed: FollowUpNarrowing | undefined,
): AgentDefinition {
  if (narrowed === undefined) return frozen;
  const { skills, ...rest } = frozen;
  const kept =
    skills === undefined || narrowed.skills === undefined
      ? skills
      : {
          ...skills,
          orgSkills: narrowed.skills.orgSkills,
          ...(narrowed.skills.pinned !== undefined && { pinned: narrowed.skills.pinned }),
        };
  return {
    ...rest,
    ...(Array.isArray(narrowed.disabledTools) && { disabledTools: narrowed.disabledTools }),
    ...(kept !== undefined && { skills: kept }),
  };
}
