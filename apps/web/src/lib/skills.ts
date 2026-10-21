import { apiFetch } from "./api";
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
