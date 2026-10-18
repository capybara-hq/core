/**
 * 工具命名（Global Constraints）：模型可见的工具 key 必须匹配 `^[a-zA-Z0-9_-]{1,64}$`；
 * 插件工具为 `<plugin>__<tool>`，应用工具为 `<appSlug>__<tool>`，内置工具就是其名字本身。
 * 超长或含非法字符的 key 一律报出来，不截断、不猜。
 */

export const TOOL_KEY_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const TOOL_KEY_MAX = 64;

/** 应用 slug：小写字母开头，小写字母 / 数字 / 下划线，最长 24。 */
export const APP_SLUG_RE = /^[a-z][a-z0-9_]{0,23}$/;

/** 前缀与工具名之间的分隔符。 */
export const KEY_SEPARATOR = "__";

/**
 * slug 是否合法：除正则外，不得含连续下划线、不得以下划线结尾——否则 `a__b` + `c` 与 `a` + `b__c`
 * 会拼出同一个 key。
 */
export function isValidSlug(slug: string): boolean {
  return APP_SLUG_RE.test(slug) && !slug.includes("__") && !slug.endsWith("_");
}

/** slug 不合法时的英文说明（给 validation_failed 用）。 */
export const SLUG_RULE =
  "Slug must start with a lowercase letter, contain only lowercase letters, digits and single underscores, not end with an underscore, and be at most 24 characters";

/**
 * 由应用名推导 slug：转小写，非 `[a-z0-9]` 的连续字符折成一个下划线，去掉首尾下划线与开头的数字 / 下划线，
 * 截到 24 位（再去掉尾部下划线）。推导不出合法 slug（如名称全是中文）时返回 null，由调用方要求显式给出。
 */
export function deriveSlug(name: string): string | null {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .slice(0, 24)
    .replace(/_+$/, "");
  return isValidSlug(s) ? s : null;
}

/** 拼 `<prefix>__<name>`。 */
export function toolKey(prefix: string, name: string): string {
  return `${prefix}${KEY_SEPARATOR}${name}`;
}

/** key 不合法时返回英文原因，合法时返回 null。 */
export function toolKeyIssue(key: string): string | null {
  if (key.length > TOOL_KEY_MAX) {
    return `Tool key "${key}" is ${key.length} characters; the limit is ${TOOL_KEY_MAX}`;
  }
  if (!TOOL_KEY_RE.test(key)) {
    return `Tool key "${key}" contains characters outside [a-zA-Z0-9_-]`;
  }
  return null;
}
