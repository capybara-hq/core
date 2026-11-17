import { type NamedCheck, pluginChecks, runChecks } from "@capybara-hq/plugin-tools";
import { CHECKS } from "../registry.js";
import { corePluginScope, requireScanTargets } from "./dirs.js";
import { root } from "./report.js";
import { RUNNERS } from "./runners.js";

requireScanTargets();

const checks: NamedCheck[] = [
  // The plugin-scoped checks are @capybara-hq/plugin-tools' (`capybara-plugin check`), on core's scope.
  ...pluginChecks(corePluginScope()),
  // The rest is the registry's (`../registry.ts`): every entry run by `pnpm check` without a plugin check.
  ...CHECKS.filter((c) => c.inAll && c.plugin === undefined).map((c) => {
    const runner = RUNNERS[c.name];
    if (runner === undefined)
      throw new Error(`check ${c.name} is in the registry but has no runner`);
    return runner;
  }),
];

const failed = await runChecks(checks, root);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
