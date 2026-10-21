/**
 * 对象存储契约 `object-store@1`：单选、中转能力（插件不得 `requires`，经 `ctx.storage` 取用）。
 * 提供方实现 {@link ObjectStore}；插件拿到的 `ctx.storage`（{@link PluginStorage}）由内核包一层：
 * 每个方法多一个打头的 `orgId`，键自动加前缀 `plugins/<插件名>/<orgId>/`。
 */

/** 对象存储能力引用。 */
export const OBJECT_STORE_CAPABILITY = "object-store@1";

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
  /** 读取；不存在返回 null。`range` 为闭区间字节范围，缺省 `end` 表示读到末尾。 */
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
  /** 分页列举前缀下的对象；返回的 `cursor` 缺省表示没有下一页。 */
  list(
    prefix: string,
    opts?: { cursor?: string; limit?: number },
  ): Promise<{ items: ObjectHead[]; cursor?: string }>;
  /** 预签名下载 URL；`downloadName` 用于 Content-Disposition。 */
  presignGet(key: string, opts: { ttlSeconds: number; downloadName?: string }): Promise<string>;
  /** 预签名上传 URL：上传方须带上返回的 `headers`；存储端按 `maxSize` 限制大小。 */
  presignPut(
    key: string,
    opts: { contentType: string; maxSize: number; ttlSeconds: number },
  ): Promise<{ url: string; headers: Record<string, string> }>;
}
