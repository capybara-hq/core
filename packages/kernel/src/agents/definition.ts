import { type ModelParameter, validateParams } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import {
  isLegacyBuiltinKey,
  isLegacyPrefixedKey,
  type LegacyScope,
  legacyToolKey,
} from "../tools/legacy-keys.js";

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
 * 改名前（D17）保存的连接器引用 `{ kind: "app", appId, tools }` 规范化为 `{ kind: "connector", connectorId, tools }`
 * （C27：已存 agent 版本不改写，读入时规范化；新保存只写 connector 形）。其余值原样返回。
 */
export function normalizeToolRef(v: unknown): unknown {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return v;
  const r = v as Record<string, unknown>;
  if (r.kind !== "app") return v;
  const { kind: _kind, appId, ...rest } = r;
  return { kind: "connector", connectorId: appId, ...rest };
}

/**
 * agent 定义里对工具的引用：内置工具按名字；插件工具按插件名 + 工具名；连接器工具按连接器 id，
 * `tools: "all"` = 该连接器当前所有启用的工具。旧形 `{ kind: "app", appId }` 仍可解析（见 {@link normalizeToolRef}）。
 */
export const AgentToolRef = z.preprocess(
  normalizeToolRef,
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("builtin"), name: z.string().min(1) }).strict(),
    z
      .object({ kind: z.literal("plugin"), plugin: z.string().min(1), name: z.string().min(1) })
      .strict(),
    z
      .object({
        kind: z.literal("connector"),
        connectorId: z.string().min(1),
        tools: z.union([z.literal("all"), z.array(z.string().min(1)).min(1)]),
      })
      .strict(),
  ]),
);
export type AgentToolRef = z.output<typeof AgentToolRef>;

export { DEFAULT_AGENT_TOOLS } from "../tools/builtin-names.js";

/** Roster names of inline templates and allowlisted org agents (the template name rule). */
export const SUBAGENT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * A sub-agent template written in the agent definition (phase C, spec §5.2): the fields of a
 * plugin agent template (`AgentTemplate`, spec §16.1), with `skills` as skill ids (org skills the
 * agent selects, or the agent's own) instead of names. Names and selections are checked on save
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

/** Agent 定义：每次变化写一个新版本（`capybara.agent_versions`）。 */
export const AgentDefinitionSchema = z.object({
  name: z.string().min(1).max(80),
  avatarUrl: z.url().nullable().default(null),
  instructions: z.string().max(100_000).default(""),
  model: ModelRef,
  fallback: ModelRef.nullable().default(null),
  /** 主模型的参数（按主模型的声明校验）。 */
  modelParams: ModelParams.default({}),
  /** 兜底模型自己的参数（按兜底模型的声明校验）；兜底尝试只用这一份。 */
  fallbackParams: ModelParams.default({}),
  /** 引用的工具（M2 保存的 `tools: []` 仍然合法）；保存时校验引用存在，运行时由注册表解析。 */
  tools: z.array(AgentToolRef).default([]),
  /**
   * 按工具 key 收紧策略（只能收紧：`ask` / `deny`，不接受 `allow`）；键必须是该 agent 引用的工具的 key。
   * 较早保存的定义没有该字段，按空处理。
   */
  toolPolicies: z.record(z.string(), z.enum(["ask", "deny"])).default({}),
  /**
   * 技能（M5 T13）：`orgSkills` 是引用的组织技能 id（保存时校验属于本组织且未删除，不可重复）。
   * agent 自己的技能（`scope=agent`）自动对它生效，不进定义。可省略（较早保存的定义也没有），按空处理；
   * 不给默认值：没用技能的定义保存前后不变，不会因此多出一个版本。
   * `writePolicy`（M6 T27，D10）：私有 agent 的 `SkillWrite` 是否固定确认，缺省按 `allow`（不写进定义）；
   * 共享 agent 不论取值都走 R3 + R4。
   */
  skills: z
    .object({
      orgSkills: z.array(z.string().min(1).max(100)).max(100).default([]),
      writePolicy: z.enum(["allow", "ask"]).optional(),
      /**
       * Pinned skills (phase B, spec §9.1): ids of selected org skills or of the agent's own
       * skills, whose bodies apply throughout every conversation, in this order. At most
       * `PINNED_SKILLS_LIMITS.count` (checked with the other rules by `assertPinnedSkills`, as
       * `agent.pinned_invalid`; the schema only bounds the input). No default: definitions
       * without it are unchanged.
       */
      pinned: z.array(z.string().min(1).max(100)).max(100).optional(),
    })
    .strict()
    .optional(),
  /** Sub-agents (phase C); offered only when the builtin `Agent` tool is in `tools`. */
  subagents: SubagentsSchema.optional(),
});
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The current key of a stored key: mapped when it is an rc key `scope` can read, else as is. */
const currentKey = (key: string, scope: LegacyScope | undefined): string =>
  legacyToolKey(key, scope) ?? key;

/** A list of tool keys (a template's `tools` / `disallowedTools`) in current keys, deduplicated. */
function keyList(v: unknown, scope: LegacyScope | undefined): unknown {
  if (!Array.isArray(v)) return v;
  let changed = false;
  const out: unknown[] = [];
  for (const x of v) {
    const next = typeof x === "string" ? currentKey(x, scope) : x;
    if (next !== x) changed = true;
    if (typeof next === "string" && out.includes(next)) {
      changed = true;
      continue;
    }
    out.push(next);
  }
  return changed ? out : v;
}

/** `toolPolicies` in current keys; two keys that become one keep the stricter policy. */
function policyKeys(v: unknown, scope: LegacyScope | undefined): unknown {
  if (!isRecord(v)) return v;
  const keys = Object.keys(v);
  if (!keys.some((k) => currentKey(k, scope) !== k)) return v;
  const rank = (p: unknown) => (p === "deny" ? 2 : p === "ask" ? 1 : 0);
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(v)) {
    const next = currentKey(k, scope);
    if (!Object.hasOwn(out, next) || rank(p) > rank(out[next])) out[next] = p;
  }
  return out;
}

/** An agent definition's `tools`: builtin refs by their current names (connector and plugin refs name tools, not keys). */
function toolRefs(v: unknown, scope: LegacyScope | undefined): unknown {
  if (!Array.isArray(v)) return v;
  // template-shaped (`tools: string[]`)
  if (v.some((x) => typeof x === "string")) return keyList(v, scope);
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
      ? { ...r, name: currentKey(r.name, undefined) }
      : r,
  );
}

/**
 * Release-candidate tool keys in a stored definition, read as current keys (tool naming spec
 * §8.3), the way {@link normalizeToolRef} reads the app -> connector rename: builtin refs in
 * `tools`, the keys of `toolPolicies`, and the `tools` / `disallowedTools` / `toolPolicies` of a
 * template, the agent's inline sub-agent templates included. Works on an agent definition and on
 * an agent template alike. Old builtin names map without `scope`; an rc `<x>__<tool>` key maps
 * only with one (the org's connector slugs, the deployment's extension names), and stays as it is
 * when it is ambiguous or unknown (it then matches no tool and is inert). Keys in the current
 * format are never touched. Returns the same object when nothing changes. Saving never goes
 * through this: a new definition with an old key is refused (`AgentsService`).
 */
export function normalizeToolKeys(definition: unknown, scope?: LegacyScope): unknown {
  if (!isRecord(definition)) return definition;
  const next: Record<string, unknown> = { ...definition };
  let changed = false;
  const put = (field: string, value: unknown) => {
    if (value === definition[field]) return;
    next[field] = value;
    changed = true;
  };
  if ("tools" in definition) put("tools", toolRefs(definition.tools, scope));
  if ("disallowedTools" in definition) {
    put("disallowedTools", keyList(definition.disallowedTools, scope));
  }
  if ("toolPolicies" in definition) put("toolPolicies", policyKeys(definition.toolPolicies, scope));
  const sub = definition.subagents;
  if (isRecord(sub) && Array.isArray(sub.inline)) {
    const inline = sub.inline.map((t) => normalizeToolKeys(t, scope));
    if (inline.some((t, i) => t !== (sub.inline as unknown[])[i]))
      put("subagents", { ...sub, inline });
  }
  return changed ? next : definition;
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
 * 库里读出的定义（`agent_versions.definition`，不经 zod 解析）：把改名前的 `{ kind: "app" }` 工具引用规范化为
 * connector 形（C27），and rc tool keys to current keys ({@link normalizeToolKeys}: builtins
 * always, `<x>__<tool>` keys with `scope`). Other fields are kept; without old forms the same
 * object is returned.
 */
export function normalizeStoredDefinition(def: unknown, scope?: LegacyScope): AgentDefinition {
  let d = def as AgentDefinition;
  const tools = (d as { tools?: unknown }).tools;
  if (Array.isArray(tools) && tools.some((t) => (t as { kind?: unknown })?.kind === "app")) {
    d = { ...d, tools: tools.map(normalizeToolRef) as AgentToolRef[] };
  }
  return normalizeToolKeys(d, scope) as AgentDefinition;
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
