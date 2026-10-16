/** ctx 命名空间（即插件名）的合法形式，与 definePlugin 的 name 规则一致。 */
const NAMESPACE_RE = /^[a-z][a-z0-9-]{1,40}$/;

/**
 * 断言 namespace 合法：仅小写字母、数字与 `-`。
 * 各 ctx 工厂据此保证键 / 频道 / 队列名里的分隔符（`:`、`.`）不会出现在 namespace 内，
 * 从而不同插件拼出的名字不可能相同。
 */
export function assertNamespace(namespace: string): void {
  if (typeof namespace !== "string" || !NAMESPACE_RE.test(namespace)) {
    throw new TypeError(
      `ctx namespace must match ${NAMESPACE_RE}, got ${JSON.stringify(namespace)}`,
    );
  }
}
