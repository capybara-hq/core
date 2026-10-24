import { webhookBaseUrlProblem } from "../channels/webhook-url.js";
import { envOverrides } from "./env.js";
import { fileSource } from "./file-source.js";
import { createNacosSource, type NacosSourceOptions } from "./nacos-source.js";
import { type KernelConfig, KernelConfigSchema } from "./schema.js";
import { type ConfigSourceKind, configSourceKind, extensionConfigSources } from "./sources.js";
import { ConfigError, type ConfigSource } from "./types.js";

export { ConfigError, type ConfigSource };

/**
 * Nacos 鉴权凭据：`CAPYBARA_NACOS_ACCESS_TOKEN`（静态令牌），或 `CAPYBARA_NACOS_USERNAME` +
 * `CAPYBARA_NACOS_PASSWORD`（登录换取令牌）；都不设则不鉴权。令牌与用户名不能同时设置，用户名与密码必须成对。
 */
function nacosAuth(env: NodeJS.ProcessEnv): Pick<NacosSourceOptions, "auth"> {
  const token = env.CAPYBARA_NACOS_ACCESS_TOKEN;
  const username = env.CAPYBARA_NACOS_USERNAME;
  const password = env.CAPYBARA_NACOS_PASSWORD;
  if (token) {
    if (username || password) {
      throw new ConfigError(
        "set either CAPYBARA_NACOS_ACCESS_TOKEN or CAPYBARA_NACOS_USERNAME / CAPYBARA_NACOS_PASSWORD, not both",
      );
    }
    return { auth: { accessToken: token } };
  }
  if (!username && !password) return {};
  if (!username)
    throw new ConfigError(
      "CAPYBARA_NACOS_USERNAME is required when CAPYBARA_NACOS_PASSWORD is set",
    );
  if (!password)
    throw new ConfigError(
      "CAPYBARA_NACOS_PASSWORD is required when CAPYBARA_NACOS_USERNAME is set",
    );
  return { auth: { username, password } };
}

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
      const server = need("CAPYBARA_NACOS_SERVER");
      const namespace = need("CAPYBARA_NACOS_NAMESPACE");
      const dataId = need("CAPYBARA_NACOS_DATA_ID");
      return createNacosSource({ server, namespace, dataId, ...nacosAuth(env) });
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
  // Cross-section rule (the loopback exception lives under `tools`)
  const webhookProblem = webhookBaseUrlProblem(result.data);
  if (webhookProblem !== null) {
    throw new ConfigError(`invalid configuration:\n  - channels.webhookBaseUrl: ${webhookProblem}`);
  }
  return result.data;
}

/** 选来源 → 深合并环境变量覆盖（优先级最高）→ 校验。 */
export async function loadConfig(env: NodeJS.ProcessEnv): Promise<KernelConfig> {
  return resolveConfig(await selectConfigSource(env).load(), env);
}

/**
 * 与 {@link loadConfig} 相同，另给出各插件部署配置字段的来源（文件 / Nacos / 环境变量，见
 * {@link extensionConfigSources}）：传给 `createKernel` 的 `extensionConfigSources`，后台据此把这些字段标为只读（D8）。
 */
export async function loadConfigWithSources(env: NodeJS.ProcessEnv): Promise<{
  config: KernelConfig;
  pluginSources: Record<string, Record<string, ConfigSourceKind>>;
}> {
  const raw = await selectConfigSource(env).load();
  const config = resolveConfig(raw, env);
  return { config, pluginSources: extensionConfigSources(raw, env, configSourceKind(env)) };
}
