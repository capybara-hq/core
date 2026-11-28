import { apiFetch } from "./api";
import type { Owner } from "./components";
import { isHtmlFile, isSvgFile, readTextPreview, TEXT_PREVIEW_BYTES } from "./files";
import type { CreatedAttachment } from "./uploads";
import { uploadToStorage } from "./uploads";

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
  /** null once the account is gone (or for a platform copy). */
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  /** The catalog item (plugin) the skill came from; null for the org's own (absent before phase B). */
  plugin?: string | null;
  sourceFormat?: "capybara" | "claude-code";
  /** Phase D: the current version is manual-only (not in the model's catalog). */
  manual?: boolean;
  /** Phase D: the current version runs as a sub-agent when a person invokes it. */
  fork?: boolean;
  /**
   * Plugin scope phase 2: `platform` for a platform skill on in the org (not deletable or versioned
   * by the org), `org` for the org's own.
   */
  origin: "org" | "platform";
  /** A platform skill's owner: the platform, or the org whose upload it came from (P3-1). */
  owner?: Owner;
  /**
   * A platform skill in the library list: the ids of the org's copies linked to it. They resolve
   * to this skill, so an off entry naming one of them turns this skill off.
   */
  linkedIds?: string[];
  /**
   * In the library list: a builtin plugin's platform skill, in every agent's catalog; no agent can
   * turn it off.
   */
  builtin?: boolean;
  /**
   * Plugin scope phase 3: the org's own org-scope skill is 可共享 (the super admin may show or offer
   * it to other orgs); false for platform skills and agents' skills.
   */
  shareable: boolean;
  /** The agent's own skill list only: a share request of the skill waits for an org admin. */
  sharePending?: boolean;
  /**
   * The agent's own skill list only: an org skill this agent shared (same id as before sharing);
   * it is always on for the agent.
   */
  shared?: boolean;
}

/** The skill's id and the ids of the org copies linked to it (they all name the same skill). */
export const skillAliases = (s: Pick<SkillSummary, "id" | "linkedIds">): string[] => [
  s.id,
  ...(s.linkedIds ?? []),
];

export interface SkillFile {
  path: string;
  size: number;
  sha256: string;
}

export interface SkillVersion {
  version: number;
  description: string;
  files: SkillFile[];
  /** null once the account is gone. */
  createdBy: string | null;
  createdAt: string;
}

export interface SkillDetail extends SkillSummary {
  /** How many of the org's agents turn the skill off. */
  agentsOff: number;
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

/** `share`: an agent's skill offered to the org; `version`: a new version of a shared skill. */
export type SkillChangeKind = "share" | "version";

export interface SkillChange {
  id: string;
  orgId: string;
  kind: SkillChangeKind;
  agent: { id: string; name: string };
  /** A share: the agent skill; a version: the shared org skill. */
  skillId: string | null;
  name: string;
  description: string;
  /** 批准后预期的版本号。 */
  version: number;
  files: { path: string; size: number }[];
  status: SkillChangeStatus;
  requestedBy: string;
  requestedByName: string;
  requestedByAvatarUrl: string | null;
  /** The proposing conversation; null for a share request and a proposal made on the web. */
  requestedInConversation: string | null;
  /** The proposing conversation's web path (no locale prefix), or null. */
  conversationPath: string | null;
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
 * Sets 可共享 on the org's own skill (`PUT /skills/:id/shareable`; others -> 409
 * `catalog.not_owned`).
 */
export const setSkillShareable = (orgId: string, id: string, shareable: boolean) =>
  apiFetch<{ id: string; shareable: boolean }>(`${org(orgId)}/skills/${enc(id)}/shareable`, {
    method: "PUT",
    body: JSON.stringify({ shareable }),
  });

/**
 * What deleting the org's skill does (`GET /skills/:id/delete-preview`, ruling P3-19; nothing
 * written): `transferred` when it was shared and other orgs use it (`orgs`; it becomes the
 * platform's), else `removed`; `agents`: the org's agents that lose it.
 */
export interface SkillDeletePreview {
  outcome: "removed" | "transferred";
  orgs: { id: string; name: string }[];
  agents: { id: string; name: string }[];
}

export const previewSkillDelete = (orgId: string, id: string) =>
  apiFetch<SkillDeletePreview>(`${org(orgId)}/skills/${enc(id)}/delete-preview`);

/** One file of a skill version, as `GET /skills/:id/files` lists it. */
export interface SkillFileEntry {
  path: string;
  size: number;
  /** By the file's extension (unknown: `application/octet-stream`). */
  contentType: string;
  /** The built-in kind the content route serves (the conversation files list's rule). */
  previewable: "image" | "text" | null;
}

/** `GET /skills/:id/files`: the files of one version (the current one unless `version` is given). */
export interface SkillFileList {
  version: number;
  files: SkillFileEntry[];
}

export const listSkillFiles = (orgId: string, id: string, version: number | null) =>
  apiFetch<SkillFileList>(
    `${org(orgId)}/skills/${enc(id)}/files${version === null ? "" : `?version=${version}`}`,
  );

/**
 * The URL of one file's bytes (`GET /skills/:id/files/content`): `inline` for a raster image shown
 * in place (the kernel never serves HTML or SVG inline), `limit` for the first bytes only.
 */
export function skillFileContentUrl(
  orgId: string,
  id: string,
  version: number,
  path: string,
  opts: { inline?: boolean; limit?: number } = {},
): string {
  const q = new URLSearchParams({ version: String(version), path });
  if (opts.limit !== undefined) q.set("limit", String(opts.limit));
  if (opts.inline === true) q.set("inline", "1");
  return `${org(orgId)}/skills/${enc(id)}/files/content?${q}`;
}

/** The file a skill's Files tab shows when none is chosen. */
export const SKILL_MAIN_FILE = "SKILL.md";

/** A path's last segment (the file's name). */
export const skillFileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * A skill file shown only as its source text: HTML and SVG are never rendered from a skill (no
 * document frame, no extension previewer, never served inline).
 */
export const skillFileSourceOnly = (f: { path: string; contentType: string }): boolean => {
  const named = { name: skillFileName(f.path), contentType: f.contentType };
  return isHtmlFile(named) || isSvgFile(named);
};

/** The skill page's tabs (`?tab=`): the SKILL.md body, the Files browser, the versions. */
export const SKILL_TABS = ["content", "files", "versions"] as const;
export type SkillTab = (typeof SKILL_TABS)[number];

/** The skill page's address: the tab, the selected file (`?file=`) and the version (`?version=`). */
export interface SkillPageAddress {
  tab: SkillTab;
  /** A path of the version's manifest; null: none chosen (SKILL.md is shown). */
  file: string | null;
  /** null: the current version. */
  version: number | null;
}

/** `?tab=` as a tab; anything else is the SKILL.md body. */
export const parseSkillTab = (raw: string | null | undefined): SkillTab =>
  (SKILL_TABS as readonly string[]).includes(raw ?? "") ? (raw as SkillTab) : "content";

/** `?version=` as a version number (a positive integer the kernel takes), else null. */
export function parseSkillVersion(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : null;
}

/**
 * Reads the skill page's address: a `?file=` or `?version=` without `?tab=` opens the Files tab, so
 * a link to a file needs no more than its path.
 */
export function parseSkillAddress(get: (name: string) => string | null | undefined) {
  const file = get("file") || null;
  const version = parseSkillVersion(get("version"));
  const raw = get("tab");
  const tab: SkillTab =
    raw !== null && raw !== undefined && raw !== ""
      ? parseSkillTab(raw)
      : file !== null || version !== null
        ? "files"
        : "content";
  return { tab, file, version } satisfies SkillPageAddress;
}

/** A skill file's text for the built-in previews (the first bytes; `truncated` past them). */
export const skillFileText = (
  orgId: string,
  id: string,
  version: number,
  path: string,
  signal?: AbortSignal,
) =>
  readTextPreview(
    skillFileContentUrl(orgId, id, version, path, { limit: TEXT_PREVIEW_BYTES }),
    signal,
  );

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

/** The kernel's answer to registering an agent skill package (`RegisterOutcome`). */
export type RegisteredAgentSkill =
  | { kind: "version"; skillId: string; name: string; version: number; created: boolean }
  | { kind: "proposed"; name: string };

/**
 * Uploads a skill package to the agent (owner only): `POST /agents/:id/skills/uploads` registers
 * the upload, the browser posts straight to object storage, then `POST /agents/:id/skills
 * {uploadId}` unpacks it into the agent's skill (or, for a shared skill the owner maintains, a
 * new version applied at once for an org admin and proposed to the admins otherwise).
 */
export async function uploadAgentSkillZip(
  orgId: string,
  agentId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<RegisteredAgentSkill> {
  const base = `${org(orgId)}/agents/${enc(agentId)}/skills`;
  const created = await apiFetch<CreatedAttachment>(`${base}/uploads`, {
    method: "POST",
    body: JSON.stringify({ name: file.name, size: file.size }),
    ...(opts.signal && { signal: opts.signal }),
  });
  opts.signal?.throwIfAborted();
  await uploadToStorage(created.upload, file, opts);
  opts.signal?.throwIfAborted();
  const r = await apiFetch<{ skill: RegisteredAgentSkill }>(base, {
    method: "POST",
    body: JSON.stringify({ uploadId: created.id }),
    ...(opts.signal && { signal: opts.signal }),
  });
  return r.skill;
}

/** Shares the agent's own skill with the org: at once for an org admin, else a request. */
export const shareAgentSkill = (orgId: string, agentId: string, skillId: string) =>
  apiFetch<{
    share: { kind: "shared"; skillId: string } | { kind: "requested"; requestId: string };
  }>(`${org(orgId)}/agents/${enc(agentId)}/skills/${enc(skillId)}/share`, { method: "POST" }).then(
    (r) => r.share,
  );

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

/** Where an invocable skill comes from (kernel `InvocableSource`). */
export type InvocableSource = "platform" | "plugin" | "agent" | "project";

/**
 * A skill a person can invoke from the composer's `/` menu (kernel `InvocableSkill`, phase D
 * spec §4.5): the agent's effective skills that are not `user-invocable: false`, sorted by name.
 */
export interface InvocableSkill {
  id: string;
  /** The bare name; a project skill's callable name `project:<name>`. */
  name: string;
  /**
   * Where it comes from (project root §4.6): the platform or org library, a plugin, the agent's
   * own, or the conversation's project. The `/` menu groups by it.
   */
  source: InvocableSource;
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
export const listInvocableSkills = (
  orgId: string,
  agentId: string,
  conversationId?: string,
  /** Without a conversation: the new conversation's picked device project (its skills, as last read). */
  project?: { deviceId: string; name: string },
) =>
  apiFetch<{ skills: InvocableSkill[] }>(
    `${org(orgId)}/agents/${enc(agentId)}/invocable-skills${
      conversationId !== undefined
        ? `?conversationId=${enc(conversationId)}`
        : project !== undefined
          ? `?deviceId=${enc(project.deviceId)}&project=${enc(project.name)}`
          : ""
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

/** The prefix of a project skill's callable name (kernel `PROJECT_SKILL_PREFIX`). */
const PROJECT_PREFIX = "project:";

/**
 * The chip of an invocation by `name`, as the thread's bubble draws it: `/<name>` without a
 * plugin's or the project's qualifier (the menu tags where a skill comes from instead).
 */
export const skillChipLabel = (name: string): string => `/${name.slice(name.indexOf(":") + 1)}`;

/** The name the menu and the chip show: a project skill's without its `project:` prefix. */
export const skillShownName = (s: Pick<InvocableSkill, "name" | "source">): string =>
  s.source === "project" && s.name.startsWith(PROJECT_PREFIX)
    ? s.name.slice(PROJECT_PREFIX.length)
    : s.name;

/**
 * The listed skill `name` names: its name, `<plugin>:<name>` for a plugin's skill, or a project
 * skill's bare name when no other skill is called that.
 */
export function findInvocable(
  skills: readonly InvocableSkill[],
  name: string,
): InvocableSkill | undefined {
  // exactly (a project skill's name is `project:<name>`), else `<plugin>:<name>`; a bare name
  // no other skill has is the project's `project:<name>`
  const exact = skills.find((s) => s.name === name);
  const i = name.indexOf(":");
  if (exact !== undefined) return exact;
  if (i < 0) return skills.find((s) => s.source === "project" && s.name === PROJECT_PREFIX + name);
  const plugin = name.slice(0, i);
  const bare = name.slice(i + 1);
  return skills.find((s) => s.plugin === plugin && s.name === bare);
}
