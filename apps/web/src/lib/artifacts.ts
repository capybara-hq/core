import { ApiClientError, apiFetch } from "./api";
import type { ConversationEvent } from "./conversations";

/**
 * 产物（agent 经 `sandbox_deliver` 交付的文件）与对话沙箱的状态。产物列表从会话日志的 `artifact_created`
 * 重建（日志是唯一事实源），字节经内核的 artifacts 接口取：
 * - 下载 `GET .../artifacts/:id/download`：302 到预签名地址，一律 attachment；
 * - 缩略图 `?inline=1`：内核只对位图（PNG / JPEG / GIF / WebP）给 inline，SVG / HTML 等一律仍是 attachment；
 * - 文本预览 `GET .../artifacts/:id/preview`：开头若干行，JSON 字符串，界面按纯文本显示（从不当 HTML 渲染）。
 */

export interface Artifact {
  id: string;
  name: string;
  contentType: string;
  size: number;
  /** 交付时间（事件的 createdAt）。 */
  createdAt: string;
  seq: number;
}

/** 日志里的产物，最新的在前（同一 id 只取第一次）。 */
export function artifactsOf(events: ConversationEvent[]): Artifact[] {
  const out: Artifact[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (e.type !== "artifact_created" || seen.has(e.payload.artifactId)) continue;
    seen.add(e.payload.artifactId);
    out.push({
      id: e.payload.artifactId,
      name: e.payload.name,
      contentType: e.payload.contentType,
      size: e.payload.size,
      createdAt: e.createdAt,
      seq: e.seq,
    });
  }
  return out.reverse();
}

const baseType = (ct: string) => (ct.split(";")[0] ?? "").trim().toLowerCase();

/** 与内核 `isInlineArtifactType` 一致：只有位图有缩略图。 */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const isImageArtifact = (ct: string): boolean => INLINE_TYPES.has(baseType(ct));

/** 与内核 `isTextArtifactType` 一致：`text/*` 与常见的文本格式有文本预览。 */
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/sql",
]);
export function isTextArtifact(ct: string): boolean {
  const t = baseType(ct);
  return t.startsWith("text/") || TEXT_TYPES.has(t);
}

const one = (orgId: string, conversationId: string) =>
  `/api/v1/orgs/${encodeURIComponent(orgId)}/conversations/${encodeURIComponent(conversationId)}`;

/** 下载地址（同源；内核 302 到预签名地址）。`inline` 用于位图缩略图。 */
export const artifactDownloadUrl = (
  orgId: string,
  conversationId: string,
  artifactId: string,
  opts: { inline?: boolean } = {},
) =>
  `${one(orgId, conversationId)}/artifacts/${encodeURIComponent(artifactId)}/download${
    opts.inline ? "?inline=1" : ""
  }`;

export interface ArtifactPreview {
  text: string;
  /** 只截取了开头。 */
  truncated: boolean;
}

/** 文本产物的开头若干行。 */
export const getArtifactPreview = (orgId: string, conversationId: string, artifactId: string) =>
  apiFetch<{ preview: ArtifactPreview }>(
    `${one(orgId, conversationId)}/artifacts/${encodeURIComponent(artifactId)}/preview`,
  ).then((r) => r.preview);

export interface SandboxStatus {
  status: "running" | "suspended";
  lastUsedAt: string;
}

/** 对话沙箱的状态；还没有（未创建、已销毁）→ null。 */
export async function getSandboxStatus(
  orgId: string,
  conversationId: string,
): Promise<SandboxStatus | null> {
  try {
    return await apiFetch<SandboxStatus>(`${one(orgId, conversationId)}/sandbox`);
  } catch (e) {
    if (e instanceof ApiClientError && e.code === "sandbox.not_found") return null;
    throw e;
  }
}
