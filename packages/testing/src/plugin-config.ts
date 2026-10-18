import { assertSecretsReachable, secretValues } from "@capybara-hq/kernel";
import type { PluginManifest } from "@capybara-hq/plugin-sdk";

/**
 * 插件测试用：执行内核加载插件时的密钥标记检查（`PluginHost` 用的同一个 `assertSecretsReachable`），
 * `secret()` 不在对象字段路径上时抛错（插件会被内核拒绝加载）。
 */
export function assertPluginSecretsReachable(manifest: PluginManifest): void {
  assertSecretsReachable(manifest);
}

/** 插件测试用：内核会登记给 logger 打码的部署级配置密钥值（与 `PluginHost` 加载时相同的收集逻辑）。 */
export function pluginDeploymentSecretValues(manifest: PluginManifest, config: unknown): string[] {
  const schema = manifest.config?.deployment;
  if (!schema) return [];
  return secretValues(schema, schema.parse(config));
}
