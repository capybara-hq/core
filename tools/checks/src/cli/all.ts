import { join } from "node:path";
import { type NamedCheck, pluginChecks, runChecks } from "@capybara-hq/plugin-tools";
import { checkAgentDocs } from "../agent-docs.js";
import { BOOTSTRAP_COMPOSE_FILES, checkBootstrap } from "../bootstrap.js";
import { checkComposeHaproxy } from "../compose-haproxy.js";
import { checkConfigDocs } from "../config-docs.js";
import { checkDesignI18n, checkI18n } from "../i18n.js";
import { checkKernelConventions } from "../kernel-conventions.js";
import { checkPackageSchemas } from "../package-schemas.js";
import { checkPlatformOps } from "../platform-ops.js";
import { checkPluginClientApi, checkPluginClientApiReport } from "../plugin-client-api.js";
import { checkReleaseMetadata } from "../release-metadata.js";
import { checkSdkApi } from "../sdk-api.js";
import { checkSkillsFrontmatter } from "../skills-frontmatter.js";
import { checkSyncedSkills } from "../synced-skills.js";
import { checkTerms } from "../terms.js";
import { checkTestPlugins } from "../test-plugins.js";
import { checkTokens } from "../tokens.js";
import { checkUiParts } from "../ui-parts.js";
import { checkUiSlots } from "../ui-slots.js";
import { checkWebUi } from "../web-ui.js";
import { corePluginScope, requireScanTargets } from "./dirs.js";
import { root } from "./report.js";

requireScanTargets();

const checks: NamedCheck[] = [
  // The plugin-scoped checks are @capybara-hq/plugin-tools' (`capybara-plugin check`), on core's scope.
  ...pluginChecks(corePluginScope()),
  { name: "Config docs", run: () => checkConfigDocs() },
  { name: "Package JSON Schema", run: () => checkPackageSchemas() },
  {
    name: "Bootstrap manifest",
    run: () =>
      checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root, {
        composeFiles: BOOTSTRAP_COMPOSE_FILES.map((f) => join(root, f)),
      }),
  },
  {
    name: "UI copy",
    run: () => [
      ...checkI18n(join(root, "apps/web/messages")),
      ...checkDesignI18n(join(root, "packages/design/src/i18n.ts")),
    ],
  },
  { name: "Design tokens", run: () => checkTokens(root) },
  { name: "UI slots", run: () => checkUiSlots(root) },
  { name: "UI parts", run: () => checkUiParts(root) },
  {
    name: "Web UI rules",
    run: () => checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")),
  },
  { name: "Test plugins", run: () => checkTestPlugins(root) },
  { name: "Synced skills", run: () => checkSyncedSkills(root) },
  { name: "Skills frontmatter", run: () => checkSkillsFrontmatter(join(root, ".agents/skills")) },
  { name: "release metadata", run: () => checkReleaseMetadata(root) },
  { name: "SDK API snapshot", run: () => checkSdkApi({ update: false }) },
  {
    name: "plugin-client API",
    run: async () => [
      ...checkPluginClientApi(root),
      ...(await checkPluginClientApiReport({ update: false })),
    ],
  },
  { name: "Agent docs", run: () => checkAgentDocs(root) },
  { name: "Terms", run: () => checkTerms(root) },
  { name: "Kernel conventions", run: () => checkKernelConventions(root) },
  { name: "Platform operations", run: () => checkPlatformOps(root) },
  {
    name: "compose haproxy",
    run: () =>
      checkComposeHaproxy(
        join(root, "docker/compose.yaml"),
        join(root, "docker/sandbox-proxy/haproxy.cfg"),
      ),
  },
];

const failed = await runChecks(checks, root);
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
