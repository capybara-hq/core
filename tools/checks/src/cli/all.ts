import { join, relative } from "node:path";
import { checkBootstrap } from "../bootstrap.js";
import { checkComposeHaproxy, checkHaproxyCopy, PLUGIN_HAPROXY_COPY } from "../compose-haproxy.js";
import { checkConfigDocs } from "../config-docs.js";
import { checkDeps } from "../deps.js";
import { checkI18n } from "../i18n.js";
import { checkMigrations } from "../migrations.js";
import { checkPackageSchemas } from "../package-schemas.js";
import { checkPluginPack } from "../plugin-pack.js";
import { checkPluginPermissions } from "../plugin-permissions.js";
import { checkPluginState } from "../plugin-state.js";
import { checkReleaseMetadata } from "../release-metadata.js";
import { checkSdkApi } from "../sdk-api.js";
import { checkSkillsFrontmatter } from "../skills-frontmatter.js";
import type { Finding } from "../source.js";
import { checkSyncedSkills } from "../synced-skills.js";
import { checkTerms } from "../terms.js";
import { checkTestPlugins } from "../test-plugins.js";
import { checkToolDesign } from "../tool-design.js";
import { checkWebUi } from "../web-ui.js";
import { extensionDirs, migrationDirs, requireScanTargets, toolDesignDirs } from "./dirs.js";
import { root } from "./report.js";

requireScanTargets();

const checks: { name: string; run: () => Finding[] | Promise<Finding[]> }[] = [
  { name: "Migrations", run: () => checkMigrations(migrationDirs()) },
  {
    name: "Dependency boundary",
    run: () => checkDeps(extensionDirs(), [join(root, "packages/plugin-sdk")]),
  },
  { name: "Extension state", run: () => checkPluginState(extensionDirs()) },
  { name: "Extension permissions", run: () => checkPluginPermissions(extensionDirs()) },
  { name: "Plugin pack", run: () => checkPluginPack(extensionDirs()) },
  { name: "Tool design", run: () => checkToolDesign(toolDesignDirs(extensionDirs())) },
  { name: "Config docs", run: () => checkConfigDocs() },
  { name: "Package JSON Schema", run: () => checkPackageSchemas() },
  {
    name: "Bootstrap manifest",
    run: () => checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root),
  },
  { name: "UI copy", run: () => checkI18n(join(root, "apps/web/messages")) },
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
    run: () => [
      ...checkComposeHaproxy(
        join(root, "docker/compose.yaml"),
        join(root, "docker/sandbox-proxy/haproxy.cfg"),
      ),
      ...checkHaproxyCopy(
        join(root, "docker/sandbox-proxy/haproxy.cfg"),
        join(root, PLUGIN_HAPROXY_COPY),
      ),
    ],
  },
];

let failed = 0;
for (const c of checks) {
  let findings: Finding[];
  try {
    findings = await c.run();
  } catch (e) {
    console.error(
      `[${c.name}] check crashed: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
    );
    failed++;
    continue;
  }
  if (findings.length === 0) {
    console.log(`[${c.name}] passed`);
    continue;
  }
  failed++;
  console.error(`[${c.name}] ${findings.length} finding(s)`);
  for (const f of findings)
    console.error(`  ${relative(root, f.file)}:${f.line} ${f.rule} ${f.message}`);
}
if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nAll checks passed");
