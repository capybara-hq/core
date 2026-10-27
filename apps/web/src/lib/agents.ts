import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/** 内核 agent API 的类型（只声明界面用到的字段）。 */

export type AgentVisibility = "private" | "org" | "members";

/**
 * agent 引用的工具（与内核 `AgentToolRef` 对应）：内置工具按名字；插件工具按插件名 + 工具名；
 * 连接器工具按连接器 id，`tools: "all"` 为该连接器当前所有启用的工具。
 */
export type AgentToolRef =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; plugin: string; name: string }
  | { kind: "connector"; connectorId: string; tools: "all" | string[] };

/** 收紧后的策略（只能收紧：`ask` / `deny`）。 */
export type TightenedPolicy = "ask" | "deny";

/**
 * 网页可选的内置工具（内核没有列出内置工具的接口；`tool_search` 与 `skill_load` 由内核自动加入）。
 * 新建时默认勾选 {@link DEFAULT_BUILTIN_TOOLS}（与内核的默认工具一致）。
 */
export const BUILTIN_TOOLS = ["ask_user", "read_tool_output", "skill_write"] as const;
export const DEFAULT_BUILTIN_TOOLS: readonly string[] = ["ask_user", "read_tool_output"];

export interface AgentDefinitionInput {
  name: string;
  instructions: string;
  model: ModelRef;
  fallback?: ModelRef | null;
  /** 主模型的参数：只含用户改动过的键，其余由内核按声明补默认值。 */
  modelParams?: Record<string, ParamValue>;
  /** 兜底模型的参数；没有兜底模型时必须为空。 */
  fallbackParams?: Record<string, ParamValue>;
  /** 引用的工具；创建时不给则由内核填默认（ask_user、read_tool_output）。 */
  tools?: AgentToolRef[];
  /** 按工具 key 收紧策略。 */
  toolPolicies?: Record<string, TightenedPolicy>;
  /** 选用的组织技能（id）；不用技能时省略。 */
  /**
   * 技能设置；表单只管 `orgSkills` 与 `writePolicy`（私有 agent 的 skill_write 确认开关，缺省不写），
   * 其余键（新版本内核加的）保存时原样带回。
   */
  skills?: {
    orgSkills: string[];
    writePolicy?: "allow" | "ask";
    /** Pinned skill ids (spec §9.1; no default: absent unless the owner pinned something). */
    pinned?: string[];
    [key: string]: unknown;
  };
  /** Sub-agents (phase C); absent unless set (no new version for agents without it). */
  subagents?: AgentSubagents;
}

/** A sub-agent model tier (`subagent_<tier>` purposes; `inherit` = the parent's model). */
export type AgentTier = "inherit" | "fast" | "standard" | "capable";
export const AGENT_TIERS = [
  "inherit",
  "fast",
  "standard",
  "capable",
] as const satisfies AgentTier[];

/** A sub-agent template written in the agent definition (kernel `InlineAgentTemplate`). */
export interface InlineAgentTemplate {
  name: string;
  description: string;
  instructions: string;
  tools?: string[];
  disallowedTools?: string[];
  toolPolicies?: Record<string, TightenedPolicy>;
  model?: AgentTier;
  effort?: string;
  maxSteps?: number;
  skills?: string[];
}

/** Sub-agents this agent may dispatch with the builtin `agent` tool (kernel `SubagentsSchema`). */
export interface AgentSubagents {
  general?: boolean;
  templates?: string[];
  inline?: InlineAgentTemplate[];
  agents?: { agentId: string; as: string; description: string }[];
  dispatchable?: boolean;
}

/** An org agent template installed from a plugin (`GET .../agent-templates`). */
export interface AgentTemplateView {
  id: string;
  name: string;
  plugin: string;
  /** The roster type `<plugin>:<name>`. */
  type: string;
  description: string;
  model: AgentTier;
  version: number;
}

export const listAgentTemplates = (orgId: string) =>
  apiFetch<{ templates: AgentTemplateView[] }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/agent-templates`,
  );

/** Why `subagents` was refused (`agent.subagents_invalid` details). */
export const SUBAGENTS_INVALID_REASONS = [
  "not_found",
  "invalid_name",
  "duplicate",
  "tool_not_selected",
  "skill_not_selected",
  "agent_not_available",
  "self",
  "too_many",
] as const;
export type SubagentsInvalidReason = (typeof SUBAGENTS_INVALID_REASONS)[number];

export interface Agent {
  id: string;
  orgId: string;
  ownerAccountId: string;
  visibility: AgentVisibility;
  /** The member list when visibility is `members` (else null; older kernels leave it out). */
  memberIds?: string[] | null;
  currentVersion: number;
  /** 定义里可能还有界面不认识的字段：修改时原样带回。 */
  definition: AgentDefinitionInput & { fallback: ModelRef | null } & Record<string, unknown>;
  updatedAt: string;
}

/** 内核返回的保存警告码（界面以 `agents.warnings.<code>` 翻译）。 */
export type AgentWarning = "fallback_same_provider" | (string & {});

/**
 * 模型参数声明（对应 plugin-sdk `model-params.ts` 的 `ModelParameter`；Web 层不 import SDK）。
 * `schema` 是受限的 JSON Schema 子集；界面遇到子集之外的类型时按文本框处理。
 */
export type StandardKnob = "effort" | "thinking" | "temperature" | "maxOutputTokens";

export type ParamSchema =
  | { type: "string"; enum: string[] }
  | { type: "string"; maxLength?: number }
  | { type: "boolean" }
  | { type: "number" | "integer"; minimum?: number; maximum?: number };

export type ParamValue = string | number | boolean;

export interface ModelParameter {
  key: string;
  standard?: StandardKnob;
  schema: ParamSchema;
  default?: ParamValue;
  label: { zh: string; en: string };
  description?: { zh: string; en: string };
}

export interface ModelInfo {
  id: string;
  displayName: string;
  /** 上下文窗口（token）；旧内核可能没有。 */
  contextWindow?: number;
  capabilities: { reasoning: boolean };
  parameters: ModelParameter[];
}

export interface ProviderModels {
  provider: string;
  models: ModelInfo[];
}

/** 值是否满足声明的 schema（与内核 `validateParams` 同一套规则；子集之外的类型一律放行，交内核判断）。 */
function fits(schema: ParamSchema, v: ParamValue): boolean {
  switch (schema.type) {
    case "boolean":
      return typeof v === "boolean";
    case "string":
      if (typeof v !== "string") return false;
      if ("enum" in schema) return schema.enum.includes(v);
      return schema.maxLength === undefined || v.length <= schema.maxLength;
    case "number":
    case "integer":
      return (
        typeof v === "number" &&
        Number.isFinite(v) &&
        (schema.type === "number" || Number.isInteger(v)) &&
        (schema.minimum === undefined || v >= schema.minimum) &&
        (schema.maximum === undefined || v <= schema.maximum)
      );
    default:
      return true;
  }
}

/** 换模型时保留参数：只留新模型声明了、且取值仍满足其 schema 的键。 */
export function keepDeclared(
  decl: ModelParameter[],
  params: Record<string, ParamValue>,
): Record<string, ParamValue> {
  const byKey = new Map(decl.map((d) => [d.key, d]));
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(params)) {
    const d = byKey.get(k);
    if (d && fits(d.schema, v)) out[k] = v;
  }
  return out;
}

/** 在模型列表中查找模型。 */
export function findModel(providers: ProviderModels[], ref: ModelRef): ModelInfo | undefined {
  return providers.find((p) => p.provider === ref.provider)?.models.find((m) => m.id === ref.model);
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;

export const listAgents = (orgId: string) => apiFetch<{ agents: Agent[] }>(`${base(orgId)}/agents`);

export const createAgent = (
  orgId: string,
  input: { definition: AgentDefinitionInput; visibility: AgentVisibility },
) =>
  apiFetch<{ agent: Agent; warnings: AgentWarning[] }>(`${base(orgId)}/agents`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const getAgent = (orgId: string, agentId: string) =>
  apiFetch<{ agent: Agent }>(`${base(orgId)}/agents/${encodeURIComponent(agentId)}`);

/**
 * 修改 agent：定义有变化时内核写新版本；`visibility` 只在改动时给。`expectedVersion` 是编辑页打开时的
 * `currentVersion`：别人已保存过新版本时内核返回 409 `agent.version_conflict`，不覆盖别人的改动。
 */
export const updateAgent = (
  orgId: string,
  agentId: string,
  input: {
    definition?: AgentDefinitionInput;
    visibility?: AgentVisibility;
    expectedVersion?: number;
  },
) =>
  apiFetch<{ agent: Agent; warnings: AgentWarning[] }>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );

export const listModels = (orgId: string) =>
  apiFetch<{ providers: ProviderModels[] }>(`${base(orgId)}/models`);
