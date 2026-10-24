import { assertSecretsReachable, secretValues } from "@capybara-hq/kernel";
import type { ExtensionManifest } from "@capybara-hq/plugin-sdk";

/**
 * For extension tests: runs the kernel's secret marker check done when loading an extension (the same
 * `assertSecretsReachable` as `ExtensionHost` uses); throws when a `secret()` is not on an object
 * field path (the kernel would refuse to load the extension).
 */
export function assertPluginSecretsReachable(manifest: ExtensionManifest): void {
  assertSecretsReachable(manifest);
}

/** For extension tests: the deployment config secret values the kernel registers for log redaction (the same collection logic as `ExtensionHost` uses when loading). */
export function pluginDeploymentSecretValues(
  manifest: ExtensionManifest,
  config: unknown,
): string[] {
  const schema = manifest.config?.deployment;
  if (!schema) return [];
  return secretValues(schema, schema.parse(config));
}
