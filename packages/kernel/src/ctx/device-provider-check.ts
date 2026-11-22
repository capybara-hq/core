import type { DeviceProvider } from "@capybara-hq/plugin-sdk";

const REQUIRED_FUNCTIONS = ["report", "killTagged", "exec", "create", "createFileSystem"] as const;

/**
 * Checks a plugin's `device-provider@1` implementation when it is provided: the declarations
 * (`networkAllowlist`, `concurrentExec`) must be `true` and the required methods must exist. A
 * failure fails the plugin's setup, so it never loads.
 */
export function checkDeviceProvider(plugin: string, impl: unknown): DeviceProvider {
  const p = (impl ?? {}) as Record<string, unknown>;
  const need = (member: string): never => {
    throw new Error(`plugin ${plugin}: device-provider@1 requires ${member}`);
  };
  if (p.networkAllowlist !== true) need("networkAllowlist");
  if (p.concurrentExec !== true) need("concurrentExec");
  for (const m of REQUIRED_FUNCTIONS) {
    if (typeof p[m] !== "function") need(m);
  }
  return impl as DeviceProvider;
}
