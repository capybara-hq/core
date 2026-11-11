import {
  type AgentTemplate,
  type AgentTemplateTier,
  type ModelParameter,
  sanitizeParams,
} from "@capybara-hq/plugin-sdk";
import {
  type AgentDefinition,
  canonicalDisabledSkills,
  canonicalDisabledTools,
  type DisabledSkillRef,
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
 * other than `ask` / `deny` (stored template data is not re-validated; an agent's connector-tool
 * `allow`, which the policy check reads from the agent's current version) are skipped on both sides.
 */
export function stricterPolicies(
  base: Record<string, string>,
  over: Record<string, string>,
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
    | "skills"]?: AgentTemplate[K] | undefined;
};

/** The `effort` declaration of `model`, or null (or when the model cannot be resolved). */
async function effortDecl(
  registry: Pick<ProviderRegistry, "resolve">,
  orgId: string,
  model: ModelRef,
): Promise<ModelParameter | null> {
  try {
    const { info } = await registry.resolve(orgId, model);
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
    // its own skills: what it turns off (skills default-on spec §6.1)
    disabledSkills: own.disabledSkills ?? [],
    ...(skills !== undefined && { skills }),
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
  // skills default-on (spec §6.1): nothing is pinned any more; the template's `skills` are left to
  // the sub-agent redesign (Task 2 of the plan)
  const warnings: string[] = [];
  const tier = a.tier ?? template?.model ?? "inherit";
  const m = await resolveTier(d, a.orgId, parent, tier);
  let modelParams = m.modelParams;
  if (template?.effort !== undefined) {
    const decl = await effortDecl(d.registry, a.orgId, m.model);
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
    // the parent's catalog (skills default-on spec §6.1)
    disabledSkills: parent.disabledSkills ?? [],
    ...(parentSkills !== undefined && { skills: parentSkills }),
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
 * turned-off tools and skills together with the current version's (it can lose tools and skills,
 * never gain them). Recorded on the follow-up's task message (`user_message.dispatch.narrowed`), so
 * the run and its replay read it from the log.
 */
export interface FollowUpNarrowing {
  /** Absent in logs from before tools were on by default (no tool narrowing then). */
  disabledTools?: DisabledToolRef[] | undefined;
  /** Absent in logs from before skills were on by default (skills default-on spec §6.1). */
  disabledSkills?: DisabledSkillRef[] | undefined;
  /** Older logs only: the frozen org skills intersected with the current ones. */
  skills?: { orgSkills: string[]; pinned?: string[] | undefined } | undefined;
}

/**
 * The narrowing of a follow-up (final review I1): `frozen` (the child's `subagent_started`
 * definition) against `current`, the definition a fresh dispatch would read now: the dispatching
 * parent run's version for `general` / inline / plugin children, the dispatched org agent's
 * current version for an org agent child (whose tools are its own at dispatch too, §5.5). Its
 * `disabledTools` and `disabledSkills` are both lists together.
 */
export function narrowFollowUp(
  frozen: Pick<AgentDefinition, "disabledTools" | "disabledSkills">,
  current: Pick<AgentDefinition, "disabledTools" | "disabledSkills">,
): FollowUpNarrowing {
  return {
    disabledTools: canonicalDisabledTools([
      ...(frozen.disabledTools ?? []),
      ...(current.disabledTools ?? []),
    ]),
    disabledSkills: canonicalDisabledSkills([
      ...(frozen.disabledSkills ?? []),
      ...(current.disabledSkills ?? []),
    ]),
  };
}

/**
 * The definition a child run uses: the frozen one with its trigger's follow-up narrowing. A
 * narrowing logged before tools (or skills) were on by default narrows nothing of that kind.
 */
export function childRunDefinition(
  frozen: AgentDefinition,
  narrowed: FollowUpNarrowing | undefined,
): AgentDefinition {
  if (narrowed === undefined) return frozen;
  return {
    ...frozen,
    ...(Array.isArray(narrowed.disabledTools) && { disabledTools: narrowed.disabledTools }),
    ...(Array.isArray(narrowed.disabledSkills) && { disabledSkills: narrowed.disabledSkills }),
  };
}
