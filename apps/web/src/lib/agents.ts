// Types only: the server layout imports this module, and the design root pulls in client-only
// modules (createContext).
import type { AvatarValue, PresetId } from "@capybara-hq/design";
import { apiFetch } from "./api";
import { type CreatedAttachment, uploadToStorage } from "./attachments";
import type { LocalizedName } from "./catalog";
import type { ModelRef } from "./conversations";
import type { InstructionFile } from "./instruction-files";

/** 内核 agent API 的类型（只声明界面用到的字段）。 */

export type AgentVisibility = "private" | "org" | "members";

/**
 * A tool the agent turns off (kernel `DisabledToolRef`, tools default-on spec §2): an agent has
 * every builtin, every tool of the extensions on in the org and every tool of the org's connectors
 * except these. A builtin by name; an extension's or a connector's tools by name, or `"all"` to
 * turn it off as a unit (tools it gains later included).
 */
export type DisabledToolRef =
  | { kind: "builtin"; name: string }
  | { kind: "plugin"; plugin: string; tools: "all" | string[] }
  | { kind: "connector"; connectorId: string; tools: "all" | string[] };

/** 收紧后的策略（只能收紧：`ask` / `deny`）。 */
export type TightenedPolicy = "ask" | "deny";

/**
 * The builtins the Tools section switches (the kernel's `AGENT_BUILTIN_NAMES` without `Agent`,
 * which the Sub-agents section switches; `ToolSearch` and `Skill` are added by the kernel, and
 * `TaskOutput` / `TaskStop` come with `Bash`). All are on unless turned off. The web tools
 * (`WebSearch` / `WebFetch`) are listed only while their point has a provider, or when turned off
 * ({@link WEB_TOOL_POINTS}).
 */
export const BUILTIN_TOOLS = [
  "AskUserQuestion",
  "ReadToolOutput",
  "SkillWrite",
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "Deliver",
  "WebSearch",
  "WebFetch",
  "Platform",
  "CurrentTime",
] as const;

/**
 * The builtin web tools and the extension point that serves each (web tools spec §3.4): the form
 * offers one only while `GET …/extension-points/available` reports its point available, or when
 * the agent turned it off.
 */
export const WEB_TOOL_POINTS: Readonly<Record<string, string>> = {
  WebSearch: "web-search",
  WebFetch: "web-fetch",
};

export interface AgentDefinitionInput {
  name: string;
  /**
   * What the agent is for (the model sees it in its run context); saved as a new version. Absent
   * on older versions (the profile's copy is shown); a save without it keeps the current one,
   * `""` removes it.
   */
  description?: string;
  /** The model-visible prompt: the kernel derives it from `instructionFiles` when they are saved. */
  instructions: string;
  /**
   * The prompt files (the authoring form of `instructions`); absent on old versions, which read
   * as one `AGENTS.md`. A save sends these or `instructions`, never a differing pair.
   */
  instructionFiles?: InstructionFile[];
  model: ModelRef;
  fallback?: ModelRef | null;
  /** 主模型的参数：只含用户改动过的键，其余由内核按声明补默认值。 */
  modelParams?: Record<string, ParamValue>;
  /** 兜底模型的参数；没有兜底模型时必须为空。 */
  fallbackParams?: Record<string, ParamValue>;
  /** The tools turned off; absent or `[]` = every tool the org offers (tools default-on spec). */
  disabledTools?: DisabledToolRef[];
  /** 按工具 key 收紧策略。 */
  toolPolicies?: Record<string, TightenedPolicy>;
  /** 选用的组织技能（id）；不用技能时省略。 */
  /**
   * 技能设置；表单只管 `orgSkills` 与 `writePolicy`（私有 agent 的 SkillWrite 确认开关，缺省不写），
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
  /** The plugin it came from; null for a template without one (its type is the bare name). */
  plugin: string | null;
  /** The roster type `<plugin>:<name>`, or the bare `<name>` without a plugin. */
  type: string;
  description: string;
  model: AgentTier;
  version: number;
  /** `platform`: a platform template on in the org; `org`: the org's own (older kernels: absent). */
  origin?: "org" | "platform";
  /** A platform template: the ids of the org's copies linked to it (they select this template). */
  linkedIds?: string[];
  /** The catalog item (plugin) it came from, when any. */
  catalogItemId?: string | null;
}

export const listAgentTemplates = (orgId: string) =>
  apiFetch<{ templates: AgentTemplateView[] }>(
    `/api/v1/orgs/${encodeURIComponent(orgId)}/agent-templates`,
  );

/**
 * One template usable in the org (kernel `AgentTemplateDetail`, `GET …/agent-templates/:id`;
 * not usable there -> 404 `component.not_found`): `owned` is the org's own template, whose org
 * admins edit, delete and set 可共享 on it (rulings P4-12, P4-13); always false for a plugin's.
 */
export interface AgentTemplateDetail extends AgentTemplateView {
  /** The served definition (SDK `AgentTemplate`; the web reads only what it shows). */
  definition: Record<string, unknown>;
  owner: { kind: "platform" } | { kind: "org"; orgId: string; name: string };
  owned: boolean;
  /** 可共享 (only meaningful when `owned`). */
  shareable: boolean;
  /** Shared already: promoted to a platform row (ruling P3-3). */
  promoted: boolean;
  /**
   * In the org's usable set (agents can be created from it here); false when only its owner reads
   * it (switched off in its own org). Absent from older kernels: usable.
   */
  usable?: boolean;
}

const templatePath = (orgId: string, id: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgId)}/agent-templates/${encodeURIComponent(id)}`;

export const getAgentTemplate = (orgId: string, id: string) =>
  apiFetch<{ template: AgentTemplateDetail }>(templatePath(orgId, id));

/** Sets 可共享 on the org's own template (`agents.manage`). */
export const setAgentTemplateShareable = (orgId: string, id: string, shareable: boolean) =>
  apiFetch<{ id: string; shareable: boolean }>(`${templatePath(orgId, id)}/shareable`, {
    method: "PUT",
    body: JSON.stringify({ shareable }),
  });

/**
 * What deleting the org's own template does (nothing written; P3 owner rules): `transferred` when
 * it was shared and other orgs use it (`orgs`; it becomes the platform's), else `removed`; `agents`:
 * the org's agents whose sub-agent roster names it. Agents created from it are never touched.
 */
export interface AgentTemplateDeletePreview {
  outcome: "removed" | "transferred";
  orgs: { id: string; name: string }[];
  agents: { id: string; name: string }[];
}

export const previewAgentTemplateDelete = (orgId: string, id: string) =>
  apiFetch<AgentTemplateDeletePreview>(`${templatePath(orgId, id)}/delete-preview`);

export const deleteAgentTemplate = (orgId: string, id: string) =>
  apiFetch<{ outcome: AgentTemplateDeletePreview["outcome"] }>(templatePath(orgId, id), {
    method: "DELETE",
  });

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

/** The kernel's avatar of an agent (`null` only for agents created before profiles existed). */
export type AgentAvatar =
  | { kind: "preset"; id: PresetId }
  | { kind: "upload"; uploadId: string }
  | { kind: "external"; url: string }
  | null;

export interface QuickAction {
  title: string;
  body: string;
}

export interface AgentProfile {
  avatar: AgentAvatar;
  description: string;
  quickActions: QuickAction[];
  updatedAt: string;
}

/**
 * What a client may write: `external` avatars are migrated data only. The description is part of
 * the definition (saved with the agent PATCH).
 */
export interface ProfileInput {
  avatar?: { kind: "preset"; id: PresetId } | { kind: "upload"; uploadId: string } | null;
  quickActions?: QuickAction[];
}

export interface Agent {
  id: string;
  orgId: string;
  ownerAccountId: string;
  visibility: AgentVisibility;
  /** The member list when visibility is `members` (else null; older kernels leave it out). */
  memberIds?: string[] | null;
  currentVersion: number;
  /**
   * Avatar and quick actions: not part of the definition, never model-visible. `description` is
   * the display copy of the definition's description (older agents: their profile text).
   */
  profile: AgentProfile;
  /** The owner left the org and the agent went to an owner of the org until an admin reassigns it. */
  needsReassignment?: boolean;
  /** 定义里可能还有界面不认识的字段：修改时原样带回。 */
  definition: AgentDefinitionInput & { fallback: ModelRef | null } & {
    /** Connectors the template needed and the org lacked (ruling P4-6); model-invisible. */
    pendingConnectors?: PendingConnector[];
  } & Record<string, unknown>;
  /** The template it was created from (ruling P4-8); null (older kernels: absent) otherwise. */
  createdFrom?: AgentProvenance | null;
  updatedAt: string;
}

/**
 * Where an agent came from (kernel `AgentProvenance`, ruling P4-8): set once at create, never
 * changed. `available`: the template is still usable in the org (the page links it only then).
 */
export interface AgentProvenance {
  templateId: string;
  version: number;
  name: string;
  available?: boolean;
}

/**
 * A connector the template needed and the org lacked (kernel `PendingConnector`, ruling P4-6):
 * made from a platform connector template (`source.template`, its id), or any connector of a
 * protocol (`source.needs`); binding one (`POST …/pending-connectors/:key/bind`) resolves it.
 */
export interface PendingConnector {
  key: string;
  label: string;
  source:
    | { template: string }
    | { needs: { protocol: "mcp" | "openapi"; endpoint: string; tools: string[]; label: string } };
  /** The tools the agent takes once bound; absent = all. */
  tools?: string[];
  policies?: Record<string, TightenedPolicy>;
}

/** 内核返回的保存警告码（界面以 `agents.warnings.<code>` 翻译）。 */
export type AgentWarning = "fallback_same_provider" | (string & {});

/** The agent page section a save warning is about (the 模型 section owns the fallback). */
export const WARNING_SECTION: Record<string, "model"> = { fallback_same_provider: "model" };

/** The warnings of `codes` that belong to `section`: the others are shown where they belong. */
export const warningsOf = (section: "model", codes: readonly AgentWarning[]): AgentWarning[] =>
  codes.filter((c) => WARNING_SECTION[c] === section);

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

/** The kinds of model the kernel lists (`other` is a kind this kernel does not know). */
export type ModelKind =
  | "chat"
  | "embedding"
  | "rerank"
  | "image_generation"
  | "video_generation"
  | "speech_to_text"
  | "text_to_speech"
  | "other";

export interface ModelInfo {
  id: string;
  displayName: string;
  /** Normalised by the kernel; an older kernel leaves it out (a chat model). */
  kind?: ModelKind;
  /** Who made the model (display only). */
  publisher?: string;
  description?: LocalizedName | string;
  /** ISO date after which the model is retired. */
  retiresAt?: string;
  /** On the platform's list (admin view) or the org's own (catalog view); absent elsewhere. */
  disabled?: boolean;
  /** Set when `kind` is `embedding` (plugin-sdk `ModelEmbeddingInfo`). */
  embedding?: {
    dimensions: number[];
    defaultDimensions: number;
    maxInputTokens: number;
    maxBatch: number;
  };
  /** 上下文窗口（token）；旧内核可能没有。 */
  contextWindow?: number;
  capabilities: { reasoning: boolean };
  parameters: ModelParameter[];
}

export interface ProviderModels {
  provider: string;
  /** The provider extension's display name; null when it has none (show the id). */
  displayName?: LocalizedName | null;
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

/**
 * Whether the org can run (`GET /orgs/:id/readiness`): a loaded model-provider extension (never a
 * vendor call) and the number of agents the caller can see.
 */
export interface OrgReadiness {
  modelProvider: "ready" | "none";
  agents: number;
}

/** Whether a conversation can start: a loaded model provider and an agent the viewer can see. */
export function setupReady(r: OrgReadiness): boolean {
  return r.modelProvider === "ready" && r.agents > 0;
}

export const getReadiness = (orgId: string) => apiFetch<OrgReadiness>(`${base(orgId)}/readiness`);

export const listAgents = (orgId: string) => apiFetch<{ agents: Agent[] }>(`${base(orgId)}/agents`);

/**
 * What the create form sends: no `instructions` and no `instructionFiles` (the kernel then starts
 * the prompt from its default `AGENTS.md` template), nothing turned off (every tool the org offers).
 */
export type AgentCreateDefinition = Pick<AgentDefinitionInput, "name" | "model">;

export const createAgent = (
  orgId: string,
  input: {
    definition: AgentCreateDefinition;
    visibility: AgentVisibility;
    profile?: Pick<ProfileInput, "avatar">;
  },
) =>
  apiFetch<{ agent: Agent; warnings: AgentWarning[] }>(`${base(orgId)}/agents`, {
    method: "POST",
    body: JSON.stringify(input),
  });

export const getAgent = (orgId: string, agentId: string) =>
  apiFetch<{ agent: Agent }>(`${base(orgId)}/agents/${encodeURIComponent(agentId)}`);

/** One saved version of an agent (newest first in the list). */
export interface AgentVersionSummary {
  version: number;
  createdBy: string;
  createdAt: string;
}

export const listAgentVersions = (orgId: string, agentId: string) =>
  apiFetch<{ versions: AgentVersionSummary[] }>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}/versions`,
  );

/**
 * A definition as a save sends it: with `instructions` (the prompt files left out: the kernel keeps
 * them while it equals their join), or with `instructionFiles` and no `instructions` (the kernel
 * derives it; a differing one is 400 `agent.instructions_mismatch`).
 */
export type AgentDefinitionSave =
  | (Omit<AgentDefinitionInput, "instructionFiles"> & { instructionFiles?: never })
  | (Omit<AgentDefinitionInput, "instructions" | "instructionFiles"> & {
      instructions?: never;
      instructionFiles: InstructionFile[];
    });

/**
 * 修改 agent：定义有变化时内核写新版本；`visibility` 只在改动时给。`expectedVersion` 是编辑页打开时的
 * `currentVersion`：别人已保存过新版本时内核返回 409 `agent.version_conflict`，不覆盖别人的改动。
 */
export const updateAgent = (
  orgId: string,
  agentId: string,
  input: {
    definition?: AgentDefinitionSave;
    visibility?: AgentVisibility;
    memberIds?: string[];
    expectedVersion?: number;
  },
) =>
  apiFetch<{ agent: Agent; warnings: AgentWarning[] }>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );

/** Change the agent's owner (`agents.manage`, org admins); clears `needsReassignment`. */
export const reassignAgentOwner = (orgId: string, agentId: string, accountId: string) =>
  apiFetch<{ agent: Agent }>(`${base(orgId)}/agents/${encodeURIComponent(agentId)}/owner`, {
    method: "POST",
    body: JSON.stringify({ accountId }),
  });

/** The org's enabled models, of one `kind` (the pickers ask for `chat`) or of every kind. */
export const listModels = (orgId: string, kind?: ModelKind) =>
  apiFetch<{ providers: ProviderModels[] }>(
    `${base(orgId)}/models${kind === undefined ? "" : `?kind=${kind}`}`,
  );

/**
 * The avatar the design `Avatar` renders. Uploads and migrated external avatars go through the
 * kernel's redirect route; `v` busts the browser cache when the profile changes.
 */
export function avatarValue(agent: Pick<Agent, "id" | "profile">, orgId: string): AvatarValue {
  const a = agent.profile.avatar;
  if (a === null) return null;
  if (a.kind === "preset") return { kind: "preset", id: a.id };
  return {
    kind: "image",
    src: `${base(orgId)}/agents/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.profile.updatedAt)}`,
  };
}

/**
 * Save the profile (`PATCH …/profile`). `expectedUpdatedAt` is the `profile.updatedAt` the caller
 * read: another save in between answers 409 `agent.profile_conflict`, never a silent overwrite.
 */
export const updateAgentProfile = (
  orgId: string,
  agentId: string,
  input: ProfileInput & { expectedUpdatedAt: string },
) =>
  apiFetch<{ profile: AgentProfile }>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}/profile`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );

/** Register an avatar upload: the kernel checks type and size and returns a presigned upload. */
export const createAvatarUpload = (
  orgId: string,
  agentId: string,
  input: { name: string; contentType: string; size: number },
) =>
  apiFetch<CreatedAttachment>(
    `${base(orgId)}/agents/${encodeURIComponent(agentId)}/avatar/uploads`,
    { method: "POST", body: JSON.stringify(input) },
  );

/**
 * Upload a cropped avatar: register, then send to object storage with the presigned upload. The
 * returned id goes into the profile as `{ kind: "upload", uploadId }`.
 */
export async function uploadAvatar(
  orgId: string,
  agentId: string,
  file: Blob,
): Promise<{ uploadId: string }> {
  const name = file instanceof File ? file.name : "avatar";
  const created = await createAvatarUpload(orgId, agentId, {
    name,
    contentType: file.type,
    size: file.size,
  });
  await uploadToStorage(
    created.upload,
    file instanceof File ? file : new File([file], name, { type: file.type }),
  );
  return { uploadId: created.id };
}

/** The `/agents` page's tabs (ruling P4-14): 智能体, or 模板 (`?tab=templates`). */
export type AgentsTab = "agents" | "templates";

export const parseAgentsTab = (raw: string | undefined | null): AgentsTab =>
  raw === "templates" ? "templates" : "agents";
