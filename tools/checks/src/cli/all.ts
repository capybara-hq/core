import { join } from "node:path";
import { type NamedCheck, pluginChecks, runChecks } from "@capybara-hq/plugin-tools";
import { BOOTSTRAP_COMPOSE_FILES, checkBootstrap } from "../bootstrap.js";
import { checkComposeHaproxy } from "../compose-haproxy.js";
import { checkConfigDocs } from "../config-docs.js";
import { checkI18n } from "../i18n.js";
import { checkPackageSchemas } from "../package-schemas.js";
import { checkReleaseMetadata } from "../release-metadata.js";
import { checkSdkApi } from "../sdk-api.js";
import { checkSkillsFrontmatter } from "../skills-frontmatter.js";
import { checkSyncedSkills } from "../synced-skills.js";
import { checkTerms } from "../terms.js";
import { checkTestPlugins } from "../test-plugins.js";
import { checkTokens } from "../tokens.js";
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
  { name: "UI copy", run: () => checkI18n(join(root, "apps/web/messages")) },
  { name: "Design tokens", run: () => checkTokens(root) },
  {
    name: "Web UI rules",
    run: () => checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")),
  },
  { name: "Test plugins", run: () => checkTestPlugins(root) },
  { name: "Synced skills", run: () => checkSyncedSkills(root) },
  { name: "Skills frontmatter", run: () => checkSkillsFrontmatter(join(root, ".agents/skills")) },
  { name: "release metadata", run: () => checkReleaseMetadata(root) },
  { name: "SDK API snapshot", run: () => checkSdkApi({ update: false }) },
  { name: "Terms", run: () => checkTerms(root) },
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
