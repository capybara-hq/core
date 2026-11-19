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

/**
 * The permission keys B1 replaced, each with its replacement. The old keys are no longer read:
 * {@link refuseLegacyPermissionKeys} refuses them with the conversion message, and
 * `capybara config migrate-permissions` (`permission-migration.ts`) converts a config file.
 */
export const LEGACY_PERMISSION_KEYS = [
  {
    path: ["devices", "autoMode"],
    replacement: ["devices", "fullAccess"],
    env: "CAPYBARA_DEVICES__AUTO_MODE",
    replacementEnv: "CAPYBARA_DEVICES__FULL_ACCESS",
  },
] as const;

/**
 * The conversion message of every old permission key in ONE config source (the file / Nacos
 * document, or the environment overrides), empty when it names none. The old key is refused even
 * when it agrees with its replacement, so a source is converted once, never read under two names.
 * The value is never echoed.
 */
function legacyPermissionKeyProblems(
  source: Record<string, unknown>,
  label: "file" | "env",
): string[] {
  const problems: string[] = [];
  for (const key of LEGACY_PERMISSION_KEYS) {
    const [section, old] = key.path;
    const parent = source[section];
    if (!isPlainObject(parent) || !(old in parent)) continue;
    problems.push(
      label === "env"
        ? `  - ${key.env} is no longer read: set ${key.replacementEnv} instead (the same values, allowed or off)`
        : `  - ${key.path.join(".")} is no longer read: rename it to ${key.replacement.join(".")} (the same values, allowed or off); capybara config migrate-permissions --in <file> --out <file> converts a config file or Nacos document`,
    );
  }
  return problems;
}

/** Refuses the old permission keys of the file / Nacos document and the environment. */
function refuseLegacyPermissionKeys(
  raw: Record<string, unknown>,
  env: Record<string, unknown>,
): void {
  const problems = [
    ...legacyPermissionKeyProblems(raw, "file"),
    ...legacyPermissionKeyProblems(env, "env"),
  ];
  if (problems.length > 0) throw new ConfigError(`invalid configuration:\n${problems.join("\n")}`);
}

/** 原始配置深合并环境变量覆盖（优先级最高）后校验；热更新与启动共用。错误只列路径不列值。 */
export function resolveConfig(raw: unknown, env: NodeJS.ProcessEnv): KernelConfig {
  if (!isPlainObject(raw)) throw new ConfigError("config file root must be a mapping");
  const overrides = envOverrides(env);
  refuseLegacyPermissionKeys(raw, overrides);
  const merged = deepMerge(raw, overrides);
  const result = KernelConfigSchema.safeParse(merged);
  if (!result.success) {
    // The schema is strict: an unknown key (a typo, or a removed setting) is an error that names
    // its full path, never silently dropped.
    const lines = result.error.issues.flatMap((i) => {
      if (i.code === "unrecognized_keys") {
        return i.keys.map((k) => `  - unknown config key ${[...i.path, k].map(String).join(".")}`);
      }
      return [`  - ${i.path.map(String).join(".") || "(root)"}: ${i.message}`];
    });
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
 * Like {@link loadConfig}, and also where each extension deployment config field comes from (file
 * / Nacos / environment, see {@link extensionConfigSources}): the `extensionConfigSources` option of
 * `startKernelApp` / `createKernelApp`, by which the admin console marks these fields read-only (D8).
 */
export async function loadConfigWithSources(env: NodeJS.ProcessEnv): Promise<{
  config: KernelConfig;
  extensionConfigSources: Record<string, Record<string, ConfigSourceKind>>;
}> {
  const raw = await selectConfigSource(env).load();
  const config = resolveConfig(raw, env);
  return {
    config,
    extensionConfigSources: extensionConfigSources(raw, env, configSourceKind(env)),
  };
}
