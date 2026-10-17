import { envOverrides } from "./env.js";
import { fileSource } from "./file-source.js";
import { createNacosSource } from "./nacos-source.js";
import { type KernelConfig, KernelConfigSchema } from "./schema.js";
import { ConfigError, type ConfigSource } from "./types.js";

export { ConfigError, type ConfigSource };

/** 按 `CAPYBARA_CONFIG_SOURCE` 选择配置来源，默认 `file`。 */
export function selectConfigSource(env: NodeJS.ProcessEnv): ConfigSource {
  const kind = env.CAPYBARA_CONFIG_SOURCE || "file";
  switch (kind) {
    case "file":
      return fileSource(env.CAPYBARA_CONFIG_FILE);
    case "nacos": {
      const need = (name: string): string => {
        const v = env[name];
        if (!v) throw new ConfigError(`${name} is required when CAPYBARA_CONFIG_SOURCE=nacos`);
        return v;
      };
      return createNacosSource({
        server: need("CAPYBARA_NACOS_SERVER"),
        namespace: need("CAPYBARA_NACOS_NAMESPACE"),
        dataId: need("CAPYBARA_NACOS_DATA_ID"),
      });
    }
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

/** 原始配置深合并环境变量覆盖（优先级最高）后校验；热更新与启动共用。错误只列路径不列值。 */
export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv): KernelConfig {
  if (!isPlainObject(raw)) throw new ConfigError("config file root must be a mapping");
  const merged = deepMerge(raw, envOverrides(env));
  const result = KernelConfigSchema.safeParse(merged);
  if (!result.success) {
    const lines = result.error.issues.map(
      (i) => `  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`,
    );
    throw new ConfigError(`invalid configuration:\n${lines.join("\n")}`);
  }
  return result.data;
}

/** 选来源 → 深合并环境变量覆盖（优先级最高）→ 校验。 */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<KernelConfig> {
  return resolveConfig(await selectConfigSource(env).load(), env);
}
