import { type ModelParameter, validateParams } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { isRemovedBuiltinKey } from "../tools/builtin-names.js";
import {
  isLegacyBuiltinKey,
  isLegacyPrefixedKey,
  type LegacyScope,
  legacyToolKey,
} from "../tools/legacy-keys.js";
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
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The connectors and extensions a definition's own tool refs name (to read an ambiguous rc key). */
interface OwnRefs {
  connectors: ReadonlySet<string>;
  extensions: ReadonlySet<string>;
}

/**
 * The connector slugs and extension names `definition` names: connector refs (through
 * `scope.connectorSlugById`) and plugin refs of a frozen definition's `tools` or of
 * `disabledTools`, and current-format keys of a template's `tools`; `inherited` (the parent
 * agent's, for an inline template) is added.
 */
function ownRefs(definition: Record<string, unknown>, scope: LegacyScope, inherited?: OwnRefs) {
  const connectors = new Set(inherited?.connectors);
  const extensions = new Set(inherited?.extensions);
  const tools = [
    ...(Array.isArray(definition.tools) ? definition.tools : []),
    ...(Array.isArray(definition.disabledTools) ? definition.disabledTools : []),
  ];
  for (const r of tools) {
    if (typeof r === "string") {
      const m = /^(mcp|plugin)__([^_].*?)__./.exec(r);
      if (m) (m[1] === "mcp" ? connectors : extensions).add(m[2] as string);
    } else if (isRecord(r) && r.kind === "connector" && typeof r.connectorId === "string") {
      const slug = scope.connectorSlugById?.get(r.connectorId);
      if (slug !== undefined) connectors.add(slug);
    } else if (isRecord(r) && r.kind === "plugin" && typeof r.plugin === "string") {
      extensions.add(r.plugin);
    }
  }
  return { connectors, extensions };
}

/**
 * The current key(s) of a stored key. A builtin and an unambiguous `<x>__<tool>` map to one key
 * ({@link legacyToolKey}). When `x` is both a connector slug and an extension name, the
 * definition's own refs decide (only connector `x` -> `mcp__…`, only extension `x` ->
 * `plugin__…`); when they name both or neither, both candidates are returned and the caller
 * decides (a policy keeps a deny / ask on both: it must never be lost). Anything else: as is.
 */
function currentKeys(key: string, scope: LegacyScope | undefined, own: OwnRefs | undefined) {
  const one = legacyToolKey(key, scope);
  if (one !== null) return [one];
  if (scope === undefined || !isLegacyPrefixedKey(key)) return [key];
  const head = key.slice(0, key.indexOf("__"));
  if (!scope.connectorSlugs.has(head) || !scope.extensionNames.has(head)) return [key];
  const c = own?.connectors.has(head) === true;
  const e = own?.extensions.has(head) === true;
  if (c && !e) return [`mcp__${key}`];
  if (e && !c) return [`plugin__${key}`];
  return [`mcp__${key}`, `plugin__${key}`];
}

/**
 * A list of tool keys (a template's `tools` / `disallowedTools`) in current keys, deduplicated.
 * A still-ambiguous key becomes both candidates in a deny list (`widen`), and stays as is (inert,
 * so narrower) in an allowlist.
 */
function keyList(
  v: unknown,
  scope: LegacyScope | undefined,
  own: OwnRefs | undefined,
  widen: boolean,
): unknown {
  if (!Array.isArray(v)) return v;
  let changed = false;
  const out: unknown[] = [];
  for (const x of v) {
    let next: unknown[] = [x];
    if (typeof x === "string") {
      const keys = currentKeys(x, scope, own);
      next = keys.length > 1 && !widen ? [x] : keys;
    }
    if (next.length !== 1 || next[0] !== x) changed = true;
    for (const n of next) {
      if (typeof n === "string" && out.includes(n)) {
        changed = true;
        continue;
      }
      out.push(n);
    }
  }
  return changed ? out : v;
}

/**
 * `toolPolicies` in current keys; keys that become one keep the stricter policy, and a
 * still-ambiguous key keeps its `ask` / `deny` on both candidates (anything else is dropped).
 */
function policyKeys(v: unknown, scope: LegacyScope | undefined, own: OwnRefs | undefined) {
  if (!isRecord(v)) return v;
  const mapped = Object.entries(v).map(([k, p]) => [k, p, currentKeys(k, scope, own)] as const);
  if (mapped.every(([k, , keys]) => keys.length === 1 && keys[0] === k)) return v;
  const rank = (p: unknown) => (p === "deny" ? 2 : p === "ask" ? 1 : 0);
  const out: Record<string, unknown> = {};
  for (const [, p, keys] of mapped) {
    if (keys.length > 1 && rank(p) === 0) continue;
    for (const next of keys) {
      if (!Object.hasOwn(out, next) || rank(p) > rank(out[next])) out[next] = p;
    }
  }
  return out;
}

/**
 * A definition's `tools`: a template's allowlist of keys, or the refs of a definition frozen into
 * history before tools were on by default (builtin refs by their current names).
 */
function toolRefs(v: unknown, scope: LegacyScope | undefined, own: OwnRefs | undefined): unknown {
  if (!Array.isArray(v)) return v;
  // template-shaped (`tools: string[]`): an allowlist
  if (v.some((x) => typeof x === "string")) return keyList(v, scope, own, false);
  if (
    !v.some(
      (r) =>
        isRecord(r) &&
        r.kind === "builtin" &&
        typeof r.name === "string" &&
        isLegacyBuiltinKey(r.name),
    )
  ) {
    return v;
  }
  return v.map((r) =>
    isRecord(r) && r.kind === "builtin" && typeof r.name === "string"
      ? { ...r, name: legacyToolKey(r.name) ?? r.name }
      : r,
  );
}

/**
 * Release-candidate tool keys in a stored definition, read as current keys (tool naming spec
 * §8.3), the way {@link normalizeToolRef} reads the app -> connector rename: builtin refs in
 * `tools`, the keys of `toolPolicies`, and the `tools` / `disallowedTools` / `toolPolicies` of a
 * template, the agent's inline sub-agent templates included. Works on an agent definition and on
 * an agent template alike. Old builtin names map without `scope`; an rc `<x>__<tool>` key maps
 * only with one (the org's connector slugs and their ids, the deployment's extension names). When
 * `x` is both a slug and an extension name, the definition's own tool refs decide; when they
 * cannot, a policy or a deny list keeps the restriction on both candidate keys (a deny is never
 * lost) and an allowlist keeps the old key (inert). An unknown key stays as it is. Keys in the
 * current format are never touched. Returns the same object when nothing changes. Saving never
 * goes through this: a new definition with an old key is refused (`AgentsService`).
 */
export function normalizeToolKeys(
  definition: unknown,
  scope?: LegacyScope,
  inherited?: OwnRefs,
): unknown {
  if (!isRecord(definition)) return definition;
  const own = scope === undefined ? undefined : ownRefs(definition, scope, inherited);
  const next: Record<string, unknown> = { ...definition };
  let changed = false;
  const put = (field: string, value: unknown) => {
    if (value === definition[field]) return;
    next[field] = value;
    changed = true;
  };
  if ("tools" in definition) put("tools", toolRefs(definition.tools, scope, own));
  if ("disallowedTools" in definition) {
    put("disallowedTools", keyList(definition.disallowedTools, scope, own, true));
  }
  if ("toolPolicies" in definition) {
    put("toolPolicies", policyKeys(definition.toolPolicies, scope, own));
  }
  const sub = definition.subagents;
  if (isRecord(sub) && Array.isArray(sub.inline)) {
    const inline = sub.inline.map((t) => normalizeToolKeys(t, scope, own));
    if (inline.some((t, i) => t !== (sub.inline as unknown[])[i])) {
      put("subagents", { ...sub, inline });
    }
  }
  return changed ? next : definition;
}

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
 * Does a stored definition or template hold an rc `<x>__<tool>` key, which only a
 * {@link LegacyScope} can map? (Callers load the scope only then.)
 */
export function needsLegacyScope(definition: unknown): boolean {
  if (!isRecord(definition)) return false;
  const lists = [definition.tools, definition.disallowedTools];
  for (const l of lists) {
    if (Array.isArray(l) && l.some((x) => typeof x === "string" && isLegacyPrefixedKey(x))) {
      return true;
    }
  }
  if (isRecord(definition.toolPolicies)) {
    if (Object.keys(definition.toolPolicies).some(isLegacyPrefixedKey)) return true;
  }
  const sub = definition.subagents;
  return isRecord(sub) && Array.isArray(sub.inline) && sub.inline.some(needsLegacyScope);
}

/**
 * A tool ref of a definition frozen into history (logs, eval case snapshots) before tools were on
 * by default (tools default-on spec §2): `{ kind: "app", appId }` (before D17) reads as a
 * connector ref. Other values are returned as they are.
 */
function normalizeToolRef(v: unknown): unknown {
  if (!isRecord(v) || v.kind !== "app") return v;
  const { kind: _kind, appId, ...rest } = v;
  return { kind: "connector", connectorId: appId, ...rest };
}

/**
 * A definition read from the database or from history (not parsed by zod): rc tool keys read as
 * current keys ({@link normalizeToolKeys}: builtins always, `<x>__<tool>` keys with `scope`), and
 * a definition from before tools were on by default (an enabled `tools` list, history only: the
 * migration rewrote stored versions) reads as nothing turned off, which is what the migration
 * writes (tools default-on spec §2, §3). Likewise a definition from before skills were on by
 * default (`skills.orgSkills` / `skills.pinned`) reads as no skill turned off (skills default-on
 * spec §4; migration 0116 rewrote stored versions). Other fields are kept; without old forms the
 * same object is returned.
 */
export function normalizeStoredDefinition(def: unknown, scope?: LegacyScope): AgentDefinition {
  let d = def as Record<string, unknown>;
  const tools = d.tools;
  if (Array.isArray(tools) && tools.some((t) => isRecord(t) && t.kind === "app")) {
    d = { ...d, tools: tools.map(normalizeToolRef) };
  }
  d = normalizeToolKeys(d, scope) as Record<string, unknown>;
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
