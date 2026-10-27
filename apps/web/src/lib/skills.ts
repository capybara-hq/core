import { ApiClientError, apiFetch } from "./api";
import type { CreatedAttachment } from "./attachments";
import { uploadToStorage } from "./attachments";

/**
 * 内核技能 API 的类型（`packages/kernel/src/skills/*`；只声明界面用到的字段）。Web 层不 import 内核代码。
 * - 组织技能库：`/orgs/:orgId/skills`（成员可读，管理员上传 / 删除）；
 * - agent 自己写的技能：`/orgs/:orgId/agents/:agentId/skills`（能看到该 agent 的人可读，负责人可删）；
 * - 共享 agent 的技能变更：`/orgs/:orgId/skill-changes/:id`（负责人决定）。
 */

export interface SkillSummary {
  id: string;
  scope: "org" | "agent";
  agentId: string | null;
  name: string;
  description: string;
  currentVersion: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  /** The catalog item (plugin) the skill came from; null for the org's own (absent before phase B). */
  plugin?: string | null;
  sourceFormat?: "capybara" | "claude-code";
  /** The plugin suggests pinning it: selecting it ticks "pinned" by default. */
  suggestPinned?: boolean;
  /** SKILL.md size of the current version, in bytes. */
  entryBytes?: number;
  /** Token estimate of that SKILL.md (bytes / 4). */
  tokenEstimate?: number;
  /** Phase D: the current version is manual-only (not in the model's catalog). */
  manual?: boolean;
  /** Phase D: the current version runs as a sub-agent when a person invokes it. */
  fork?: boolean;
}

/**
 * Pinned skill limits (kernel `PINNED_SKILLS_LIMITS` in `skills/catalog.ts`; the kernel is the
 * authority, these only drive the agent page's hints).
 */
export const PINNED_SKILLS_LIMITS = { count: 3, totalBytes: 32768 } as const;

/** Why the kernel refused a pinned skill (`agent.pinned_invalid` details). */
export const PINNED_INVALID_REASONS = [
  "not_selected",
  "not_found",
  "duplicate",
  "too_many",
  "too_large",
  "manual_only",
] as const;
export type PinnedInvalidReason = (typeof PINNED_INVALID_REASONS)[number];

/** The details of a 400 `agent.pinned_invalid` (empty for any other error). */
export function pinnedProblemsOf(
  e: unknown,
): { skill: string; reason: PinnedInvalidReason; totalBytes?: number }[] {
  if (!(e instanceof ApiClientError) || e.code !== "agent.pinned_invalid") return [];
  return e.rawDetails.flatMap((d) => {
    if (typeof d !== "object" || d === null) return [];
    const { skill, reason, totalBytes } = d as Record<string, unknown>;
    if (typeof skill !== "string") return [];
    if (!(PINNED_INVALID_REASONS as readonly unknown[]).includes(reason)) return [];
    return [
      {
        skill,
        reason: reason as PinnedInvalidReason,
        ...(typeof totalBytes === "number" && { totalBytes }),
      },
    ];
  });
}

export interface SkillFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillVersion {
  version: number;
  description: string;
  files: SkillFile[];
  createdBy: string;
  createdAt: string;
}

export interface SkillDetail extends SkillSummary {
  /** 各版本，新的在前。 */
  versions: SkillVersion[];
  /** 当前版本 SKILL.md 的正文（已去掉 frontmatter）；太大或读不到时为 null。 */
  body: string | null;
}

export interface UploadedSkill {
  skill: SkillSummary;
  version: number;
  created: boolean;
}

export type SkillChangeStatus = "pending" | "approved" | "rejected" | "cancelled";

export interface SkillChange {
  id: string;
  orgId: string;
  agent: { id: string; name: string };
  /** 已有技能的 id；新技能为 null。 */
  skillId: string | null;
  name: string;
  description: string;
  /** 批准后预期的版本号。 */
  version: number;
  files: { path: string; size: number }[];
  status: SkillChangeStatus;
  requestedBy: string;
  requestedByName: string;
  requestedInConversation: string;
  /** 网页中发起对话的路径（不含语言前缀）。 */
  conversationPath: string;
  decidedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
}

/** 详情里的文件：内容读不到（已删除、超出读取上限）时为 null。 */
export interface SkillChangeFile {
  path: string;
  size: number;
  content: string | null;
}

export interface SkillChangeDetail extends Omit<SkillChange, "files"> {
  files: SkillChangeFile[];
  /** 改动已有技能时该技能当前生效的版本；新技能为 null。 */
  current: { version: number; files: SkillChangeFile[] } | null;
}

/** 技能包上限（内核 `SKILL_LIMITS` 与 `SKILL_PACKAGE_UPLOAD_MAX_BYTES`；以内核的校验为准，这里只是提前拦下）。 */
export const SKILL_ZIP_MAX_BYTES = 50 * 1024 * 1024;

/** 前端预检：不是 zip 或超过 50MB 时返回界面文案 key（`skills.upload.*`），通过时返回 null。 */
export function precheckSkillZip(file: {
  name: string;
  size: number;
}): "notZip" | "tooLarge" | null {
  if (!file.name.toLowerCase().endsWith(".zip")) return "notZip";
  if (file.size > SKILL_ZIP_MAX_BYTES) return "tooLarge";
  return null;
}

const org = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}`;
const enc = encodeURIComponent;

export const listSkills = (orgId: string) =>
  apiFetch<{ skills: SkillSummary[] }>(`${org(orgId)}/skills`);

export const getSkill = (orgId: string, id: string) =>
  apiFetch<SkillDetail>(`${org(orgId)}/skills/${enc(id)}`);

export const deleteSkill = (orgId: string, id: string) =>
  apiFetch<void>(`${org(orgId)}/skills/${enc(id)}`, { method: "DELETE" });

/**
 * 上传技能包：`POST /skills/uploads` 登记 → 浏览器直传预签名表单 → `POST /skills {uploadId}`
 * （内核代为 finalize，再解包校验，创建技能或给同名技能加一个版本）。
 */
export async function uploadSkillZip(
  orgId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<UploadedSkill> {
  const created = await apiFetch<CreatedAttachment>(`${org(orgId)}/skills/uploads`, {
    method: "POST",
    body: JSON.stringify({ name: file.name, size: file.size }),
    ...(opts.signal && { signal: opts.signal }),
  });
  opts.signal?.throwIfAborted();
  await uploadToStorage(created.upload, file, opts);
  opts.signal?.throwIfAborted();
  return apiFetch<UploadedSkill>(`${org(orgId)}/skills`, {
    method: "POST",
    body: JSON.stringify({ uploadId: created.id }),
    ...(opts.signal && { signal: opts.signal }),
  });
}

export const listAgentSkills = (orgId: string, agentId: string) =>
  apiFetch<{ skills: SkillSummary[] }>(`${org(orgId)}/agents/${enc(agentId)}/skills`);

export const deleteAgentSkill = (orgId: string, agentId: string, skillId: string) =>
  apiFetch<void>(`${org(orgId)}/agents/${enc(agentId)}/skills/${enc(skillId)}`, {
    method: "DELETE",
  });

export const getSkillChange = (orgId: string, id: string) =>
  apiFetch<{ skillChange: SkillChangeDetail }>(`${org(orgId)}/skill-changes/${enc(id)}`);

export const decideSkillChange = (
  orgId: string,
  id: string,
  body: { decision: "approve" | "reject"; note?: string },
) =>
  apiFetch<{ skillChange: SkillChange }>(`${org(orgId)}/skill-changes/${enc(id)}/decide`, {
    method: "POST",
    body: JSON.stringify(body),
  });

/**
 * A skill a person can invoke from the composer's `/` menu (kernel `InvocableSkill`, phase D
 * spec §4.5): the agent's effective skills that are not `user-invocable: false`, sorted by name.
 */
export interface InvocableSkill {
  id: string;
  name: string;
  /** The plugin it came from (also invocable as `<plugin>:<name>`). */
  plugin?: string;
  description: string;
  version: number;
  argumentHint?: string;
  arguments?: string[];
  /** Manual-only: not in the model's catalog. */
  manual: boolean;
  /** Runs as a sub-agent when invoked. */
  fork: boolean;
}

/**
 * `GET …/agents/:agentId/invocable-skills`; with `conversationId` (the caller's conversation with
 * the agent) its trial drafts apply.
 */
export const listInvocableSkills = (orgId: string, agentId: string, conversationId?: string) =>
  apiFetch<{ skills: InvocableSkill[] }>(
    `${org(orgId)}/agents/${enc(agentId)}/invocable-skills${
      conversationId !== undefined ? `?conversationId=${enc(conversationId)}` : ""
    }`,
  );

/** A leading `/<name>` or `/<plugin>:<name>`, then whitespace or the end (kernel `invoke.ts`). */
const SLASH_COMMAND_RE = /^\/([a-z0-9-]+(?::[a-z0-9-]+)?)(?:\s|$)/;

/** `/name args` at the very start of a message, or null (`/etc/hosts`, ` /x`, `/Upper`). */
export const parseSlashCommand = (text: string): { name: string; args: string } | null => {
  const m = SLASH_COMMAND_RE.exec(text);
  if (!m) return null;
  return { name: m[1] as string, args: text.slice(m[0].length).trim() };
};

/** The listed skill `name` names: its name, or `<plugin>:<name>` for a plugin's skill. */
export function findInvocable(
  skills: readonly InvocableSkill[],
  name: string,
): InvocableSkill | undefined {
  const i = name.indexOf(":");
  if (i < 0) return skills.find((s) => s.name === name);
  const plugin = name.slice(0, i);
  const bare = name.slice(i + 1);
  return skills.find((s) => s.plugin === plugin && s.name === bare);
}
