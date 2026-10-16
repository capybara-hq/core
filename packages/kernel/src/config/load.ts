import { envOverrides } from "./env.js";
import { fileSource } from "./file-source.js";
import { type KernelConfig, KernelConfigSchema } from "./schema.js";

/** 配置来源：`load` 取原始配置，`watch` 可选地订阅变更并返回取消函数。 */
export interface ConfigSource {
  load(): Promise<unknown>;
  watch?(onChange: (raw: unknown) => void): () => void;
}

/** 配置加载或校验失败。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 按 `CAPYBARA_CONFIG_SOURCE` 选择配置来源，默认 `file`。 */
export function selectConfigSource(env: NodeJS.ProcessEnv): ConfigSource {
  const kind = env.CAPYBARA_CONFIG_SOURCE ?? "file";
  switch (kind) {
    case "file":
      return fileSource(env.CAPYBARA_CONFIG_FILE);
    case "nacos":
      throw new ConfigError("config source 'nacos' is not implemented yet");
    default:
      throw new ConfigError(`unknown config source '${kind}' (expected 'file' or 'nacos')`);
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** 深合并：对象递归合并，其余（含数组）由 override 整体替换。 */
export function deepMerge(base: unknown, override: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

/** 选来源 → 深合并环境变量覆盖（优先级最高）→ 校验。 */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<KernelConfig> {
  const source = selectConfigSource(env);
  const raw = await source.load();
  const merged = deepMerge(isPlainObject(raw) ? raw : {}, envOverrides(env));
  const result = KernelConfigSchema.safeParse(merged);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(`invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}
