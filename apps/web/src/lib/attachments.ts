import { ApiClientError, apiFetch } from "./api";

/**
 * 对话附件（上传的文件）：登记 → 浏览器直传对象存储（预签名）→ finalize → 发消息时在 `files` 里引用 id。
 * 与 `@` 资源引用（`DraftAttachment`，内核读取应用资源）是两回事。
 */

/** 附件上限（内核 `GET /attachments/limits`）。 */
export interface AttachmentLimits {
  types: string[];
  /** 非图片的单个上限（字节）。 */
  maxBytes: number;
  /** 图片的单个上限（字节）。 */
  imageMaxBytes: number;
  maxPerMessage: number;
}

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/**
 * 上限接口还没返回（或取不到）时的兜底：抄写内核的默认值（`attachments.*` 配置与 plugin-sdk 的
 * `MEDIA_LIMITS.imageBytes`）。以内核的错误码为准，这里只是提前拦下。
 */
export const DEFAULT_LIMITS: AttachmentLimits = {
  types: [...IMAGE_TYPES, "application/pdf", "text/plain", "text/markdown", "text/csv"],
  maxBytes: 20_971_520,
  imageMaxBytes: 5_242_880,
  maxPerMessage: 10,
};

/** 读取上限（组织成员可读，不需要对象存储）。 */
export const getAttachmentLimits = (orgId: string) =>
  apiFetch<AttachmentLimits>(`/api/v1/orgs/${encodeURIComponent(orgId)}/attachments/limits`);

/** 浏览器没给类型（常见于 .md）时按扩展名推断。 */
const BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  csv: "text/csv",
};

/** 文件的内容类型：去参数、转小写；为空时按扩展名推断。 */
export function fileContentType(file: { name: string; type: string }): string {
  const t = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  if (t !== "") return t;
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return BY_EXTENSION[ext] ?? "application/octet-stream";
}

const isImageType = (ct: string) => (IMAGE_TYPES as readonly string[]).includes(ct);

/** 前端预检：返回与内核一致的错误码，通过时返回 null。 */
export function precheckFile(
  file: { name: string; type: string; size: number },
  limits: AttachmentLimits,
): "attachment.type_not_allowed" | "attachment.too_large" | null {
  const ct = fileContentType(file);
  if (!limits.types.includes(ct)) return "attachment.type_not_allowed";
  const max = isImageType(ct) ? limits.imageMaxBytes : limits.maxBytes;
  if (file.size > max) return "attachment.too_large";
  return null;
}

/** 预签名上传（plugin-sdk `PresignedUpload`）。 */
export interface PresignedUpload {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  fields?: Record<string, string>;
}

export interface CreatedAttachment {
  id: string;
  upload: PresignedUpload;
  expiresAt: string;
}

export interface AttachmentView {
  id: string;
  name: string;
  contentType: string;
  size: number;
}

const base = (orgId: string) => `/api/v1/orgs/${encodeURIComponent(orgId)}/attachments`;

/** 登记：内核核对类型与大小，返回预签名上传（有效 300 秒）。 */
export const createAttachment = (
  orgId: string,
  input: { name: string; contentType: string; size: number },
  signal?: AbortSignal,
) =>
  apiFetch<CreatedAttachment>(base(orgId), {
    method: "POST",
    body: JSON.stringify(input),
    ...(signal && { signal }),
  });

/** 上传完成后核对大小与类型，附件变为可发送。 */
export const finalizeAttachment = (orgId: string, id: string, signal?: AbortSignal) =>
  apiFetch<AttachmentView>(`${base(orgId)}/${encodeURIComponent(id)}/finalize`, {
    method: "POST",
    ...(signal && { signal }),
  });

/** 下载地址（同源；内核 302 到预签名地址）。 */
export const attachmentDownloadUrl = (orgId: string, id: string) =>
  `${base(orgId)}/${encodeURIComponent(id)}/download`;

/** 直传失败（网络 / CORS / 存储拒绝 / 过期）的客户端错误码。 */
export const UPLOAD_FAILED = "attachment.upload_failed";

/**
 * 按预签名直传存储（跨源，不带 Cookie）。用 XMLHttpRequest 以取得上传进度（fetch 没有上传进度）。
 * `POST`：multipart 表单，先放 `fields` 的每一项，最后放 `file`；`PUT`：请求体就是文件。
 */
export function uploadToStorage(
  upload: PresignedUpload,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException("Upload aborted", "AbortError"));
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open(upload.method, upload.url);
    xhr.withCredentials = false;
    for (const [k, v] of Object.entries(upload.headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(new ApiClientError(xhr.status, UPLOAD_FAILED, `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new ApiClientError(0, UPLOAD_FAILED, "Upload failed"));
    xhr.onabort = () => reject(new DOMException("Upload aborted", "AbortError"));
    opts.signal?.addEventListener("abort", () => xhr.abort(), { once: true });
    if (upload.method === "POST") {
      const form = new FormData();
      for (const [k, v] of Object.entries(upload.fields ?? {})) form.append(k, v);
      form.append("file", file);
      xhr.send(form);
    } else {
      xhr.send(file);
    }
  });
}

/** 完整上传：登记 → 直传 → finalize。中止时抛 AbortError。 */
export async function uploadAttachment(
  orgId: string,
  file: File,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<AttachmentView> {
  const created = await createAttachment(
    orgId,
    { name: file.name, contentType: fileContentType(file), size: file.size },
    opts.signal,
  );
  opts.signal?.throwIfAborted();
  await uploadToStorage(created.upload, file, opts);
  opts.signal?.throwIfAborted();
  return finalizeAttachment(orgId, created.id, opts.signal);
}

/** 允许类型的简短列表（预检文案用）：`PNG / JPEG / … / CSV`。 */
export const typeList = (types: readonly string[]): string =>
  types.map(attachmentTypeLabel).join(" / ");

/** 文件卡片上的类型说明。 */
export function attachmentTypeLabel(mediaType: string): string {
  switch (mediaType) {
    case "image/png":
      return "PNG";
    case "image/jpeg":
      return "JPEG";
    case "image/gif":
      return "GIF";
    case "image/webp":
      return "WebP";
    case "application/pdf":
      return "PDF";
    case "text/plain":
      return "TXT";
    case "text/markdown":
      return "Markdown";
    case "text/csv":
      return "CSV";
    default:
      return mediaType;
  }
}
