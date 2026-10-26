import { pluginChecks } from "@capybara-hq/plugin-tools";
import { corePluginScope, requireScanTargets } from "./dirs.js";
import { report } from "./report.js";

/**
 * Runs one of plugin-tools' plugin-scoped checks (by its name in `pluginChecks`) on core's scope
 * ({@link corePluginScope}) and reports it: the `pnpm check:<name>` scripts of those checks.
 */
export async function reportPluginCheck(name: string): Promise<void> {
  requireScanTargets();
  const check = pluginChecks(corePluginScope()).find((c) => c.name === name);
  if (check === undefined) throw new Error(`plugin-tools has no plugin check named ${name}`);
  report(name, await check.run());
}
