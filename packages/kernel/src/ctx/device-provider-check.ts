import type { DeviceProvider } from "@capybara-hq/plugin-sdk";

const REQUIRED_FUNCTIONS = ["report", "killTagged", "exec", "create", "createFileSystem"] as const;

/**
 * Checks a plugin's `device-provider@1` implementation when it is provided: the declarations
 * (`networkAllowlist`, `concurrentExec`) must be `true` and the required methods must exist. A
 * provider declaring `permissions.dialIn` (`dialIn` given) must implement `dialIn.onHello` (its
 * `onFrame` and `onClose`, when present, are functions); one that does not declare it must not
 * implement `dialIn`. A failure fails the plugin's setup, so it never loads.
 */
export function checkDeviceProvider(
  plugin: string,
  impl: unknown,
  dialIn?: { protocol: string },
): DeviceProvider {
  const p = (impl ?? {}) as Record<string, unknown>;
  const need = (member: string): never => {
    throw new Error(`plugin ${plugin}: device-provider@1 requires ${member}`);
  };
  if (p.networkAllowlist !== true) need("networkAllowlist");
  if (p.concurrentExec !== true) need("concurrentExec");
  for (const m of REQUIRED_FUNCTIONS) {
    if (typeof p[m] !== "function") need(m);
  }
  const handler = p.dialIn as Record<string, unknown> | null | undefined;
  if (dialIn === undefined) {
    if (handler !== undefined)
      throw new Error(
        `plugin ${plugin}: device-provider@1 implements dialIn without declaring permissions.dialIn`,
      );
    return impl as DeviceProvider;
  }
  if (handler === null || typeof handler !== "object" || typeof handler.onHello !== "function")
    need("dialIn.onHello (it declares permissions.dialIn)");
  for (const m of ["onFrame", "onClose"] as const) {
    const fn = (handler as Record<string, unknown>)[m];
    if (fn !== undefined && typeof fn !== "function") need(`dialIn.${m} to be a function`);
  }
  return impl as DeviceProvider;
}
