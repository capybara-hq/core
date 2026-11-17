import { join } from "node:path";
import type { NamedCheck } from "@capybara-hq/plugin-tools";
import { checkAgentDocs } from "../agent-docs.js";
import { BOOTSTRAP_COMPOSE_FILES, checkBootstrap } from "../bootstrap.js";
import { checkComposeHaproxy } from "../compose-haproxy.js";
import { checkConfigDocs } from "../config-docs.js";
import { checkSdkComments } from "../english-comments.js";
import { checkDesignI18n, checkI18n } from "../i18n.js";
import { checkKernelConventions } from "../kernel-conventions.js";
import { checkOutboxRegistry } from "../outbox-registry.js";
import { checkPackageSchemas } from "../package-schemas.js";
import { checkPlatformOps } from "../platform-ops.js";
import { checkPluginClientApi, checkPluginClientApiReport } from "../plugin-client-api.js";
import { checkReleaseMetadata } from "../release-metadata.js";
import { checkSdkApi } from "../sdk-api.js";
import { checkSkillsFrontmatter } from "../skills-frontmatter.js";
import { checkSyncedSkills } from "../synced-skills.js";
import { checkTerms } from "../terms.js";
import { checkTestPlugins } from "../test-plugins.js";
import { checkTestPortfolio } from "../test-portfolio.js";
import { checkTokens } from "../tokens.js";
import { checkUiParts } from "../ui-parts.js";
import { checkUiSlots } from "../ui-slots.js";
import { checkWebUi } from "../web-ui.js";
import { root } from "./report.js";

/**
 * The in-process half of `pnpm check`, keyed by registry name ({@link CHECKS} in `../registry.ts`):
 * every entry with `inAll` and no `plugin` has exactly one runner here (`registry.test.ts`).
 */
export const RUNNERS: Record<string, NamedCheck> = {
  "config-docs": { name: "Config docs", run: () => checkConfigDocs() },
  "package-schemas": { name: "Package JSON Schema", run: () => checkPackageSchemas() },
  bootstrap: {
    name: "Bootstrap manifest",
    run: () =>
      checkBootstrap(join(root, "packages/kernel/bootstrap.json"), root, {
        composeFiles: BOOTSTRAP_COMPOSE_FILES.map((f) => join(root, f)),
      }),
  },
  i18n: {
    name: "UI copy",
    run: () => [
      ...checkI18n(join(root, "apps/web/messages")),
      ...checkDesignI18n(join(root, "packages/design/src/i18n.ts")),
    ],
  },
  "english-comments": { name: "English comments", run: () => checkSdkComments(root) },
  tokens: { name: "Design tokens", run: () => checkTokens(root) },
  "ui-slots": { name: "UI slots", run: () => checkUiSlots(root) },
  "ui-parts": { name: "UI parts", run: () => checkUiParts(root) },
  "web-ui": {
    name: "Web UI rules",
    run: () => checkWebUi(join(root, "apps/web/src"), join(root, "packages/design/src")),
  },
  "test-plugins": { name: "Test plugins", run: () => checkTestPlugins(root) },
  "test-portfolio": { name: "Test portfolio", run: () => checkTestPortfolio({ root }) },
  "synced-skills": { name: "Synced skills", run: () => checkSyncedSkills(root) },
  "skills-frontmatter": {
    name: "Skills frontmatter",
    run: () => checkSkillsFrontmatter(join(root, ".agents/skills")),
  },
  "release-metadata": { name: "release metadata", run: () => checkReleaseMetadata(root) },
  "sdk-api": { name: "SDK API snapshot", run: () => checkSdkApi({ update: false }) },
  "plugin-client-api": {
    name: "plugin-client API",
    run: async () => [
      ...checkPluginClientApi(root),
      ...(await checkPluginClientApiReport({ update: false })),
    ],
  },
  "agent-docs": { name: "Agent docs", run: () => checkAgentDocs(root) },
  terms: { name: "Terms", run: () => checkTerms(root) },
  "kernel-conventions": { name: "Kernel conventions", run: () => checkKernelConventions(root) },
  "outbox-registry": { name: "Outbox registry", run: () => checkOutboxRegistry(root) },
  "platform-ops": { name: "Platform operations", run: () => checkPlatformOps(root) },
  "compose-haproxy": {
    name: "compose haproxy",
    run: () =>
      checkComposeHaproxy(
        join(root, "docker/compose.yaml"),
        join(root, "docker/sandbox-proxy/haproxy.cfg"),
      ),
  },
};
