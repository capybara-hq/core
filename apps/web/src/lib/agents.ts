import { apiFetch } from "./api";
import type { ModelRef } from "./conversations";

/** 内核 agent API 的类型（只声明界面用到的字段）。 */

export type AgentVisibility = "private" | "org" | "members";

export interface AgentDefinitionInput {
  name: string;
  instructions: string;
  model: ModelRef;
  fallback?: ModelRef | null;
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

export interface ModelInfo {
  id: string;
  displayName: string;
}

export interface ProviderModels {
  provider: string;
  models: ModelInfo[];
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
