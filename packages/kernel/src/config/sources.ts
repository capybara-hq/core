import { envOverrides } from "./env.js";

/**
 * 部署级插件配置某个字段的来源（D8 / C10）：启动配置文件、Nacos，或环境变量（优先级最高）。
 * 这些来源里有的字段在后台只读；PG 里的值（`db`）与 schema 默认值优先级更低。
 */
export type ConfigSourceKind = "file" | "nacos" | "env";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** 把一份插件配置展开成叶子点路径（对象递归；数组、null 与标量是叶子；空对象没有叶子）。 */
function leafPaths(value: unknown, prefix: string, out: string[]): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) leafPaths(v, prefix ? `${prefix}.${k}` : k, out);
    return;
  }
  if (prefix !== "") out.push(prefix);
}

function mark(
  out: Record<string, Record<string, ConfigSourceKind>>,
  extensionConfig: unknown,
  kind: ConfigSourceKind,
): void {
  if (!isPlainObject(extensionConfig)) return;
  for (const [plugin, value] of Object.entries(extensionConfig)) {
    const paths: string[] = [];
    leafPaths(value, "", paths);
    if (paths.length === 0) continue;
    const target = out[plugin] ?? {};
    out[plugin] = target;
    for (const p of paths) target[p] = kind;
  }
}

/**
 * 启动配置里各插件部署配置的来源：`raw` 是配置来源（文件 / Nacos，`kind`）读出的原始对象，`env` 里
 * `CAPYBARA_EXTENSION_CONFIG*` 推导出的覆盖（逐字段或整段 JSON）记为 `env`（优先级最高，覆盖同一路径的文件来源）。
 * 返回插件名 → 叶子点路径 → 来源。只看路径，不含值。
 */
export function extensionConfigSources(
  raw: unknown,
  env: NodeJS.ProcessEnv,
  kind: "file" | "nacos",
): Record<string, Record<string, ConfigSourceKind>> {
  const out: Record<string, Record<string, ConfigSourceKind>> = {};
  if (isPlainObject(raw)) mark(out, raw.extensionConfig, kind);
  mark(out, envOverrides(env).extensionConfig, "env");
  return out;
}

/** `CAPYBARA_CONFIG_SOURCE` 对应的来源种类（默认 file）。 */
export function configSourceKind(env: NodeJS.ProcessEnv): "file" | "nacos" {
  return env.CAPYBARA_CONFIG_SOURCE === "nacos" ? "nacos" : "file";
}

/**
 * 某个配置字段（点路径）是否出现在来源里：来源路径等于它、在它下面（字段是 record / 数组等整体叶子），
 * 或是它的祖先（来源在上层给了非对象值）。环境变量优先。返回来源种类，没有返回 undefined。
 */
export function fieldSource(
  sources: Record<string, ConfigSourceKind> | undefined,
  field: string,
): ConfigSourceKind | undefined {
  if (!sources) return undefined;
  let found: ConfigSourceKind | undefined;
  for (const [p, kind] of Object.entries(sources)) {
    if (p === field || p.startsWith(`${field}.`) || field.startsWith(`${p}.`)) {
      if (kind === "env") return "env";
      found = kind;
    }
  }
  return found;
}
