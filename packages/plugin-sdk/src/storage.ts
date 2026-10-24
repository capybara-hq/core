/**
 * Object storage contract `object-store@1`: a single-select, brokered extension point (extensions
 * may not `requires` it; they use it through `ctx.storage`). The provider implements
 * {@link ObjectStore}; the `ctx.storage` an extension gets ({@link ExtensionStorage}) is wrapped by
 * the kernel: every method takes a leading `orgId`, and keys get the prefix
 * `plugins/<extension name>/<orgId>/`.
 */

/** Object storage extension point ref. */
export const OBJECT_STORE_EXTENSION_POINT = "object-store@1";

/** 对象的元数据。 */
export interface ObjectHead {
  key: string;
  /** 字节数。 */
  size: number;
  contentType: string;
  etag?: string;
  /** ISO 8601 时间。 */
  lastModified?: string;
}

/** `object-store@1` 的实现（由对象存储插件提供，如 S3 兼容存储）。 */
export interface ObjectStore {
  /** 写入（覆盖同名键）；`body` 是流时最好给出 `size`。 */
  put(
    key: string,
    body: Uint8Array | ReadableStream<Uint8Array>,
    opts: { contentType: string; size?: number; signal?: AbortSignal },
  ): Promise<ObjectHead>;
  /**
   * 读取；不存在返回 null。`range` 为闭区间字节范围，缺省 `end` 表示读到末尾。
   * 带 `range` 时 `head.size` 仍是整个对象的大小；存储忽略 Range 时 body 可能是整个对象。
   */
  get(
    key: string,
    opts?: { signal?: AbortSignal; range?: { start: number; end?: number } },
  ): Promise<{ head: ObjectHead; body: ReadableStream<Uint8Array> } | null>;
  /** 不存在返回 null。 */
  head(key: string): Promise<ObjectHead | null>;
  /** 删除；不存在也算成功。 */
  delete(key: string): Promise<void>;
  /** 删除前缀下的全部对象，返回删除数（用于组织数据删除）。 */
  deletePrefix(prefix: string): Promise<number>;
  /**
   * 分页列举前缀下的对象；返回的 `cursor` 缺省表示没有下一页。列举结果不带类型时 `contentType` 为空串
   * （需要时用 `head` 取）。
   */
  list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ObjectHead[]; cursor?: string }>;
  /** 预签名下载 URL（选项见 {@link PresignGetOptions}）。 */
  presignGet(key: string, opts: PresignGetOptions): Promise<string>;
  /**
   * 预签名上传：浏览器按返回的 {@link PresignedUpload} 直传存储。超过 `maxSize` 的上传必须由**存储端**拒绝
   * （预签名 PUT 无法限制大小，所以 S3 兼容实现用带 `content-length-range` 条件的 POST 策略）。
   */
  presignPut(
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<PresignedUpload>;
}

/** 预签名下载的选项。 */
export interface PresignGetOptions {
  ttlSeconds: number;
  /** 下载文件名，进 `Content-Disposition`（RFC 6266，非 ASCII 用 `filename*=UTF-8''…`）。 */
  downloadName?: string;
  /**
   * 浏览器打开方式：`attachment`（缺省，下载）或 `inline`（在页面里显示）。用户上传的内容只应对
   * 不会执行脚本的类型（图片、PDF）用 `inline`。
   */
  disposition?: "attachment" | "inline";
  /** 覆盖响应的 `Content-Type`（如按核对过的类型返回，而不是存储里记的类型）。 */
  responseContentType?: string;
}

/**
 * 预签名上传的请求方式：
 * - `PUT`：请求体就是文件字节，请求头带上 `headers`；
 * - `POST`：`multipart/form-data` 表单，先按原样放入 `fields` 的每一项，**最后**放文件字段 `file`；
 *   请求头带上 `headers`（通常为空）。
 */
export interface PresignedUpload {
  method: "PUT" | "POST";
  url: string;
  headers: Record<string, string>;
  /** `POST` 时必有：表单字段（含策略与签名）。 */
  fields?: Record<string, string>;
}
