import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/** 内核 agent API 的类型（只声明界面用到的字段）。 */

export type AgentVisibility = "private" | "org" | "members";

export interface AgentDefinitionInput {
  name: string;
  instructions: string;
  model: ModelRef;
  fallback?: ModelRef | null;
  /** 主模型的参数：只含用户改动过的键，其余由内核按声明补默认值。 */
  modelParams?: Record<string, ParamValue>;
  /** 兜底模型的参数；没有兜底模型时必须为空。 */
  fallbackParams?: Record<string, ParamValue>;
}

export interface Agent {
  id: string;
  orgId: string;
  visibility: AgentVisibility;
  currentVersion: number;
  definition: AgentDefinitionInput & { fallback: ModelRef | null };
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

export const listModels = (orgId: string) =>
  apiFetch<{ providers: ProviderModels[] }>(`${base(orgId)}/models`);
