import { Inject, Injectable } from "@nestjs/common";
import { ApiError } from "../errors.js";
import { isLive, type ReferencedFile, ReferencedFiles } from "../files/referenced-files.js";
import { StorageService } from "../storage/storage.service.js";
import { UUID_RE } from "../ui/registry.js";
import { ConversationAccess } from "./access.js";

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
 * A conversation's files by id (M5 T8 / T11; file library spec §2): any file the conversation
 * refers to (a delivery or an upload sent in it). The conversation must be visible by the event
 * stream's rule (else `conversation.not_found`); the file must be one the conversation refers to,
 * not deleted, its blob readable (else `conversation.artifact_not_found`). Bytes are read through
 * the file's blob (size and etag checked), never an event's `objectKey`.
 *
 * - Download: a 302 to a presigned address, `attachment` by default (with the file's name and
 *   type); `inline` only takes effect for bitmaps (the web's thumbnails).
 * - Text preview: `text/*` and the text formats, the first {@link ARTIFACT_PREVIEW_MAX_BYTES} bytes
 *   by range, at most {@link ARTIFACT_PREVIEW_MAX_LINES} lines, as a JSON string (shown as plain
 *   text); other types, or NUL bytes in the head (binary after all) →
 *   `conversation.artifact_not_previewable`.
 */
@Injectable()
export class ConversationArtifacts {
  constructor(
    @Inject(StorageService) private readonly storage: Pick<StorageService, "kernel">,
    /** Conversation visibility (the same rule as the conversation's SSE stream). */
    @Inject(ConversationAccess) private readonly access: Pick<ConversationAccess, "isAccessible">,
    /** The files the conversation refers to, and their bytes. */
    @Inject(ReferencedFiles)
    private readonly files: Pick<ReferencedFiles, "references" | "open" | "head">,
  ) {}

  private async find(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
  ): Promise<ReferencedFile> {
    if (!UUID_RE.test(conversationId)) throw conversationNotFound();
    if (!(await this.access.isAccessible(orgId, conversationId, viewerAccountId))) {
      throw conversationNotFound();
    }
    if (!UUID_RE.test(artifactId)) throw artifactNotFound();
    const [f] = await this.files.references(orgId, [conversationId], { ids: [artifactId] });
    if (!f || !isLive(f)) throw artifactNotFound();
    return f;
  }

  async downloadUrl(
    orgId: string,
    conversationId: string,
    viewerAccountId: string,
    artifactId: string,
    opts: { inline?: boolean } = {},
  ): Promise<{ url: string; name: string }> {
    const a = await this.find(orgId, conversationId, viewerAccountId, artifactId);
    if (!(await this.files.head(orgId, a))) throw artifactNotFound();
    const inline = opts.inline === true && isInlineArtifactType(a.contentType);
    const url = await this.storage.kernel(orgId).presignGet(a.blob.objectKey, {
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
    const got = await this.files.open(orgId, a, {
      range: { start: 0, end: ARTIFACT_PREVIEW_MAX_BYTES - 1 },
    });
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
