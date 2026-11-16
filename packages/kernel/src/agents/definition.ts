import { type ModelParameter, validateParams } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { AgentAttributionSchema } from "../attribution/platform-attribution.js";
import { isRemovedBuiltinKey } from "../tools/builtin-names.js";
import { InstructionFilesSchema } from "./instruction-files.js";

/** 模型引用：供应商插件名 + 模型 id。 */
export const ModelRef = z.object({ provider: z.string(), model: z.string() });
export type ModelRef = z.infer<typeof ModelRef>;

/**
 * 模型参数（键为插件声明的参数键）：只接受标量；按该模型的 `parameters` 声明校验在 `AgentsService`
 * 中进行（保存时严格，运行时宽松，见 plugin-sdk `validateParams` / `sanitizeParams`）。
 */
export const ModelParams = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type ModelParams = z.infer<typeof ModelParams>;

/**
 * A tool an agent turns off (tools default-on spec §2): agents have every builtin, every tool of
 * the extensions enabled in the org and every tool of the org's connectors, minus these. A builtin
 * by name; an extension's or a connector's tools by name, or `"all"` to turn it off as a unit
 * (tools it gains later included). Connectors by id, so a renamed connector stays off.
 */
export const DisabledToolRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("builtin"), name: z.string().min(1).max(200) }).strict(),
  z
    .object({
      kind: z.literal("plugin"),
      plugin: z.string().min(1).max(200),
      tools: z.union([z.literal("all"), z.array(z.string().min(1).max(256)).min(1).max(500)]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("connector"),
      connectorId: z.string().min(1).max(100),
      tools: z.union([z.literal("all"), z.array(z.string().min(1).max(256)).min(1).max(500)]),
    })
    .strict(),
]);
export type DisabledToolRef = z.output<typeof DisabledToolRef>;

/** Is builtin `name` turned off by `disabled`? */
export const builtinDisabled = (
  disabled: readonly DisabledToolRef[] | undefined,
  name: string,
): boolean => (disabled ?? []).some((r) => r.kind === "builtin" && r.name === name);

/** Is tool `name` of extension `plugin` turned off by `disabled`? */
export const extensionToolDisabled = (
  disabled: readonly DisabledToolRef[] | undefined,
  plugin: string,
  name: string,
): boolean =>
  (disabled ?? []).some(
    (r) =>
      r.kind === "plugin" && r.plugin === plugin && (r.tools === "all" || r.tools.includes(name)),
  );

/** Is tool `name` of connector `connectorId` turned off by `disabled`? */
export const connectorToolDisabled = (
  disabled: readonly DisabledToolRef[] | undefined,
  connectorId: string,
  name: string,
): boolean =>
  (disabled ?? []).some(
    (r) =>
      r.kind === "connector" &&
      r.connectorId === connectorId &&
      (r.tools === "all" || r.tools.includes(name)),
  );

/**
 * `disabled` in its canonical form: one entry per builtin, extension and connector (in first-seen
 * order), names deduplicated and sorted, `"all"` absorbing names. Saving stores this form, so two
 * lists that turn off the same tools compare equal.
 */
export function canonicalDisabledTools(disabled: readonly DisabledToolRef[]): DisabledToolRef[] {
  const out: DisabledToolRef[] = [];
  const merge = (cur: "all" | string[], add: "all" | string[]): "all" | string[] =>
    cur === "all" || add === "all" ? "all" : [...new Set([...cur, ...add])].sort();
  for (const r of disabled) {
    if (r.kind === "builtin") {
      if (!builtinDisabled(out, r.name)) out.push({ kind: "builtin", name: r.name });
      continue;
    }
    const prev = out.find(
      (x) =>
        x.kind === r.kind &&
        (r.kind === "plugin"
          ? (x as { plugin?: string }).plugin === r.plugin
          : (x as { connectorId?: string }).connectorId === r.connectorId),
    ) as Extract<DisabledToolRef, { tools: unknown }> | undefined;
    if (prev) prev.tools = merge(prev.tools, r.tools);
    else out.push({ ...r, tools: r.tools === "all" ? "all" : [...new Set(r.tools)].sort() });
  }
  return out;
}

/**
 * A skill an agent turns off (skills default-on spec §4): a plugin's skills by name, or `"all"` to
 * turn the plugin off as a unit (skills it gains later included); a skill without a plugin (the
 * org's own, shared or promoted ones) by id, since its name may change under the same id.
 */
export const DisabledSkillRef = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("plugin"),
      plugin: z.string().min(1).max(200),
      skills: z.union([z.literal("all"), z.array(z.string().min(1).max(64)).min(1).max(500)]),
    })
    .strict(),
  z.object({ kind: z.literal("skill"), skillId: z.string().min(1).max(100) }).strict(),
]);
export type DisabledSkillRef = z.output<typeof DisabledSkillRef>;

/**
 * Is a skill turned off by `disabled`? `plugin` and `name` match a plugin entry; `ids` (the
 * skill's id and, for a linked or promoted copy, the platform skill it serves) a skill entry.
 */
export function skillDisabled(
  disabled: readonly DisabledSkillRef[] | undefined,
  skill: { plugin: string | null; name: string; ids: readonly string[] },
): boolean {
  return (disabled ?? []).some((r) =>
    r.kind === "plugin"
      ? skill.plugin !== null &&
        r.plugin === skill.plugin &&
        (r.skills === "all" || r.skills.includes(skill.name))
      : skill.ids.includes(r.skillId),
  );
}

/**
 * `disabled` in its canonical form: one entry per plugin (sorted by plugin, `"all"` absorbing
 * names, names deduplicated and sorted, an empty list dropped), then the skill entries deduplicated
 * and sorted by id. Saving stores this form, so two lists that turn off the same skills compare
 * equal.
 */
export function canonicalDisabledSkills(disabled: readonly DisabledSkillRef[]): DisabledSkillRef[] {
  const plugins: Extract<DisabledSkillRef, { kind: "plugin" }>[] = [];
  const ids = new Set<string>();
  for (const r of disabled) {
    if (r.kind === "skill") {
      ids.add(r.skillId);
      continue;
    }
    const names = r.skills;
    const prev = plugins.find((x) => x.plugin === r.plugin);
    if (prev) {
      prev.skills =
        prev.skills === "all" || names === "all"
          ? "all"
          : [...new Set([...prev.skills, ...names])].sort();
    } else {
      plugins.push({
        kind: "plugin",
        plugin: r.plugin,
        skills: names === "all" ? "all" : [...new Set(names)].sort(),
      });
    }
  }
  return [
    ...plugins
      .filter((p) => p.skills === "all" || p.skills.length > 0)
      .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0)),
    ...[...ids].sort().map((skillId) => ({ kind: "skill" as const, skillId })),
  ];
}

/**
 * A sub-agent's tool filter by tool key (tools default-on spec §4): written only into a child's
 * effective definition at dispatch (never accepted on save). `deny` removes keys (the child-removed
 * tools, `Agent` at the depth limit, a template's `disallowedTools`); `allow`, when set, keeps only
 * its keys (a template's `tools` allowlist). Registry-managed tools (`Skill`, `ToolSearch`,
 * `SendMessage`, `SubagentHandback`) are not filtered.
 */
export const SubagentToolsSchema = z
  .object({
    allow: z.array(z.string().min(1).max(300)).max(500).optional(),
    deny: z.array(z.string().min(1).max(300)).max(500).optional(),
  })
  .strict();
export type SubagentTools = z.infer<typeof SubagentToolsSchema>;

/** Roster names of inline templates and allowlisted org agents (the template name rule). */
export const SUBAGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A sub-agent template written in the agent definition (phase C, spec §5.2): the fields of a
 * plugin agent template (`AgentTemplate`, spec §16.1), with `skills` as skill ids (skills the agent
 * has, skills default-on spec §6.1) instead of names. Names and skills are checked on save
 * (`agent.subagents_invalid`); the schema only bounds the input.
 */
export const InlineAgentTemplate = z
  .object({
    name: z.string().min(1).max(64),
    description: z.string().min(1).max(4096),
    instructions: z.string().min(1).max(100_000),
    tools: z.array(z.string().min(1).max(200)).max(200).optional(),
    disallowedTools: z.array(z.string().min(1).max(200)).max(200).optional(),
    toolPolicies: z.record(z.string(), z.enum(["ask", "deny"])).optional(),
    model: z.enum(["inherit", "fast", "standard", "capable"]).optional(),
    effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
    maxSteps: z.number().int().min(1).max(10_000).optional(),
    skills: z.array(z.string().min(1).max(100)).max(3).optional(),
  })
  .strict();
export type InlineAgentTemplate = z.infer<typeof InlineAgentTemplate>;

/**
 * Sub-agents this agent may dispatch with the builtin `Agent` tool (phase C, spec §5.2). No
 * default: definitions without it are unchanged and gain no version.
 */
export const SubagentsSchema = z
  .object({
    /** Offer general-purpose (a copy of this agent). Default true. */
    general: z.boolean().optional(),
    /** Org agent template ids (installed from plugins), in roster order. */
    templates: z.array(z.string().min(1).max(100)).max(20).optional(),
    /** Templates written here. */
    inline: z.array(InlineAgentTemplate).max(10).optional(),
    /** Other org agents this agent may dispatch (§5.5), in roster order. */
    agents: z
      .array(
        z
          .object({
            agentId: z.string().min(1).max(100),
            /** Roster name (`subagent_type`), the template name rule. */
            as: z.string().min(1).max(64),
            /** When to use it; shown in the tool description. */
            description: z.string().min(1).max(1024),
          })
          .strict(),
      )
      .max(10)
      .optional(),
    /** Other agents may dispatch this agent (§5.5). Default false. */
    dispatchable: z.boolean().optional(),
  })
  .strict();
export type Subagents = z.infer<typeof SubagentsSchema>;

/** The key rule of a pending connector (`[a-z0-9-]`, URL-safe: it names the bind route). */
export const PENDING_CONNECTOR_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Pending connectors an agent may carry (the template's `connectors` limit). */
export const PENDING_CONNECTORS_MAX = 16;

/**
 * A connector the template the agent was created from needs and the org has not bound yet
 * (ruling P4-6): `source.template` is the platform connector template's id, `source.needs` a
 * hand-configured connector described by protocol, endpoint and tools (P4-11). `tools` are the
 * tool names to enable once bound (absent = all of a template's tools), `policies` the template's
 * tightened policies by tool name, applied by the bind. Never model-visible: tools are built from
 * `tools` only, and a pending connector has none. Text limits are twice the template's (which
 * counts code points) so any parsed template fits (this schema counts UTF-16 units).
 */
const PendingToolName = z.string().min(1).max(256);
export const PendingConnectorSchema = z
  .object({
    key: z.string().regex(PENDING_CONNECTOR_KEY_RE),
    label: z.string().min(1).max(160),
    source: z.union([
      z.object({ template: z.string().min(1).max(100) }).strict(),
      z
        .object({
          needs: z
            .object({
              protocol: z.enum(["mcp", "openapi"]),
              endpoint: z.string().min(1).max(4096),
              tools: z.array(PendingToolName).max(200),
              label: z.string().min(1).max(160),
            })
            .strict(),
        })
        .strict(),
    ]),
    tools: z.array(PendingToolName).max(200).optional(),
    policies: z
      .record(PendingToolName, z.enum(["ask", "deny"]))
      .refine((p) => Object.keys(p).length <= 200, "at most 200 policies")
      .optional(),
  })
  .strict();
export type PendingConnector = z.infer<typeof PendingConnectorSchema>;

/** Agent 定义：每次变化写一个新版本（`capybara.agent_versions`）。 */
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  /**
   * What the agent is for, one short paragraph (run context spec §3.5): shown on the agent's
   * cards (copied to `agents.profile_description`) and given to the model in the run context. No
   * default: older versions are unchanged and gain no version. A save without it keeps the
   * current version's; `""` removes it.
   */
  description: z.string().max(500).optional(),
  avatarUrl: z.url().nullable().default(null),
  /**
   * The model-visible system prompt. Derived on save from `instructionFiles` when they are given
   * (`deriveInstructions`); every reader (build.ts, the sub-agent copy, evals, replay) reads this.
   */
  instructions: z.string().max(100_000).default(""),
  /**
   * The prompt files, the authoring form of `instructions` (spec 2026-11-04 §3.3). No default:
   * definitions without it (every older version) read as one `AGENTS.md` and gain no version.
   */
  instructionFiles: InstructionFilesSchema.optional(),
  model: ModelRef,
  fallback: ModelRef.nullable().default(null),
  /** 主模型的参数（按主模型的声明校验）。 */
  modelParams: ModelParams.default({}),
  /** 兜底模型自己的参数（按兜底模型的声明校验）；兜底尝试只用这一份。 */
  fallbackParams: ModelParams.default({}),
  /**
   * The tools this agent turns off (tools default-on spec §2); everything else the org offers is
   * on. Saved in canonical form ({@link canonicalDisabledTools}); checked on save.
   */
  disabledTools: z.array(DisabledToolRef).max(500).default([]),
  /**
   * A sub-agent's key filter, set only on a child's effective definition at dispatch (see
   * {@link SubagentToolsSchema}); a save that carries it is refused.
   */
  subagentTools: SubagentToolsSchema.optional(),
  /**
   * Policies by tool key; keys are tools the agent could have (on or turned off). `ask` / `deny`
   * tighten any tool. `allow` is accepted only on a connector tool key and counts only for a
   * personal-credential connector's tool (decision 2026-11-09): it overrides the org default and
   * the member's own 询问, never the org's or the member's 禁止 (`tools/policy.ts`
   * `connectorPolicy`); on any other tool it changes nothing. Older definitions without it read as
   * empty.
   */
  toolPolicies: z.record(z.string(), z.enum(["allow", "ask", "deny"])).default({}),
  /**
   * The skills this agent turns off (skills default-on spec §4); every other skill on in the org
   * is on for it, and its own and shared skills always are. Saved in canonical form
   * ({@link canonicalDisabledSkills}); checked on save.
   */
  disabledSkills: z.array(DisabledSkillRef).max(500).default([]),
  /**
   * `writePolicy`: whether registering a skill on a private agent (`agents.register-skill`) needs
   * the person's confirmation; absent means `allow`. On a shared agent a registration is always
   * confirmed at the org level. No default: definitions without it gain no version.
   */
  skills: z
    .object({
      writePolicy: z.enum(["allow", "ask"]).optional(),
    })
    .strict()
    .optional(),
  /** Sub-agents (phase C); offered unless the builtin `Agent` tool is turned off. */
  subagents: SubagentsSchema.optional(),
  /**
   * Connectors still to configure (ruling P4-6), written only by creating from a template. No
   * default: definitions without it are unchanged. Model-invisible.
   */
  pendingConnectors: z.array(PendingConnectorSchema).max(PENDING_CONNECTORS_MAX).optional(),
  /**
   * The attribution line of git commits and pull requests this agent creates (spec
   * 2026-11-14-agent-attribution): `inherit` (or absent) follows the deployment defaults, `custom`
   * uses its own values, `off` adds nothing. No default: definitions without it are unchanged.
   */
  attribution: AgentAttributionSchema.optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The fields {@link withoutRemovedBuiltinPolicies} reads. */
interface AgentDefinitionLike {
  toolPolicies?: Record<string, string> | undefined;
  subagents?:
    | { inline?: readonly { toolPolicies?: Record<string, string> | undefined }[] | undefined }
    | undefined;
}

/**
 * `definition` without the `toolPolicies` keys (its own and its inline sub-agents') of builtins
 * that no longer exist ({@link isRemovedBuiltinKey}): applied to a definition being saved, so a
 * key left over from a removed builtin never blocks the save. Returns the same object when
 * nothing is dropped.
 */
export function withoutRemovedBuiltinPolicies<T extends AgentDefinitionLike>(definition: T): T {
  type Policies = Record<string, string> | undefined;
  const strip = (p: Policies): Policies => {
    if (p === undefined || !Object.keys(p).some(isRemovedBuiltinKey)) return p;
    return Object.fromEntries(Object.entries(p).filter(([k]) => !isRemovedBuiltinKey(k)));
  };
  let next: T = definition;
  const policies = strip(definition.toolPolicies);
  if (policies !== definition.toolPolicies) next = { ...next, toolPolicies: policies };
  const inline = definition.subagents?.inline;
  if (inline !== undefined) {
    const stripped = inline.map((t) => {
      const p = strip(t.toolPolicies);
      return p === t.toolPolicies ? t : { ...t, toolPolicies: p };
    });
    if (stripped.some((t, i) => t !== inline[i])) {
      next = { ...next, subagents: { ...definition.subagents, inline: stripped } };
    }
  }
  return next;
}

/**
 * A definition read from the database or from history (not parsed by zod): a definition from
 * before tools were on by default (an enabled `tools` list, history only: the
 * migration rewrote stored versions) reads as nothing turned off, which is what the migration
 * writes (tools default-on spec §2, §3). Likewise a definition from before skills were on by
 * default (`skills.orgSkills` / `skills.pinned`) reads as no skill turned off (skills default-on
 * spec §4; migration 0116 rewrote stored versions). Other fields are kept; without old forms the
 * same object is returned.
 */
export function normalizeStoredDefinition(def: unknown): AgentDefinition {
  let d = def as Record<string, unknown>;
  if ("tools" in d) {
    const { tools: _enabled, ...rest } = d;
    d = { ...rest, disabledTools: Array.isArray(d.disabledTools) ? d.disabledTools : [] };
  } else if (!Array.isArray(d.disabledTools)) {
    d = { ...d, disabledTools: [] };
  }
  // before skills were on by default (skills default-on spec §4, §5): selected and pinned skills
  // read as nothing turned off, which is what migration 0116 writes
  if (isRecord(d.skills) && ("orgSkills" in d.skills || "pinned" in d.skills)) {
    const { orgSkills: _o, pinned: _p, ...keep } = d.skills;
    const { skills: _s, ...rest } = d;
    d = Object.keys(keep).length > 0 ? { ...rest, skills: keep } : rest;
  }
  if (!Array.isArray(d.disabledSkills)) d = { ...d, disabledSkills: [] };
  // an attribution mode other than inherit / custom / off (stored data is not re-validated) reads
  // as inherit, the value the kernel applies and the agent page shows (spec 2026-11-14)
  const attribution = d.attribution;
  if (
    isRecord(attribution) &&
    attribution.mode !== undefined &&
    attribution.mode !== "inherit" &&
    attribution.mode !== "custom" &&
    attribution.mode !== "off"
  ) {
    d = { ...d, attribution: { ...attribution, mode: "inherit" } };
  }
  return d as AgentDefinition;
}

/** 按模型声明严格校验一组参数，返回 `{ path: "<field>.<key>", message }[]`（评测候选也用它）。 */
export function paramIssues(
  field: string,
  decl: ModelParameter[],
  params: Record<string, unknown>,
): { path: string; message: string }[] {
  const r = validateParams(decl, params);
  return r.ok ? [] : r.issues.map((i) => ({ path: `${field}.${i.key}`, message: i.message }));
}

/** Roster entries an agent may list (spec §4.3), general-purpose included. */
export const SUBAGENT_ROSTER_MAX = 20;
