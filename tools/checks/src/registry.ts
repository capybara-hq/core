/**
 * The one registry of custom checks. Adding a check is one entry here (plus its `check:<name>`
 * script in the root package.json, its `src/cli/<cli>.ts` and a README entry); `registry.test.ts`
 * fails when the registry, the package.json scripts, the CLI files or the README disagree, and
 * `src/cli/all.ts` (`pnpm check`) iterates it.
 */
export interface CheckEntry {
  /** The script is `check:<name>`. */
  name: string;
  /** The CLI file under `src/cli/` (without `.ts`) the script runs. */
  cli: string;
  /**
   * Whether CI runs the check on every PR ("full") or only when the diff touches its area
   * ("diff"). A "full" check may still inspect just the diff (`takesBase`). On `main` everything
   * runs. The README entry names the same word first in its parentheses.
   */
  ciMode: "full" | "diff";
  /** The check takes `--base <sha>` and inspects the diff against it (its own PR-only CI step). */
  takesBase?: boolean;
  /** Why that mode (one sentence). */
  reason: string;
  /** What the check enforces (one sentence; the README entry has the rules). */
  description: string;
  /** Run by `pnpm check`. */
  inAll: boolean;
  /** Set when the check is a `pluginChecks` check of plugin-tools: its name there. */
  plugin?: string;
}

const CHEAP = "cheap: part of `pnpm check`, which runs in full on every PR";

export const CHECKS: readonly CheckEntry[] = [
  {
    name: "migrations",
    cli: "migrations",
    ciMode: "full",
    reason: CHEAP,
    description: "Migration files are well-formed, numbered without duplicates and idempotent.",
    inAll: true,
    plugin: "Migrations",
  },
  {
    name: "deps",
    cli: "deps",
    ciMode: "full",
    reason: CHEAP,
    description: "Plugins and the device import only what the dependency direction allows.",
    inAll: true,
    plugin: "Dependency boundary",
  },
  {
    name: "extension-state",
    cli: "plugin-state",
    ciMode: "full",
    reason: CHEAP,
    description: "Extensions keep no timers or in-process shared state.",
    inAll: true,
    plugin: "Extension state",
  },
  {
    name: "extension-permissions",
    cli: "plugin-permissions",
    ciMode: "full",
    reason: CHEAP,
    description: "Every ctx use of an extension is covered by its permission manifest.",
    inAll: true,
    plugin: "Extension permissions",
  },
  {
    name: "tool-design",
    cli: "tool-design",
    ciMode: "full",
    reason: CHEAP,
    description: "Tool keys, English descriptions and error messages follow the tool design rules.",
    inAll: true,
    plugin: "Tool design",
  },
  {
    name: "plugin-pack",
    cli: "plugin-pack",
    ciMode: "full",
    reason: CHEAP,
    description: "Every plugin packs into a valid tgz with its manifest and client files.",
    inAll: true,
    plugin: "Plugin pack",
  },
  {
    name: "config-forms",
    cli: "config-forms",
    ciMode: "full",
    reason: CHEAP,
    description: "Plugin config schemas render as forms with UI hints and labels.",
    inAll: true,
    plugin: "Config forms",
  },
  {
    name: "config-docs",
    cli: "config-docs",
    ciMode: "full",
    reason: CHEAP,
    description:
      "docs/config.md equals what `pnpm gen:config-docs` renders from the kernel config schema.",
    inAll: true,
  },
  {
    name: "package-schemas",
    cli: "package-schemas",
    ciMode: "full",
    reason: CHEAP,
    description: "The published JSON Schemas equal what `pnpm gen:package-schemas` renders.",
    inAll: true,
  },
  {
    name: "bootstrap",
    cli: "bootstrap",
    ciMode: "full",
    reason: `${CHEAP}; its network half (\`--network\`) has its own CI step that runs by diff`,
    description: "bootstrap.json is valid, pinned and consistent with the compose files.",
    inAll: true,
  },
  {
    name: "i18n",
    cli: "i18n",
    ciMode: "full",
    reason: CHEAP,
    description: "Web and design messages are complete in zh and en and follow the term rules.",
    inAll: true,
  },
  {
    name: "tokens",
    cli: "tokens",
    ciMode: "full",
    reason: CHEAP,
    description: "Generated design tokens are current and meet contrast and separation floors.",
    inAll: true,
  },
  {
    name: "ui-slots",
    cli: "ui-slots",
    ciMode: "full",
    reason: CHEAP,
    description: "The UI slot catalog, its generated files and the ExtensionSlot renders agree.",
    inAll: true,
  },
  {
    name: "ui-parts",
    cli: "ui-parts",
    ciMode: "full",
    reason: CHEAP,
    description: "The UI part catalog, its generated files and the data-cap-part literals agree.",
    inAll: true,
  },
  {
    name: "web-ui",
    cli: "web-ui",
    ciMode: "full",
    reason: CHEAP,
    description: "apps/web and the design package follow the web UI rules.",
    inAll: true,
  },
  {
    name: "plugin-client-api",
    cli: "plugin-client-api",
    ciMode: "full",
    reason: CHEAP,
    description: "plugin-client's API matches its report and the web implementation.",
    inAll: true,
  },
  {
    name: "test-plugins",
    cli: "test-plugins",
    ciMode: "full",
    reason: CHEAP,
    description: "Tests load no official plugin except the listed ones.",
    inAll: true,
  },
  {
    name: "test-portfolio",
    cli: "test-portfolio",
    ciMode: "full",
    reason:
      "part of `pnpm check` over the whole kernel test tree (2-3 s); `--base` also scans by diff",
    description:
      "The kernel test suite stops regrowing fixed sleeps, timeouts and small app files.",
    inAll: true,
  },
  {
    name: "synced-skills",
    cli: "synced-skills",
    ciMode: "full",
    reason: CHEAP,
    description: "Synced skills match the versions and hashes recorded from capybara-hq/.github.",
    inAll: true,
  },
  {
    name: "skills-frontmatter",
    cli: "skills-frontmatter",
    ciMode: "full",
    reason: CHEAP,
    description: "Skill frontmatter is valid YAML, within limits and parses at runtime.",
    inAll: true,
  },
  {
    name: "compose-haproxy",
    cli: "compose-haproxy",
    ciMode: "full",
    reason: CHEAP,
    description: "The compose sandbox profile and the haproxy config agree.",
    inAll: true,
  },
  {
    name: "release-metadata",
    cli: "release-metadata",
    ciMode: "full",
    reason: CHEAP,
    description: "Published packages carry the metadata npm provenance needs.",
    inAll: true,
  },
  {
    name: "agent-docs",
    cli: "agent-docs",
    ciMode: "full",
    reason: CHEAP,
    description: "The agent docs topics match their generated copies.",
    inAll: true,
  },
  {
    name: "terms",
    cli: "terms",
    ciMode: "full",
    reason: CHEAP,
    description: "Tracked text uses the project terms (platform, super admin, ...).",
    inAll: true,
  },
  {
    name: "platform-ops",
    cli: "platform-ops",
    ciMode: "full",
    reason: CHEAP,
    description: "Every kernel route has a Platform operation or a reasoned exclusion.",
    inAll: true,
  },
  {
    name: "kernel-conventions",
    cli: "kernel-conventions",
    ciMode: "full",
    reason: CHEAP,
    description:
      "Kernel code follows the Nest conventions (explicit @Inject, config service, DTOs).",
    inAll: true,
  },
  {
    name: "outbox-registry",
    cli: "outbox-registry",
    ciMode: "full",
    reason: CHEAP,
    description: "Every outbox kind has a registered processor.",
    inAll: true,
  },
  {
    name: "sdk-api",
    cli: "sdk-api",
    ciMode: "full",
    reason: CHEAP,
    description: "The plugin-sdk public API equals its committed report.",
    inAll: true,
  },
  {
    name: "sdk-api-changeset",
    cli: "sdk-api-changeset",
    ciMode: "full",
    takesBase: true,
    reason:
      "runs on every PR as a cheap diff inspection against a base (`--base`); own PR-only CI step, skipped on main",
    description: "A change to the SDK API report carries a changeset bumping plugin-sdk.",
    inAll: false,
  },
  {
    name: "applied-migrations",
    cli: "applied-migrations",
    ciMode: "full",
    takesBase: true,
    reason:
      "runs on every PR as a cheap diff inspection against a base (`--base`); own PR-only CI step, skipped on main",
    description: "Applied migrations are immutable and new ones are numbered above the base.",
    inAll: false,
  },
];
