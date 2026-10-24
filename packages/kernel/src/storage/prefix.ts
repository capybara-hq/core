/**
 * 对象存储的键前缀与校验（扩展模型 §5）：插件 `plugins/<插件名>/<orgId>/`，内核 `kernel/<orgId>/`。
 * 任何拼出来会落到前缀之外的键一律拒绝；校验发生在调用提供方之前。
 */

/** 加前缀后的键长度上限（S3 的键上限是 1024 字节，这里按 UTF-8 字节计）。 */
export const MAX_STORAGE_KEY_BYTES = 1024;

/** 键或前缀不合法（越出前缀、组织 id 不是 UUID 等）。消息为英文、不含键之外的内部信息。 */
export class StorageKeyError extends Error {
  constructor(message: string) {
    super(`invalid storage key: ${message}`);
    this.name = "StorageKeyError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 插件名规则同清单（`defineExtension` 的 name 校验）。 */
const EXTENSION_NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: 正是要拒绝控制字符
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
/** 字面的 `${`（POST 策略的变量起始符）。 */
const TEMPLATE_START = "${";

/**
 * 组织 id 必须是 UUID；统一转成小写，同一组织不论大小写都落到同一个前缀
 * （内核生成的组织 id 本来就是小写）。
 */
export function normalizeOrgId(orgId: string): string {
  if (typeof orgId !== "string" || !UUID_RE.test(orgId)) {
    throw new StorageKeyError("organization id must be a UUID");
  }
  return orgId.toLowerCase();
}

/** 插件名必须符合清单规则（不含 `/`、`..`）。 */
export function assertPluginName(plugin: string): void {
  if (typeof plugin !== "string" || !EXTENSION_NAME_RE.test(plugin)) {
    throw new StorageKeyError(`plugin name "${plugin}" is not valid`);
  }
}

/**
 * 校验调用方给的相对键（`allowEmpty` 时是列举 / 批量删除的前缀，空串表示全部）：
 * 不能以 `/` 开头，不能有 `.` / `..` 段，不能含 `\`、控制字符与 `${`
 * （S3 POST 策略会把键里的 `${filename}` 换成上传方给的文件名，键就不再是签名时的那个）。
 */
function assertRelative(key: string, allowEmpty: boolean): void {
  if (typeof key !== "string") throw new StorageKeyError("key must be a string");
  if (key === "") {
    if (allowEmpty) return;
    throw new StorageKeyError("key must not be empty");
  }
  if (key.startsWith("/")) throw new StorageKeyError("key must not start with '/'");
  if (key.includes("\\")) throw new StorageKeyError("key must not contain '\\'");
  if (CONTROL_RE.test(key)) throw new StorageKeyError("key must not contain control characters");
  if (key.includes(TEMPLATE_START))
    throw new StorageKeyError(`key must not contain '${TEMPLATE_START}'`);
  for (const seg of key.split("/")) {
    if (seg === "." || seg === "..") {
      throw new StorageKeyError("key must not contain '.' or '..' segments");
    }
  }
}

/** 一个组织下的键空间：把相对键拼成完整键，把完整键还原成相对键。 */
export class KeySpace {
  /** @param prefix 以 `/` 结尾的完整前缀（如 `plugins/x/<orgId>/`）。 */
  constructor(readonly prefix: string) {}

  /** 对象键：非空，拼接后不超过 {@link MAX_STORAGE_KEY_BYTES}。 */
  key(key: string): string {
    assertRelative(key, false);
    return this.checkLength(this.prefix + key);
  }

  /** 列举 / 批量删除的前缀：可以为空（表示该组织下的全部）。 */
  listPrefix(prefix: string): string {
    assertRelative(prefix, true);
    return this.checkLength(this.prefix + prefix);
  }

  /** 完整键是否在本前缀下。 */
  owns(full: string): boolean {
    return full.startsWith(this.prefix) && full.length > this.prefix.length;
  }

  /** 去掉前缀（调用方先用 {@link owns} 过滤）。 */
  strip(full: string): string {
    return full.slice(this.prefix.length);
  }

  private checkLength(full: string): string {
    if (Buffer.byteLength(full, "utf8") > MAX_STORAGE_KEY_BYTES) {
      throw new StorageKeyError(
        `key is longer than ${MAX_STORAGE_KEY_BYTES} bytes with its prefix`,
      );
    }
    return full;
  }
}

/** 插件在某组织下的前缀 `plugins/<插件>/<orgId>/`。 */
export function pluginPrefix(plugin: string, orgId: string): string {
  assertPluginName(plugin);
  return `plugins/${plugin}/${normalizeOrgId(orgId)}/`;
}

/** 内核在某组织下的前缀 `kernel/<orgId>/`。 */
export function kernelPrefix(orgId: string): string {
  return `kernel/${normalizeOrgId(orgId)}/`;
}
