import { Inject, Injectable } from "@nestjs/common";
import { sql } from "kysely";
import { ApiError } from "../errors.js";
import { KernelDb } from "../infra/database/kernel-db.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";
import type { EventPayload } from "./events.js";

/** 产物下载跳转的预签名有效期（秒）。 */
export const ARTIFACT_DOWNLOAD_TTL_SECONDS = 300;
/** 下载 302 的 `Cache-Control: private, max-age=…`（秒），不长于预签名有效期。 */
export const ARTIFACT_DOWNLOAD_CACHE_SECONDS = 60;
/** 文本预览最多读取的字节数（从对象开头按 Range 读）。 */
export const ARTIFACT_PREVIEW_MAX_BYTES = 8192;
/** 文本预览最多的行数。 */
export const ARTIFACT_PREVIEW_MAX_LINES = 40;

/** 可以 `inline` 打开的类型：只有位图（SVG 能执行脚本，HTML 更不行，一律下载）。 */
const INLINE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** `text/*` 之外也给文本预览的类型。 */
const TEXT_TYPES = new Set([
  "application/json",
  "application/xml",
  "application/yaml",
  "application/sql",
]);

const baseType = (ct: string) => (ct.split(";")[0] ?? "").trim().toLowerCase();

/** 产物能否以 `inline` 在页面里显示（只有位图）。 */
export const isInlineArtifactType = (ct: string): boolean => INLINE_TYPES.has(baseType(ct));

/** 产物能否给文本预览（`text/*` 与常见的文本格式；SVG 不算）。 */
export function isTextArtifactType(ct: string): boolean {
  const t = baseType(ct);
  return t.startsWith("text/") || TEXT_TYPES.has(t);
}

/** 文本预览：开头若干行（纯文本，网页按纯文本显示，从不当 HTML 渲染）。 */
export interface ArtifactPreview {
  text: string;
  /** 只截取了开头（文件更长）。 */
  truncated: boolean;
}

const conversationNotFound = () => new ApiError("conversation.not_found", "Conversation not found");
const artifactNotFound = () =>
  new ApiError("conversation.artifact_not_found", "Artifact not found");

/** 从流里读最多 `max` 字节（存储忽略 Range 时 body 可能是整个对象，读够就取消）。 */
async function readPrefix(body: ReadableStream<Uint8Array>, max: number): Promise<Uint8Array> {
  const reader = body.getReader();
  const out = new Uint8Array(max);
  let n = 0;
  try {
    while (n < max) {
      const { done, value } = await reader.read();
      if (done) break;
      const take = Math.min(value.byteLength, max - n);
      out.set(value.subarray(0, take), n);
      n += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return out.subarray(0, n);
}

/**
 * 产物（M5 T8 / T11）：agent 经 `sandbox_deliver` 交付的文件。先按会话流的规则判定会话可见
 * （不可见 → `conversation.not_found`），再只在这个会话的日志里找 `artifact_created`
 * （没有 → `conversation.artifact_not_found`）。
 *
 * - 下载：302 到预签名地址，默认 `attachment`（带交付时的文件名与类型）；`inline` 只对位图生效
 *   （网页的缩略图），其余类型即使要求 inline 也仍是 `attachment`。
 * - 文本预览：`text/*` 等文本类，按 Range 读开头 {@link ARTIFACT_PREVIEW_MAX_BYTES} 字节、
 *   至多 {@link ARTIFACT_PREVIEW_MAX_LINES} 行，以 JSON 字符串返回（网页按纯文本显示）；
 *   其他类型、或读到的开头里有 NUL 字节（其实是二进制）→ `conversation.artifact_not_previewable`。
 *
 * 查找走 `conversation_events` 的主键 `(conversation_id, seq)` 前缀，在 SQL 里按 `type` 与
 * `payload->>'artifactId'` 过滤、`LIMIT 1`（只扫这一个会话的事件，不在 JS 里扫日志；不加迁移）。
 */
@Injectable()
export class ConversationArtifacts {
  constructor(
    @Inject(KernelDb) private readonly db: KernelDb,
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    /** 会话可见性（与会话 SSE 流同一判定）。 */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
  ) {}

  private async find(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
  ): Promise<EventPayload<"artifact_created">> {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.access.isAccessible(orgId, conversationId, viewerAccountId))) {
      throw conversationNotFound();
    }
    if (!UUID_RE.test(artifactId)) throw artifactNotFound();
    const row = await this.db
      .selectFrom("conversation_events")
      .select("payload")
      .where("conversation_id", "=", conversationId)
      .where("type", "=", "artifact_created")
      .where(sql<string>`payload->>'artifactId'`, "=", artifactId)
      .limit(1)
      .executeTakeFirst();
    if (!row) throw artifactNotFound();
    return row.payload as EventPayload<"artifact_created">;
  }

  async downloadUrl(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
    opts: { inline?: boolean } = {},
  ): Promise<{ url: string; name: string }> {
    const a = await this.find(orgId, conversationId, viewerAccountId, artifactId);
    const store = this.storage.kernel(orgId);
    if (!(await store.head(a.objectKey))) throw artifactNotFound();
    const inline = opts.inline === true && isInlineArtifactType(a.contentType);
    const url = await store.presignGet(a.objectKey, {
      ttlSeconds: ARTIFACT_DOWNLOAD_TTL_SECONDS,
      downloadName: a.name,
      disposition: inline ? "inline" : "attachment",
      responseContentType: a.contentType,
    });
    return { url, name: a.name };
  }

  async preview(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
  ): Promise<ArtifactPreview> {
    const a = await this.find(orgId, conversationId, viewerAccountId, artifactId);
    if (!isTextArtifactType(a.contentType)) {
      throw new ApiError(
        "conversation.artifact_not_previewable",
        "Only text artifacts have a preview",
      );
    }
    const got = await this.storage
      .kernel(orgId)
      .get(a.objectKey, { range: { start: 0, end: ARTIFACT_PREVIEW_MAX_BYTES - 1 } });
    if (!got) throw artifactNotFound();
    const bytes = await readPrefix(got.body, ARTIFACT_PREVIEW_MAX_BYTES);
    // 类型说是文本、内容却是二进制（有 NUL）：不给预览，界面显示「不能预览」
    if (bytes.includes(0)) {
      throw new ApiError(
        "conversation.artifact_not_previewable",
        "This artifact contains binary data and has no text preview",
      );
    }
    // stream: true 丢掉被截断在末尾的半个多字节字符
    let text = new TextDecoder("utf-8").decode(bytes, { stream: true });
    let truncated = got.head.size > bytes.byteLength;
    if (truncated) {
      // 只读了开头：去掉最后不完整的一行
      const nl = text.lastIndexOf("\n");
      if (nl >= 0) text = text.slice(0, nl);
    }
    const lines = text.split("\n");
    if (text.endsWith("\n")) lines.pop();
    if (lines.length > ARTIFACT_PREVIEW_MAX_LINES) {
      text = lines.slice(0, ARTIFACT_PREVIEW_MAX_LINES).join("\n");
      truncated = true;
    }
    return { text, truncated };
  }
}
