# Package Ecosystem Phase B: Claude Code Plugin Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An enterprise admin adds `obra/superpowers` as a git marketplace, imports superpowers through the one review (with a five-group translation report and "suggest pinned" checkboxes), an org installs it, an agent pins `using-superpowers`, the model loads `brainstorming` (also as `superpowers:brainstorming`) when asked for a feature, and replaying that conversation reproduces its requests exactly.

**Architecture:** A pure Claude reader in `packages/kernel/src/catalog/claude/` turns a Claude plugin tree (and a `.claude-plugin/marketplace.json`) into the normal Capybara inputs: a virtual plugin tree with a synthesized `plugin.json`, generated connector templates for remote MCP servers, and an allowlist translation report. The existing git paths (`fetchGit`, `prepareGit`) call it, so the review, `reviewHash`, materialization and org install are the A1 flow. The runtime adds three things to the `skills_catalog` snapshot event: the source plugin per skill (`plugin`, for `skill_load` qualified names), pinned skill bodies (`pinned`) and an English tool-name map (`toolMap`); `build.ts` renders them in the system cache segment, as mid-conversation reminders and after compaction, all from the log.

**Tech Stack:** TypeScript, Kysely + PG migrations, NestJS kernel, zod, `yaml` (via the SDK's `parseSkillMd`), isomorphic-git reader (A1), vitest, `@capybara-hq/testing` (`startFakeGitServer`, kernel helpers), `model-fake`, Next.js + `@capybara-hq/design`, next-intl (zh, en).

**Spec:** `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` §8 (translation), §9 (pinned skills, provenance, qualified names, tool-name map), §4.1 (both manifests, paths), §4.3 (review), §5.1–§5.3 (git marketplaces, sources, versions), §12 Phase B acceptance, Appendix A, and the "Phase A1 / A2 / A3a as built" sections. Read with it: `.agents/skills/writing-plugins`, `replay-evals`, `writing-tools` (skill tools), `writing-web-ui`, `writing-migrations`.

## Header notes

### Base and ordering

- Planned against `origin/main` at `4a40e93` (A3a merged: fakes in `packages/testing/fixtures/extensions`, plugin tests in `plugins/*/test`, `@capybara-hq/plugin-tools`). Spec §12 puts phase B after the first release, i.e. after A3b moves the official plugins to `capybara-hq/plugins`. Every core test in this plan therefore uses only `model-fake`, the fakes and fixtures (rule `test-plugins-official`). The one test that needs the real `connector-mcp` (Task 11) lives in `plugins/connector-mcp/test/` and uses only `@capybara-hq/testing`, so it moves with A3b unchanged. If A3b lands first, that test is written in the plugins repository instead.
- A3a rewrote the catalog tests (`plugin-import`, `git-marketplaces`, `marketplaces`, `plugin-install`, `plugin-upgrade`, `m6-segment3.dual`) and `reconstruct.test.ts`. This plan adds new test files where it can (`claude-*.test.ts`) and only appends cases to `reconstruct.test.ts`, `skills-runtime.test.ts` and `plugin-import.test.ts`.
- Migrations start at `0051` (A3a added none).

### Appendix A re-check (2026-10-26) and what differs

`code.claude.com` could not be reached from the planning environment (DNS refused it; WebFetch and curl both failed). The re-check below is from the Claude Code `CHANGELOG.md` at `anthropics/claude-code@2eff7a8` (2.1.310), real marketplaces in a Claude Code install (`claude-plugins-official`: 315 entries; `superpowers-marketplace`), and `obra/superpowers@2ce8aa15` (7.0.1). **Task 2 Step 0 re-reads the two docs pages (plugins reference, plugin marketplaces) before writing the parser and records any further difference in the spec's "Phase B as built"**, and checks the fixtures with `claude plugin validate` where a Claude Code CLI is available.

1. **Marketplace `source` objects use a `source` discriminator**: `{ "source": "github", "repo", "ref"?, "sha"? }`, `{ "source": "url", "url", "ref"?, "sha"? }`, `{ "source": "git-subdir", "url", "path", "ref"?, "sha"? }`, `{ "source": "npm", "package", "version"?, "registry"? }`; a string is a relative path (`"./"` is the repository root). Counts in the official marketplace: `url` 164, `git-subdir` 98, path 53. No `archive` or `command` source was seen; Appendix A lists them, so the parser keeps `archive` (`url` + `sha256`) and reports `command` as unsupported.
2. **Marketplace top-level keys** beyond Appendix A: `$schema`, `description`, `metadata` (`metadata.pluginRoot` is the base of relative sources in the docs as remembered; unverified, Task 2 Step 0), `renames` (official marketplace). Entry keys seen: `name`, `description`, `source`, `category`, `homepage`, `author`, `displayName`, `strict`, `version`, `lspServers`, `skills`, `tags`, `keywords`.
3. **`.mcp.json` has two shapes**: `{ "mcpServers": { … } }` and a flat map of servers (the official `github`, `gitlab`, `linear` plugins). Seen: `{ "type": "http", "url", "headers": { "Authorization": "Bearer ${GITHUB_PERSONAL_ACCESS_TOKEN}" } }`, `{ "type": "http", "url" }` (OAuth-on-401 servers such as Linear), stdio `{ "command", "args" }` with `${VAR}` in args.
4. **`plugin.json` fields seen**: `name`, `description`, `author { name, email }`, `version`, `keywords`, `homepage`, `license`, `repository` (a string), `userConfig` (typed options). New since 2026-10-22 (CHANGELOG): **mods** (a JS hooks module with a `$` API, a `types` key, `claude plugin test`), plugin **monitors**, **themes**, `claude plugin eval`. All are "not applicable" (§8.3).
5. **Dependencies**: Claude installs plugin dependencies only from registry packages and refuses npm sources that are git repositories or folders (2.1.29x). The `dependencies` shape is not confirmed; the reader accepts `"name"`, `"name@range"` and `{ "name", "version" }` and reports anything else as ignored.
6. **Names**: Claude refuses skill and command names with `<`, `>` or hidden characters; Capybara's rules are stricter already. Skill namespaces are still `<plugin>:<name>`.
7. **superpowers 7.0.1 has no `commands/` or `agents/`** (they existed when Appendix A was written). It has 15 skills, `hooks/hooks.json` with one `SessionStart` command hook (matcher `startup|clear|compact`) whose script injects `using-superpowers`, `.claude-plugin/marketplace.json` listing itself with `"source": "./"`, `.claude-plugin/plugin.json` (version 7.0.1, license MIT), a `package.json` without a `capybara` section (so not legacy), manifests for other harnesses (`.codex-plugin/`, `.cursor-plugin/`, …) and per-platform tool maps in `skills/using-superpowers/references/*-tools.md`. Skill bodies use XML-like tags (`<SUBAGENT-STOP>`, `<EXTREMELY-IMPORTANT>`); only descriptions are checked for tags, so they import. The §12 acceptance item "the report lists hooks, commands" is met by the fixture's added `commands/brainstorm.md` (as superpowers 5.x shipped it), documented in the fixture's `FIXTURE.md`.
8. `obra/superpowers-marketplace` lists superpowers as `{ "source": "url", … }` with `version: "5.0.7"`, `strict: true`, older than the plugin's own `7.0.1`; the version order (manifest first, §5.3) records 7.0.1.

## Global Constraints

- **Allowlist translation**: only what the tables of §8.2 / §8.3 list is translated; every other file, field or component becomes a report item with a reason; unknown fields never fail an import. **Skill files are never modified** (bytes stored as read; paths may only move, for a root `SKILL.md`).
- **A Claude plugin has no extension** and needs no permission approval; `review.extension` is absent and `deployExtension` is a no-op for it.
- The translation report is part of the **one review** (prepare → `GET imports/:stagingId` → confirm) and is covered by `reviewHash`.
- **The event log is the single source of truth**: pinned bodies and the tool-name map are written into the `skills_catalog` event; request building reads nothing else. Run the zero-drift tests before and after Tasks 7 and 8: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`.
- **A log written before phase B renders byte for byte as before** (no `plugin` / `pinned` / `toolMap` fields means none) and gets no new snapshot or reminder when nothing changed.
- Pinned limits (§9.1): at most **3** pinned skills per agent, SKILL.md bytes of the current versions totalling **≤ 32768**; `skills.pinned` has no default (definitions without it gain no version).
- Model-visible text is English and fixed by this plan (Task 8); UI text goes through i18n (zh and en); `apps/web` uses only `@capybara-hq/design` (`pnpm check:web-ui`).
- Tests never use the network; git content comes from `startFakeGitServer` and checked-in fixtures; the optional live test runs only with `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1`.
- Migration `0051_claude_compat.sql`: additive, idempotent (`ADD COLUMN IF NOT EXISTS`), nullable or defaulted columns only (post-release zero-downtime rules).
- SDK public API change → `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`. One changeset `.changeset/ecosystem-phase-b.md` (patch: `@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`, `@capybara-hq/capybara`; `@capybara-hq/web` follows the fixed group), created in Task 1 and extended by later tasks.
- New error codes in `packages/kernel/src/errors.ts` with zh and en copy in `apps/web/messages/*.json`. English comments; Conventional Commits, body ≤ 100 characters per line, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run vitest from the repo root.
- Fixture JSON under `packages/kernel/test/` is linted by biome: keep it 2-space formatted; do not check in `.js` / `.cjs` scripts from superpowers (use the `.sh` and `.md` files only).

## Formats (decided here)

### Translation report (kernel type, `catalog/claude/report.ts`; mirrored in `apps/web/src/lib/catalog.ts`)

```ts
export type TranslationGroup = "imported" | "converted" | "needsInput" | "ignored" | "warnings";
export type TranslationComponent =
  | "plugin" | "skill" | "command" | "agent" | "hook" | "mcpServer" | "field" | "file";
export type TranslationCode =
  // imported
  | "skill_imported"
  // converted
  | "mcp_template" | "skill_root_relocated" | "version_from_entry" | "version_fallback"
  | "publisher_from_marketplace" | "dependency_mapped" | "entry_components_merged"
  // needsInput
  | "mcp_header_variable" | "mcp_url_variable" | "dependency_not_imported"
  // ignored
  | "skill_manual_invocation" | "command_manual_invocation" | "skill_needs_subagents"
  | "agent_needs_subagents" | "hooks_not_run" | "hooks_module" | "mcp_unsupported_transport"
  | "mcp_invalid" | "skill_invalid" | "not_applicable" | "unknown_field" | "other_harness"
  // warnings
  | "skill_ignored_restrictions" | "skill_claude_variables" | "session_start_pin_hint"
  | "mcp_auth_none" | "mcp_type_assumed" | "connector_not_loaded";
export interface TranslationItem {
  group: TranslationGroup;
  component: TranslationComponent;
  /** Skill / server / hook event / field name. */
  name: string;
  /** Path relative to the plugin root, when the item is a file or directory. */
  path?: string;
  code: TranslationCode;
  /** Values for the localized message (e.g. { keys: "allowed-tools, model" }, { transport: "sse" }). */
  detail?: Record<string, string | number>;
}
export interface TranslationReport {
  format: "claude-code";
  /** `.claude-plugin/plugin.json`, or null when the tree has none. */
  manifestPath: string | null;
  /** The plugin has a SessionStart hook: the pinned suggestion is expanded by default (§8.4). */
  sessionStart: boolean;
  /** Items sorted by group order above, then component, then name. At most 500 (then one "unknown_field" item named "…" with detail { more: n }). */
  items: TranslationItem[];
}
```

### Claude marketplace entry overlay (stored per entry, `marketplace_entries.claude`)

```ts
export interface ClaudeEntryOverlay {
  /** Default true (Claude's rule). */
  strict: boolean;
  /** Component fields of the entry (`skills`, `commands`, `agents`, `hooks`, `mcpServers`, `lspServers`, `outputStyles`, …), raw JSON. */
  components: Record<string, unknown>;
  /** `author.name` of the entry, else of the marketplace `owner.name`. */
  publisher?: string;
}
```

### Snapshot event additions (`skills_catalog`, `conversations/events.ts`)

```ts
skills: [{ id, name, description, version, source, plugin?: string /* catalog item name, ≤ 64 */ }],
pinned?: { id: string; version: number; name: string; source: string; body: string /* ≤ 32768 chars */ }[], // ≤ 3, agent's order
toolMap?: string, // ≤ 4000 chars; present iff a skill in `skills` has source format claude-code
```

### Database (`0051_claude_compat.sql`)

- `catalog_item_versions.source_format text NOT NULL DEFAULT 'capybara'` (`CHECK (source_format IN ('capybara','claude-code'))`), `translation jsonb NULL` (the report), `license_text text NULL` (≤ 64 KiB, any plugin).
- `skill_versions.source_format text NOT NULL DEFAULT 'capybara'` (same check), `suggest_pinned boolean NOT NULL DEFAULT false`.
- `marketplace_entries.claude jsonb NULL` (`ClaudeEntryOverlay`); `marketplaces.skipped jsonb NOT NULL DEFAULT '[]'` (`{ name, reason }[]` of entries a refresh could not store: `claude_npm_unpinned`, `claude_source_unsupported`, `invalid_name`, `invalid_entry`).

## Review Focus

1. **Conversations recorded before phase B**: after the upgrade, a run on a conversation whose latest snapshot has no `plugin` / `pinned` / `toolMap` and whose skills did not change writes no new `skills_catalog` and no reminder, and its old requests reconstruct with zero drift. Task 7 tests it ("an old snapshot stays: no new event").
2. **A pinned skill disappears mid-conversation** (deleted, deselected from `orgSkills`, its plugin uninstalled, or the definition still names a deleted id): the next run writes a snapshot without it, the model gets the "no longer pinned" reminder, nothing fails, and saving the agent with a stale pinned id still works. Task 7 and Task 6 test it.
3. **Hostile or malformed Claude input** (`plugin.json` with wrong types such as `"skills": 5` or `"hooks": "../../x"`, a path leaving the root, non-JSON `.mcp.json`, 1000 hook handlers, 200 MCP servers, a skill name with uppercase): the reader never throws on it; each problem is a report item, paths outside the root are refused by name, counts are capped. Task 2 tests it.
4. **A pinned skill's new version pushes the total past 32 KB** (the agent was saved under the limit): the run keeps pinned skills in the agent's order while they fit, drops the rest, logs a warning, and the agent page shows the set as over the limit. Task 7 and Task 10 test it.
5. **Re-importing a Claude plugin after the repository moved**: the content digest is computed over the files as read (never the generated tree), so an unchanged repo is "already imported" and a moved one is "content changed at the same version" with `+git.<sha12>`, independent of translator changes. Task 4 tests it.

---

### Task 1: SDK: SKILL.md frontmatter for the reader

**Files:**
- Modify: `packages/plugin-sdk/src/skill.ts` (`ParsedSkillMd`), `packages/plugin-sdk/src/plugin-manifest.ts` (doc comment of `PluginSkillRef.pinned`: "suggested as pinned when an agent selects the skill")
- Modify: `packages/plugin-sdk/api/plugin-sdk.api.md` (regenerated)
- Create: `.changeset/ecosystem-phase-b.md`
- Test: `packages/plugin-sdk/test/skill.test.ts`

**Interfaces:**
- Produces: `ParsedSkillMd.frontmatter: Readonly<Record<string, unknown>>` (the parsed YAML mapping, every key, unchanged values). No other SDK change in this plan.

- [ ] **Step 1: Write the failing test** `parseSkillMd returns the whole frontmatter`: for a SKILL.md with `name`, `description`, `disable-model-invocation: true`, `context: fork`, `allowed-tools: [Bash, Read]`, `model: opus`, assert `r.frontmatter` deep-equals those six keys and `r.name` / `r.description` / `r.body` are unchanged; a file with errors still returns `{ errors }` only.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/skill.test.ts`. Expected: FAIL (`frontmatter` undefined).
- [ ] **Step 3: Implement** in `parseSkillMd` (return `frontmatter: fm`).
- [ ] **Step 4: Run** the test (PASS), `pnpm gen:sdk-api`, `pnpm check:sdk-api`, `pnpm typecheck`.
- [ ] **Step 5: Write the changeset** (frontmatter: plugin-sdk, kernel, capybara: patch) with one paragraph: "Claude Code plugins import from git marketplaces with a translation report; agents can pin skills; `skill_load` accepts `<plugin>:<name>`." Later tasks append sentences.
- [ ] **Step 6: Commit** `feat(plugin-sdk): expose SKILL.md frontmatter from parseSkillMd`.

### Task 2: The Claude plugin reader (pure) and its fixtures

**Files:**
- Create: `packages/kernel/src/catalog/claude/report.ts` (types above, `sortItems`, `CLAUDE_REPORT_MAX_ITEMS = 500`)
- Create: `packages/kernel/src/catalog/claude/manifest.ts` (Claude `plugin.json`: lenient read, fields of §8.2)
- Create: `packages/kernel/src/catalog/claude/mcp.ts` (servers → connector template files)
- Create: `packages/kernel/src/catalog/claude/translate.ts` (the whole tree)
- Create fixtures: `packages/kernel/test/catalog/fixtures/claude/superpowers/` (from `obra/superpowers@2ce8aa15`: `LICENSE` verbatim (MIT), `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `hooks/hooks.json`, `hooks/session-start`, `package.json`, `.codex-plugin/plugin.json`, `skills/using-superpowers/SKILL.md` and `references/claude-code-tools.md`, `skills/brainstorming/SKILL.md` and `visual-companion.md`, `skills/test-driven-development/SKILL.md`, `skills/writing-plans/SKILL.md` verbatim; plus `commands/brainstorm.md` and `agents/code-reviewer.md` as superpowers 5.x shipped them; `FIXTURE.md` naming the commit, the files kept, the two additions and the license)
- Create fixtures: `packages/kernel/test/catalog/fixtures/claude/mixed/` (synthetic: `.mcp.json` flat map with an http server using `Authorization: Bearer ${API_TOKEN}`, an http server with `X-Api-Key: ${KEY}`, an http server without auth, one with `oauth: {}`, one with `${HOST}` in `url`, one `sse`, one `ws`, one stdio; `plugin.json` with `mcpServers` inline, `lspServers`, `outputStyles`, `userConfig`, `channels`, `monitors`, `themes`, `futureField`, `dependencies: ["helper@^1"]`; `hooks/hooks.json` with `SessionStart` (command) and `PreToolUse` (http); skills: `plain`, `manual` (`disable-model-invocation: true`), `forked` (`context: fork`), `restricted` (`allowed-tools`, `model`), `vars` (body references `${CLAUDE_PLUGIN_ROOT}/scripts/x.sh`), `BadName` (invalid name), `nofront` (no frontmatter); `commands/run.md`; `agents/reviewer.md`; `bin/tool`; `settings.json`)
- Create fixture: `packages/kernel/test/catalog/fixtures/claude/root-skill/` (`SKILL.md` at the root, `helper.md`, `.claude-plugin/plugin.json`)
- Test: `packages/kernel/test/catalog/claude-translate.test.ts` (+ a small `loadFixture(dir): Map<string, Uint8Array>` helper in `packages/kernel/test/catalog/claude-fixtures.ts`)

**Interfaces:**
- Consumes: `parseSkillMd(...).frontmatter` (Task 1), `PLUGIN_MANIFEST_FILE`, `parsePluginManifest`, `parseConnectorTemplateFile`, `CATALOG_ITEM_NAME_RE`, `isSafePackagePath`.
- Produces:
  ```ts
  /** The tree looks like a Claude plugin: no `.capybara-plugin/plugin.json` and one of `.claude-plugin/plugin.json`, `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/`, a root `SKILL.md`; or `hint` (a Claude marketplace entry). */
  export function isClaudePluginTree(files: ReadonlyMap<string, Uint8Array>, hint?: ClaudeEntryOverlay): boolean;
  export interface ClaudeTranslateOptions {
    fallbackName: string;      // marketplace entry name / repo name (§8.2 "no plugin.json")
    fallbackVersion: string;   // entry version, else 0.0.0-git.g<sha12>
    fallbackPublisher: string; // marketplace owner.name, else <host>/<owner>
    entryVersion?: string;     // for the "version_from_entry" item
    overlay?: ClaudeEntryOverlay;
  }
  export interface ClaudeTranslation {
    /** Original files plus `.capybara-plugin/plugin.json` (synthesized) and `.capybara-generated/connectors/<id>.json`; a root SKILL.md's files moved under `skills/<name>/`. */
    tree: Map<string, Uint8Array>;
    report: TranslationReport;
  }
  /** Throws PluginPackageError("catalog.invalid_manifest") only for: an invalid plugin name, a strict:false conflict, a path leaving the root, no importable skill and no template. */
  export function translateClaudePlugin(files: ReadonlyMap<string, Uint8Array>, o: ClaudeTranslateOptions): ClaudeTranslation;
  export function mcpServerTemplates(servers: Record<string, unknown>, source: string): { files: Map<string, ConnectorTemplateFile>; items: TranslationItem[] };
  ```
- Rules the tests pin (one test each, names in Step 1):
  - Name: Claude `name` must match `CATALOG_ITEM_NAME_RE` else `catalog.invalid_manifest` "plugin.json name … must match …". Version: valid semver from `plugin.json`, else `entryVersion` (item `version_from_entry`), else `fallbackVersion` (`version_fallback`). `description` (≤ 1024, cut) → `description`; `displayName` → `{ en: v, zh: v }` (the manifest requires a non-empty zh; spec says zh empty, see Decisions); `author.name` → `publisher`, else `fallbackPublisher` (`publisher_from_marketplace`); `license` / `homepage` (https only, else dropped with `unknown_field`) copied; `repository` display only (not in the manifest); `keywords` ignored silently.
  - Dependencies: each accepted form becomes `{ name, version: range || "*" }` with `dependency_mapped`; the review's resolution adds `dependency_not_imported` (Task 4).
  - Skills: `skills/*/SKILL.md` plus `plugin.json` / overlay `skills` paths (a string or array; a path holding `SKILL.md` is one skill, else each `<path>/*/SKILL.md`); `skill_imported` per skill; `disable-model-invocation: true` → `skill_manual_invocation` (not imported); `context: fork` → `skill_needs_subagents` (not imported); `allowed-tools` / `disallowed-tools` / `model` / `effort` → imported plus `skill_ignored_restrictions { keys }`; `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`, `${user_config.` in any file of the skill → `skill_claude_variables { variables }`; a SKILL.md that `parseSkillMd` rejects (no frontmatter, bad name, missing description) → `skill_invalid { problem }` (not imported; files never rewritten). A root `SKILL.md` becomes `skills/<name>/` with every root file except `.claude-plugin/`, `.capybara-plugin/`, `.git*`, `hooks/`, `commands/`, `agents/`, `.mcp.json`, `.lsp.json`, `LICENSE*` (`skill_root_relocated`).
  - Commands (`commands/*.md` or `plugin.json` `commands`) → `command_manual_invocation`; agents → `agent_needs_subagents`.
  - Hooks (`hooks/hooks.json`, `plugin.json` `hooks` object or path): one `hooks_not_run` per event `{ handlers: "command, http" }`; a `SessionStart` event sets `report.sessionStart` and adds `session_start_pin_hint`; a hooks module (a `.js` / `.mjs` / `.ts` path, or `types`) → `hooks_module`. At most 100 hook items (then one item with `{ more }`).
  - MCP (`.mcp.json` in either shape, `plugin.json` `mcpServers` object or path, overlay `mcpServers`; at most 20 templates, the rest `mcp_invalid { reason: "too many servers" }`): `type` `http` / `streamable-http` → one template `{ displayName: { zh: name, en: name }, description: "Remote MCP server <name> from Claude Code plugin <plugin>", template: { plugin: "connector-mcp", connector: "mcp", endpoint: { url, headers: <literal non-credential headers> }, auth } }` with id `slug(name)` (`[^a-z0-9]+` → `-`, trimmed, `-2`… on collision), item `mcp_template`. Auth: `Authorization: Bearer ${X}` → `{ type: "bearer", ownership: "personal" }` plus `mcp_header_variable { header, variable }`; exactly one other header whose whole value is `${X}` → `{ type: "api_key", ownership: "personal", in: "header", name }`; several → `{ type: "headers", ownership: "personal", names }`; a header mixing text and `${X}` (other than `Bearer `) → `mcp_invalid { reason }`; `oauth` key → `{ type: "oauth_code", ownership: "personal", discovery: "mcp", client: "dcr" }`; nothing → `{ type: "none" }` plus `mcp_auth_none`. `${VAR:-default}` in `url` → the default substituted, `editableEndpoint: ["url"]`, `mcp_url_variable`; a bare `${VAR}` in `url` → `mcp_url_variable` and the server is not converted (the URL cannot be valid). No `type` but a `url` → treated as http with `mcp_type_assumed`; `sse`, `ws`, stdio (`command`), `.mcpb` / `.dxt` → `mcp_unsupported_transport { transport }`.
  - Not applicable (`not_applicable`): `lspServers`, `.lsp.json`, `outputStyles` / `output-styles/`, `themes`, `monitors`, `workflows`, `bin/`, `settings.json`, `userConfig`, `channels`. Unknown `plugin.json` keys → `unknown_field`. Other harness manifests (`.codex-plugin/`, `.cursor-plugin/`, `.agents/`, `gemini-extension.json`, …: any root dot-directory ending in `-plugin` plus the known files) → one `other_harness` item each.
  - Overlay: `strict: true` appends entry components to the plugin's; `strict: false` with components on both sides → `catalog.invalid_manifest` "marketplace entry <name> sets strict: false and declares components that plugin.json declares too"; `strict: false` without plugin components uses the entry's; `entry_components_merged` when anything came from the entry.
  - The synthesized `plugin.json` lists every imported skill path and every generated template path (`.capybara-generated/connectors/<id>.json`) explicitly, so `readPluginFiles` never scans.

- [ ] **Step 0: Re-check the format** against https://code.claude.com/docs/en/plugins-reference and https://code.claude.com/docs/en/plugin-marketplaces (and `claude plugin validate <fixture>` when a Claude Code CLI is installed). Note any difference to the header notes in the task report; adjust the rules above only by adding report items, never by failing imports.
- [ ] **Step 1: Write the failing tests** in `claude-translate.test.ts`, one `it` per rule group: `superpowers: 4 skills imported, commands and agents ignored, SessionStart hint, other harness manifests listed`, `plugin-level fields map per §8.2 (version order, publisher fallback, displayName, homepage https only)`, `skill frontmatter: manual invocation, fork, ignored restrictions, Claude variables, invalid skills`, `a root SKILL.md becomes skills/<name>/ with its files unchanged`, `.mcp.json both shapes; http templates with bearer / api_key / headers / oauth / none; url variables; unsupported transports`, `not applicable and unknown fields never fail`, `strict merge rules`, `hostile input (Review Focus 3)` (wrong types, `"hooks": "../../x"` refused by name, non-JSON `.mcp.json` → `mcp_invalid`, 1000 handlers capped, 200 servers capped, no throw except the four listed), and `every generated template parses with parseConnectorTemplateFile and every stored skill byte equals the input`. Assert codes, groups and `detail` values exactly.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-translate.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the four files. JSON is read with a size cap of `PLUGIN_MANIFEST_LIMITS.manifestChars` per file and `JSON.parse` in try/catch; every value is type-checked before use (no zod schema for Claude's format: it is open-ended).
- [ ] **Step 4: Run** the test (PASS), `pnpm lint`, `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel): translate Claude Code plugin trees with an allowlist report`.

### Task 3: Claude marketplaces in git refresh, and migration 0051

**Files:**
- Create: `packages/kernel/src/catalog/claude/marketplace.ts`
- Create: `packages/kernel/src/migrations/0051_claude_compat.sql` (all columns of "Database" above)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (the new columns), `packages/kernel/src/catalog/marketplaces.service.ts` (`fetchGit`, entry storage, `MarketplaceView.skipped`, `MarketplaceEntryView.format`)
- Test: `packages/kernel/test/catalog/claude-marketplace.test.ts` (pure parser), `packages/kernel/test/catalog/claude-git-marketplaces.test.ts` (refresh against `startFakeGitServer`)

**Interfaces:**
- Consumes: `ClaudeEntryOverlay`, `pluginNameFrom`, `expandGitUrl`, `parseMarketplaceManifest` (to validate the produced manifest).
- Produces:
  ```ts
  export const CLAUDE_MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
  export const CLAUDE_PLUGIN_FILE = ".claude-plugin/plugin.json";
  export function parseClaudeMarketplace(json: unknown, o: { allowInsecureLoopback: boolean }):
    | { manifest: MarketplaceManifest; overlays: Map<string, ClaudeEntryOverlay>; skipped: { name: string; reason: MarketplaceSkipReason }[] }
    | { errors: string[] };
  export type MarketplaceSkipReason = "claude_npm_unpinned" | "claude_source_unsupported" | "invalid_name" | "invalid_entry";
  ```
  Mapping: `"./x"` (joined with `metadata.pluginRoot` when set; `"./"` → `"."`) → `{ path }`; `github` → `{ git: { url: "https://github.com/<repo>.git", ref, commit: sha } }`; `url` → `{ git: { url, ref, commit: sha } }`; `git-subdir` → `{ git: { url, path, ref, commit: sha } }`; `archive` with `sha256` (64 hex) → `{ archive: { url, integrity: "sha256-<base64>" } }`; `npm` → skipped `claude_npm_unpinned`; anything else → `claude_source_unsupported`. `description` → `summary.en` (cut to 280), `version` only when valid semver, `homepage` only when https. Required `name` (top level and entries) else `{ errors }`; `owner.name` → `owner.name`.
- Refresh order at the repository root (spec §5.1): `.capybara-plugin/marketplace.json` → `.claude-plugin/marketplace.json` → single plugin (`.capybara-plugin/plugin.json`, then `.claude-plugin/plugin.json` named by its `name`, then `skills/`). Overlays go to `marketplace_entries.claude`, `skipped` to `marketplaces.skipped` (replaced each refresh).

- [ ] **Step 1: Write the failing tests**: parser cases for every source form above, `metadata.pluginRoot`, invalid names skipped, `renames` / unknown keys ignored, a real `claude-plugins-official`-shaped sample (three entries, one per form); refresh cases `a .claude-plugin/marketplace.json repo lists its entries with overlays (superpowers fixture: one path "." entry, version 7.0.1 from the entry)`, `.capybara-plugin/marketplace.json wins over .claude-plugin/marketplace.json`, `a repo with only .claude-plugin/plugin.json is a single-plugin marketplace named by it`, `skipped entries are shown on the marketplace and replaced on the next refresh`. Fixture repos are committed with `fakeGit.commit(repo, loadFixtureAsStrings(dir))`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-marketplace.test.ts packages/kernel/test/catalog/claude-git-marketplaces.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the parser, the migration, the schema types, and the `fetchGit` branch (include `.claude-plugin` in the `include` filter; `pathEntryDirs` reads whichever manifest was found).
- [ ] **Step 4: Run** the tests (PASS), `pnpm check:migrations`, `pnpm exec vitest run packages/kernel/test/catalog/git-marketplaces.test.ts` (unchanged behaviour).
- [ ] **Step 5: Commit** `feat(kernel): read .claude-plugin/marketplace.json in git marketplaces`.

### Task 4: Import review: Claude path, report, license, suggested pinning, reviewHash

**Files:**
- Modify: `packages/kernel/src/catalog/plugin-import.ts` (`prepareGit`, `prepareContents`, `checkContent`, `PluginReview`, `StagedPlugin`, `pluginReviewHash`, `confirm`, `normalizedManifest`), `packages/kernel/src/catalog/catalog.service.ts` (pass `claude` overlay from the entry; `importFromGit`; version columns written at confirm), `packages/kernel/src/catalog/admin-catalog.controller.ts` (confirm body `pinnedSuggestions?: string[]`; item version detail returns `sourceFormat`, `translation`, `licenseText`), `packages/kernel/src/catalog/cli.ts` (prints the report's group counts and one line per non-imported item), `packages/kernel/src/errors.ts` (none new: refusals reuse `catalog.invalid_manifest`, `validation_failed`)
- Test: `packages/kernel/test/catalog/claude-import.test.ts`; append to `apps/capybara/test/plugins.test.ts` (`capybara plugins import git:<fake repo>` prints the report)

**Interfaces:**
- Consumes: `isClaudePluginTree`, `translateClaudePlugin` (Task 2), `marketplace_entries.claude` (Task 3).
- Produces:
  - `prepareGit(actor, files, source, opts & { claude?: ClaudeEntryOverlay })`: when `!files.has(PLUGIN_MANIFEST_FILE) && isClaudePluginTree(files, opts.claude)`, translates, then `readPluginFiles(translation.tree, { requirePackageJson: false, … })`, and sets `contentDigest = contentDigest(files)` (the files as read, Review Focus 5). When both manifests exist the native one is read and the review sets `claudeManifestIgnored: true` (§4.1).
  - `PluginReview` gains `format: "capybara" | "claude-code"`, `translation?: TranslationReport`, `claudeManifestIgnored?: true`, `licenseText?: string` (root `LICENSE`, `LICENSE.md`, `LICENSE.txt`, `LICENCE`, first found, UTF-8, ≤ 65536 bytes else omitted with `licenseTruncated: true`), and each `skills[]` item gains `suggestPinned: boolean` (from the manifest's `pinned`).
  - `pluginReviewHash` additionally covers `format`, the translation items (`[group, component, name, path, code, detail]` in report order) and `sha256(licenseText)`; all existing inputs unchanged, so a native plugin's hash changes only by the constant `format` element (stale staged rows from before the upgrade are refused with `plugin.review_stale`, acceptable: staging lives 24 h).
  - Translated templates whose connector (`connector-mcp`) is not loaded get the static checks only, `endpointChecked: false`, and a `connector_not_loaded` warning item, instead of the §4.1 refusal (Decisions 2).
  - `confirm(actor, stagingId, { reviewHash, deployExtension, pinnedSuggestions? })`: `pinnedSuggestions` (skill names, each in the review, else `validation_failed`) replaces the manifest's `pinned` flags in the stored manifest; omitted keeps them. Not part of `reviewHash` (an admin decision like `deployExtension`); audited in `catalog.plugin_imported.detail.suggestedPinned`.
  - Catalog version row: `source_format`, `translation`, `license_text`.

- [ ] **Step 1: Write the failing tests** in `claude-import.test.ts` (kernel + PG, fake git server, `connectorsLoaded` default, `model-fake` only): `importing superpowers from its Claude marketplace: format claude-code, no extension, report groups, license text, 4 skills with suggestPinned false`, `confirm with pinnedSuggestions ["using-superpowers"] stores pinned in the version manifest; an unknown name is validation_failed`, `the reviewHash changes when the report changes (one more hook) and confirm with the old hash is plugin.review_stale`, `a direct git import of the mixed fixture: templates for connector-mcp checked statically with connector_not_loaded`, `both manifests: the native one wins and the review says so`, `re-import (Review Focus 5): unchanged repo -> catalog.version_exists; moved repo -> contentChanged and +git.<sha12>`, `a strict:false conflict is catalog.invalid_manifest naming the entry`, `a tgz with only .claude-plugin/plugin.json stays catalog.invalid_manifest` (Decisions 11). CLI test: output contains `imported 4`, `ignored`, `hooks_not_run SessionStart`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-import.test.ts apps/capybara/test/plugins.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Keep the native path byte-identical except the review fields.
- [ ] **Step 4: Run** the new tests and the existing `packages/kernel/test/catalog` directory (PASS); `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(kernel): review Claude Code plugins with a translation report`.

### Task 5: Org install and upgrade carry source format and the pinned suggestion; skills API fields

**Files:**
- Modify: `packages/kernel/src/skills/skills.service.ts` (`createVersionFromFiles` `catalog` option gains `format`, `suggestPinned`; `SkillSummary` gains `plugin: string | null`, `sourceFormat`, `suggestPinned`, `entryBytes`, `tokenEstimate`), `packages/kernel/src/catalog/plugin-install.ts`, `packages/kernel/src/catalog/plugin-upgrade.ts` (pass them per skill from the version manifest and `source_format`), the agent-skills list in the same service
- Test: append to `packages/kernel/test/skills/skills.http.test.ts`; `packages/kernel/test/catalog/claude-install.test.ts`

**Interfaces:**
- Produces: `GET /api/v1/orgs/:orgId/skills` and the agent's own skills list items gain `plugin` (the catalog item name of `skills.catalog_item_id`, null for the org's own), `sourceFormat: "capybara" | "claude-code"` (current version), `suggestPinned: boolean` (current version), `entryBytes` (SKILL.md size of the current version from its manifest), `tokenEstimate` (the text estimator in `runtime/context/tokens.ts` applied to `entryBytes` as ASCII: `Math.ceil(entryBytes / 4)`). Upgrades set both columns on the new version from the target version.

- [ ] **Step 1: Write the failing tests**: `org install of a claude-code version records source_format and suggest_pinned per skill version`, `upgrade to a version that unticks the suggestion clears it on the new version`, `GET skills returns plugin, sourceFormat, suggestPinned, entryBytes, tokenEstimate; an uploaded skill has plugin null and capybara`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-install.test.ts packages/kernel/test/skills/skills.http.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests and `packages/kernel/test/catalog/plugin-install.test.ts plugin-upgrade.test.ts` (PASS).
- [ ] **Step 5: Commit** `feat(kernel): org skills record their plugin, format and pinned suggestion`.

### Task 6: Agent definition `skills.pinned`

**Files:**
- Modify: `packages/kernel/src/agents/definition.ts` (`skills.pinned: z.array(z.string().min(1).max(100)).max(3).optional()`, strict object kept), `packages/kernel/src/agents/agents.service.ts` (create and update validate it), `packages/kernel/src/skills/skills.service.ts` (`assertPinnedSkills`), `packages/kernel/src/errors.ts` (`agent.pinned_invalid`: 400), `apps/web/messages/{zh,en}.json` (error copy)
- Test: `packages/kernel/test/agents/pinned-skills.test.ts`

**Interfaces:**
- Produces: `PINNED_SKILLS_LIMITS = { count: 3, totalBytes: 32768 } as const` (exported from `skills/catalog.ts`, used by Tasks 7 and 10 through the API); `assertPinnedSkills(t, orgId, agentId: string | null, skills: AgentDefinition["skills"], kept: ReadonlySet<string>): Promise<void>` throws `agent.pinned_invalid` with `details: [{ skill, reason: "not_selected" | "not_found" | "duplicate" | "too_many" | "too_large", totalBytes? }]`. Rules: unique; ≤ 3; each newly added id is an org skill listed in `orgSkills` or this agent's own skill, not deleted (ids kept from the current definition are not re-checked, like `assertOrgSkills`); the sum of the current versions' SKILL.md sizes of the non-deleted pinned skills ≤ 32768.

- [ ] **Step 1: Write the failing tests**: `a definition without skills.pinned saves without a new version on an unrelated edit`, `pinning an org skill not in orgSkills is not_selected`, `four pinned is too_many`, `two skills totalling 33000 bytes is too_large with totalBytes`, `pinning the agent's own skill works`, `a pinned id whose skill was deleted later is kept on the next save (Review Focus 2)`, `editing pinned on a shared agent creates a new agent version and no skill_change_request (§9.1)`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/agents/pinned-skills.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test and `packages/kernel/test/agents` (PASS).
- [ ] **Step 5: Commit** `feat(kernel): agents can pin up to three skills`.

### Task 7: Snapshot: plugin names, pinned bodies, tool-name map; `skill_load` qualified names

**Files:**
- Modify: `packages/kernel/src/conversations/events.ts` (schema additions above), `packages/kernel/src/runtime/context/skills.ts` (`CatalogSkill` gains `plugin?`; `PinnedSkill` type; `sameSnapshot`), `packages/kernel/src/skills/catalog.ts` (`resolveEffectiveSkills` selects the catalog item name and the version's `source_format`; `recordSkillsCatalog` resolves pinned and the tool map; `lockLatestCatalog` returns the whole payload), `packages/kernel/src/skills/changes.service.ts` (`appendCatalog` carries `pinned` / `toolMap` forward), `packages/kernel/src/tools/builtins/skill-load.ts` (qualified names), `packages/kernel/src/runtime/run-worker.ts` (passes `storage`), `packages/kernel/src/runtime/context/claude-tools.ts` (create: `CLAUDE_CODE_TOOL_MAP` text, Task 8 fixes it)
- Test: append to `packages/kernel/test/skills/skills-runtime.test.ts`; append to `packages/kernel/test/skills/skill-write.test.ts`

**Interfaces:**
- Consumes: `skills.pinned` (Task 6), `skill_versions.source_format` (Task 5), `PINNED_SKILLS_LIMITS`.
- Produces:
  ```ts
  export type PinnedSkill = NonNullable<EventPayload<"skills_catalog">["pinned"]>[number];
  export type SkillsSnapshot = EventPayload<"skills_catalog">;
  /** sameSkills(a.skills, b.skills) (unchanged: `plugin` is not compared) && same pinned (id, version, source, in order; absent = []) && same toolMap (absent = undefined). */
  export function sameSnapshot(a: SkillsSnapshot, b: SkillsSnapshot): boolean;
  /** Reads each pinned skill's SKILL.md from `kernel/<orgId>/<source>SKILL.md`, verifies it against the manifest sha256, returns the parsed body; throws ApiError("storage.unavailable") on a read failure or an integrity mismatch. */
  export async function loadPinnedBodies(storage: StorageService, orgId: string, pinned: { id: string; version: number; name: string; source: string; manifest: SkillManifest }[], signal?: AbortSignal): Promise<PinnedSkill[]>;
  ```
- `recordSkillsCatalog` flow: (1) outside a transaction resolve the effective skills and the pinned entries (definition order, ids present in the effective set; trial drafts apply as for the catalog), read bodies, keep entries while the running total of UTF-8 body bytes ≤ 32768 (drop the rest with `log.warn("pinned skills over the limit", …)`, Review Focus 4); (2) in the transaction lock, resolve again; if the pinned identities differ from step 1, retry from step 1 (at most 3 times, then `conflict`); (3) `toolMap = CLAUDE_CODE_TOOL_MAP` iff some effective skill has `source_format = 'claude-code'`; (4) write only when `!sameSnapshot(last, next)` (a missing last snapshot with no skills and no pinned still writes nothing). A read failure ends the run with `run_failed` code `storage.unavailable` before any model request (Decisions 9).
- `appendCatalog` (skill_write, approvals, reverts): carries `pinned` and `toolMap` from the latest snapshot; skill_write of a pinned skill replaces that entry's version, source and body with the files it just wrote; a revert removes the pinned entry whose `source` is the reverted draft's prefix (the next run start restores the real version; Decisions 8). The tool map is recomputed only at run start.
- `skill_load`: when no skill has the exact name and the input matches `^([a-z0-9][a-z0-9-]{0,63}):(.+)$`, resolve `<name>` when the matching entry's `plugin` equals the prefix; otherwise the existing "not in the skills catalog" error listing unprefixed names. The tool spec (and its `maxLength: 64`) is unchanged, so no tool definition changes (Decisions 5).

- [ ] **Step 0: Run the zero-drift tests** (`reconstruct.test.ts`, `rename-compat.test.ts`) and note they pass before any change.
- [ ] **Step 1: Write the failing tests** in `skills-runtime.test.ts`: `a catalog skill from a plugin carries plugin; an uploaded one does not`, `pinned bodies go into the snapshot in the agent's order with version and source`, `an old snapshot without plugin / pinned / toolMap and unchanged skills: no new event (Review Focus 1)`, `unpinning, a new version of a pinned skill and deleting a pinned skill each write a new snapshot (Review Focus 2)`, `a pinned set over 32 KB at run time keeps what fits and warns (Review Focus 4)`, `toolMap appears with the first claude-code skill and goes with the last`, `a storage failure while reading a pinned body ends the run with run_failed storage.unavailable and writes no snapshot`, `skill_load "superpowers:brainstorming" loads brainstorming; "other:brainstorming" is not in the catalog; a plain name still works`; in `skill-write.test.ts`: `skill_write of a pinned agent skill refreshes its pinned body in the mid-run snapshot`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/skills`. Expected: FAIL.
- [ ] **Step 3: Implement.** `build.ts` is not touched in this task (rendering is Task 8), so requests stay as before.
- [ ] **Step 4: Run** `packages/kernel/test/skills`, `packages/kernel/test/evals/run-replay.test.ts` (full-run replay copies the snapshot with `pinned` and `toolMap` unchanged; add the assertion there), and the zero-drift tests (still zero drift). Expected: PASS.
- [ ] **Step 5: Commit** `feat(kernel): skills snapshot records plugins, pinned skills and the Claude tool map`.

### Task 8: Rendering pinned skills and the tool map; DriftReason; zero-drift fixtures

**Files:**
- Modify: `packages/kernel/src/runtime/context/skills.ts` (texts below), `packages/kernel/src/runtime/context/claude-tools.ts` (the map text), `packages/kernel/src/runtime/context/build.ts` (system segment, reminders, compaction restore), `packages/kernel/src/evals/reconstruct.ts` (`DriftReason` `pinned_changed`, `DRIFT_ORDER` after `definition_missing`)
- Test: append to `packages/kernel/test/evals/reconstruct.test.ts` (baseline group and drift group); create `packages/kernel/test/runtime/pinned-render.test.ts` (pure `buildModelRequest` cases)

**Interfaces:**
- Consumes: the snapshot fields of Task 7.
- Produces (exact model-visible text; `${…}` are values):
  - `PINNED_SKILLS_HEADER` = `"Pinned skills: the owner of this agent pinned these skills, so their instructions apply throughout this conversation. Follow them without calling skill_load; call skill_load only to copy a pinned skill's files into the sandbox."`
  - `pinnedBlock(p)` = `` `<pinned_skill name="${p.name}" version="${p.version}">\n${p.body.trim()}\n</pinned_skill>` ``
  - `pinnedSystemText(pinned)` = header + `"\n\n"` + blocks joined by `"\n\n"`.
  - `pinnedChangeText(prev, next)` parts, in this order, joined by `"\n\n"`: added or new version (id new, or version / source changed): `` `Pinned skill "${name}" (version ${v}) now applies to this conversation and replaces any previous version of it:\n\n${pinnedBlock}` ``; removed: `` `Pinned skills removed (their pinned instructions no longer apply): ${names}` ``.
  - `pinnedCurrentText(pinned)` = `"Pinned skills now (this replaces any earlier pinned skills):\n\n" + blocks`, or `"No skills are pinned now (this replaces any earlier pinned skills)."`.
  - `CLAUDE_CODE_TOOL_MAP` (`claude-tools.ts`, the text stored in the log):
    ```
    Some skills in this conversation were written for Claude Code and name its tools. Use these tools instead:
    - Bash -> sandbox_bash
    - Read -> sandbox_read; Write -> sandbox_write; Edit and MultiEdit -> sandbox_edit; Glob -> sandbox_glob; Grep -> sandbox_grep
    - Skill -> skill_load (a name such as "superpowers:brainstorming" also works)
    - TodoWrite -> todo__write when it is in your tools; otherwise keep the task list in your replies
    - AskUserQuestion -> ask_user
    - ToolSearch -> tool_search when it is in your tools
    - Task and Agent (sub-agents) -> not available: do the steps yourself, in order
    - Any other tool a skill names (for example WebFetch, WebSearch, NotebookEdit, EnterWorktree) -> not available unless one of your tools does the same job
    The sandbox tools exist only when this agent has a sandbox; without them a skill's scripts cannot run. A path such as ${CLAUDE_PLUGIN_ROOT}/skills/<name>/... means /skills/<name>/... after skill_load has copied that skill into the sandbox.
    ```
  - Rendering: the system snapshot (first, before any `model_call`) renders `base + "\n\n" + skillsCatalogText(skills)` exactly as today, then `+ "\n\n" + pinnedSystemText(pinned)` when `pinned` is non-empty, then `+ "\n\n" + toolMap` when present (a snapshot with no skills but pinned is impossible: pinned ⊆ skills). A later snapshot renders one system message: `skillsChangeText(prev.skills, next.skills)` only when the skills differ (`sameSkills` false; text unchanged from today), then `pinnedChangeText` when pinned differ, then `toolMap` when it differs from the previous snapshot's (`"The following tool-name map now applies:\n" + toolMap`; removed: `"The Claude Code tool-name map no longer applies."`). After a compaction summary: today's `skillsCurrentText` rule unchanged, plus `pinnedCurrentText(covered.pinned)` when the covered snapshot's pinned differ from the system snapshot's (absent = []), plus the covered `toolMap` when it differs from the system one.
  - `DriftReason` `"pinned_changed"`: a step replay whose candidate definition (or candidate agent version) has `skills.pinned` different from the ids of the recorded effective snapshot's `pinned` (the request still uses the recorded bodies). Never set for a baseline. See Decisions 1.

- [ ] **Step 0: Run the zero-drift tests** and record PASS before editing `build.ts`.
- [ ] **Step 1: Write the failing tests**: `pinned-render.test.ts` with hand-built event lists: `no pinned and no toolMap: system text equals today's (golden string)`, `pinned after the catalog in the system segment, in order`, `a pinned new version mid-conversation: one system message with the full body, the sent prefix unchanged`, `removed pinned: names only`, `only pinned changed: no catalog change text`, `compaction: current pinned bodies and tool map restored after the summary`; `reconstruct.test.ts` baseline: `pinned skills, a pinned version change mid-conversation, a claude-code skill with the tool map, and a compaction: zero drift and equal to what the provider received` (real run with `model-fake`, captured at `ProviderRegistry.resolve` as the existing group does); drift group: `a candidate version that pins differently -> pinned_changed`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/pinned-render.test.ts packages/kernel/test/evals/reconstruct.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the texts and the rendering.
- [ ] **Step 4: Run** the zero-drift tests again (`reconstruct.test.ts`, `rename-compat.test.ts`, and the pre-rename fixtures): PASS, all old cases unchanged. Then `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/evals`.
- [ ] **Step 5: Commit** `feat(kernel): render pinned skills and the tool map from the log`.

### Task 9: Web: translation report, suggested pinning and license on the import review

**Files:**
- Create: `packages/design/src/display/Disclosure.tsx` (summary line + children, `defaultOpen`, keyboard and `aria-expanded`), export from `packages/design/src/display/index.ts`, an entry on `/dev/ui` (`apps/web/src/dev/…` catalog page), a design test
- Modify: `apps/web/src/lib/catalog.ts` (review types: `format`, `translation`, `claudeManifestIgnored`, `licenseText`, `licenseTruncated`, `skills[].suggestPinned`; `confirmPluginImport(stagingId, { reviewHash, deployExtension, pinnedSuggestions })`), `apps/web/src/app/[locale]/(app)/admin/catalog/import/page.tsx` (`ReviewBody`: a "Translation" `ComponentSection` with five sub-lists, the skills section with a "Suggest pinned" `Checkbox` per skill and the body in a `Disclosure`, a license `Disclosure`, the both-manifests note; the skills section is open by default when `translation.sessionStart`), `apps/web/src/app/[locale]/(app)/admin/catalog/[itemId]/page.tsx` (version: format badge, report, license), `apps/web/src/app/[locale]/(app)/admin/marketplaces/page.tsx` (skipped entries with reasons), `apps/web/src/components/CatalogParts.tsx` (`TranslationReportView` shared by both pages), `apps/web/messages/{zh,en}.json` (`catalog.admin.review.translation.*`: one message per `TranslationCode` with its `detail` placeholders, group titles, `suggestPinned`, `suggestPinnedHint`, `sessionStartHint`, `license`, `licenseTruncated`, `claudeManifestIgnored`, `formatClaude`; `catalog.admin.marketplaces.skipped.*` per `MarketplaceSkipReason`)
- Test: `apps/web/test/catalog-pages.test.tsx` (append), `packages/design/test/disclosure.test.tsx`

**Interfaces:**
- Consumes: Task 4's review and confirm.
- Produces: `TranslationReportView({ report }: { report: TranslationReport })`; `Disclosure({ summary: ReactNode; defaultOpen?: boolean; children: ReactNode })`.

- [ ] **Step 1: Write the failing tests**: design `Disclosure toggles and reports aria-expanded`; web `the review lists the five groups with localized reasons`, `suggest pinned checkboxes are sent as pinnedSuggestions on confirm`, `with a SessionStart hook the skills section is open and shows the hint`, `the license is collapsed and expandable`, `a native plugin review shows no translation section`, `every TranslationCode and MarketplaceSkipReason has zh and en text` (iterate the code list exported from `lib/catalog.ts`).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/catalog-pages.test.tsx packages/design/test/disclosure.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement** (design components only; no `className` / `style`).
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm --filter @capybara-hq/web build`. (No e2e step: the web e2e setup has no git server; the kernel side is covered end to end by Task 11.) Visual baselines for `/dev/ui` and the import page are regenerated by the `visual-update` workflow on the PR (then an empty commit reruns CI).
- [ ] **Step 5: Commit** `feat(web): Claude plugin translation report and pinned suggestions on import review`.

### Task 10: Web: the pinned control on the agent page

**Files:**
- Modify: `apps/web/src/components/AgentSkills.tsx` (`PinnedSkillsPicker`), `apps/web/src/components/AgentForm.tsx` (state `pinned`, saved as `definition.skills.pinned` only when non-empty or previously set; selecting a skill with `suggestPinned` ticks it when fewer than 3 are pinned; deselecting a skill unpins it), `apps/web/src/lib/skills.ts` (`SkillSummary` fields of Task 5), `apps/web/messages/{zh,en}.json` (`agents.form.pinned*`: label, hint, `tokenEstimate` "≈ {n} tokens", `overLimit` with {bytes}/{max}, `tooMany`, `suggested` badge, `agent.pinned_invalid` error lines per reason)
- Test: `apps/web/test/agent-skills.test.tsx`, `apps/web/test/agent-form.test.tsx` (append); `apps/web/e2e/skills.spec.ts` (append: pin a skill, save, reload)

**Interfaces:**
- Consumes: `GET skills` fields (Task 5), `agent.pinned_invalid` details (Task 6), `PINNED_SKILLS_LIMITS` values (3, 32768; duplicated as constants in `lib/skills.ts` with a comment naming the kernel constant).
- Produces: `PinnedSkillsPicker({ skills, selected, value, onChange }: { skills: SkillSummary[]; selected: string[]; value: string[]; onChange(next: string[]): void })` listing only selected skills (org skills in `orgSkills` plus own skills), a `Checkbox` per skill with a "suggested" `Badge`, the summed `tokenEstimate`, and `Text tone="warn"` when over 3 or over 32768 bytes (Review Focus 4: the current versions' sizes; save is then refused by the kernel and the error is shown).

- [ ] **Step 1: Write the failing tests**: `selecting a suggested skill ticks pinned by default; the owner can untick it`, `a fourth pin is disabled with the tooMany hint`, `the token estimate sums the pinned skills`, `over 32 KB shows the warning and the kernel error lines map per reason`, `a definition without pinned is saved without skills.pinned`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/agent-skills.test.tsx apps/web/test/agent-form.test.tsx`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the tests, `pnpm check:web-ui`, `pnpm check:i18n`, e2e `skills.spec.ts` locally.
- [ ] **Step 5: Commit** `feat(web): pin skills on the agent page`.

### Task 11: Phase B acceptance end to end, replay, live test, connector-mcp template install

**Files:**
- Create: `packages/kernel/test/catalog/claude-superpowers.e2e.test.ts`
- Create: `packages/kernel/test/helpers/provider-capture.ts` (the `ProviderRegistry.resolve` capture `reconstruct.test.ts` uses, moved here; `reconstruct.test.ts` imports it)
- Create: `packages/kernel/test/catalog/claude-live.test.ts` (skipped unless `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1`; optional `CAPYBARA_TEST_HTTPS_PROXY` → `net.httpsProxy`)
- Create: `plugins/connector-mcp/test/claude-template.test.ts` (uses only `@capybara-hq/testing`: `startTestKernel`, `startFakeGitServer`, `startFakeMcpServer`)

**Interfaces:**
- Consumes: everything above; `model-fake`'s `tool:<name>:<json>` directive.

- [ ] **Step 1: Write the acceptance test** (spec §12 Phase B), one `it` per bullet, sharing one kernel:
  1. `adding the superpowers repo as a git marketplace and importing superpowers; the report lists hooks, commands and the other ignored parts`: commit the fixture to the fake git server as `superpowers`; `POST /api/v1/admin/marketplaces` (git form) → refresh → entry `superpowers` 7.0.1 → import → assert `format`, the `hooks_not_run SessionStart`, `command_manual_invocation brainstorm`, `agent_needs_subagents code-reviewer`, `other_harness .codex-plugin` items and `sessionStart: true`.
  2. `the admin ticks using-superpowers as pinned and the org installs it; an agent selects the skills and pins using-superpowers`: confirm with `pinnedSuggestions: ["using-superpowers"]`; org install; `GET skills` shows `suggestPinned` on it; create an agent (model `model-fake`) with all four in `orgSkills` and `pinned: [<using-superpowers id>]`.
  3. `asked for a new feature, the model loads brainstorming first (superpowers:brainstorming also loads)`: post `tool:skill_load:{"name":"superpowers:brainstorming"}` then `tool:skill_load:{"name":"brainstorming"}`; assert the first request the provider received has the using-superpowers body inside `<pinned_skill name="using-superpowers"` in `system[0]` and the tool map text; both `tool_result`s contain the brainstorming body and no error.
  4. `replaying that conversation reproduces its requests exactly`: take a case snapshot (`takeSnapshot`), `reconstructRequest` for every `model_call` → `drift: []` and `toEqual` the captured requests; a full-run replay (`runReplay`, recorded tools only) of the run → zero `tool_unmatched` and the same requests.
- [ ] **Step 2: Write the live test**: import `https://github.com/obra/superpowers.git` as a git marketplace through the real network rules; assert the review has ≥ 10 skills, `sessionStart: true`, MIT license text; confirm nothing (the staging row expires).
- [ ] **Step 3: Write the connector-mcp test**: commit the `mixed` fixture's `.mcp.json` server with `Authorization: Bearer ${API_TOKEN}` (URL pointing at `startFakeMcpServer`) as a Claude plugin; import with `connector-mcp` loaded (`endpointChecked: true`); org install with a bearer credential; the connector lists the fake server's tools.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/kernel/test/catalog/claude-superpowers.e2e.test.ts packages/kernel/test/evals/reconstruct.test.ts plugins/connector-mcp/test/claude-template.test.ts`; then, with the env var set and the maintainer's proxy, `CAPYBARA_TEST_CLAUDE_SUPERPOWERS=1 pnpm exec vitest run packages/kernel/test/catalog/claude-live.test.ts`. Expected: PASS (live: PASS or skipped). `pnpm check:test-plugins` (the new kernel tests load only `model-fake` and fakes).
- [ ] **Step 5: Commit** `test: phase B acceptance with superpowers, model-fake and replay`.

### Task 12: Docs, spec "as built", verify

**Files:**
- Modify: `.agents/skills/writing-plugins/SKILL.md` (Claude Code plugins: detection, the translation tables in short, the report, `pinnedSuggestions`, `connector_not_loaded`, Claude marketplaces and skipped entries, license text), `.agents/skills/writing-tools/SKILL.md` (`skill_load` qualified names; pinned skills), `.agents/skills/replay-evals/SKILL.md` (snapshot `pinned` / `toolMap`, `pinned_changed`, the new zero-drift case), `AGENTS.md` (plugin rule line: Claude Code plugins from git; tools rule: pinned skills and qualified names; evals rule: drift reason list), `docs/superpowers/specs/2026-10-22-package-ecosystem-design.md` ("Phase B as built": the Appendix A re-check result, the decisions below with their outcomes, acceptance status naming the Task 11 tests; Appendix A updated in place with a "re-checked 2026-10-26" note), `.changeset/ecosystem-phase-b.md` (final text)
- Test: none new.

- [ ] **Step 1:** Write the docs. Skill frontmatter stays English and ≤ 1024 characters (`pnpm check:skills-frontmatter`).
- [ ] **Step 2: Run** `pnpm check:terms`, `pnpm check`, `pnpm lint`, `pnpm typecheck`, `pnpm verify`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: Claude Code compatibility, pinned skills and qualified names`.

## Decisions for the maintainer (all **(designer's call)** unless noted)

1. **`DriftReason` for pinned skills** (§9.1 asks for one): the bodies are in the log, so a baseline can never miss them and old logs mean "none pinned". The plan adds `pinned_changed` for step replays whose candidate definition pins a different set (the request still uses the recorded bodies). Alternative: no new reason, with the spec amended. The tool map needs none (its text is in the log).
2. **Translated templates target `connector-mcp`, which may not be loaded** (after A3b it is not part of core): they get the static checks with `endpointChecked: false` and a `connector_not_loaded` warning, instead of §4.1's refusal of an unknown connector. Org install still checks against the loaded connector.
3. **Claude `npm` marketplace sources are skipped** (`claude_npm_unpinned`): they carry no integrity. §14's "record the registry's integrity and mark content not pinned" is left for later.
4. **`displayName.zh` copies `en`**: §8.2 says "zh empty", but the manifest schema requires a non-empty zh.
5. **`skill_load` keeps `maxLength: 64`**: the tool definition does not change (no cache break, no spec hash change). A qualified name longer than 64 characters is refused by the schema; the plain name still works.
6. **Claude skills without `name` or `description` frontmatter are ignored** (`skill_invalid`): Capybara requires both and never rewrites skill files.
7. **An http MCP server without headers or `oauth` becomes `auth: none`** with a warning, although Claude starts OAuth on a 401 (Linear, GitLab). Alternative: default to `oauth_code` with MCP discovery and DCR, which forces sign-in on public servers.
8. **A revert snapshot drops the pinned entry** of the reverted draft; the next run start restores the real version's body (avoids reading object storage inside the decision transaction).
9. **Pinned bodies are read from object storage at run start** (verified by sha256, outside the transaction, with a bounded retry), not stored in PG. A storage outage fails the run (`storage.unavailable`) before any model request; the user can send again.
10. **"Suggest pinned" applies to every plugin import**, is chosen at confirm (`pinnedSuggestions`), and is not part of `reviewHash`.
11. **Claude plugins are read from git only** (marketplace path and git entries, single-plugin repos, direct git import). An uploaded or npm tgz without `.capybara-plugin/plugin.json` stays `catalog.invalid_manifest`.
12. **Detection without `plugin.json`**: a tree with `hooks/hooks.json`, `.mcp.json`, `commands/`, `agents/` or a root `SKILL.md`, or an entry of a Claude marketplace, is read as Claude; a tree with only `skills/` stays the A1 skills-only plugin.
13. **License text is stored for every plugin version** (`license_text`, ≤ 64 KiB), not only Claude ones.
14. **A new design component `Disclosure`** is needed for expandable bodies and the license (`writing-web-ui` change flow; baselines via `visual-update`).
15. **The tool-name map is fixed text**, not tailored to the agent's tools (tailoring would need the tool set at snapshot time, which is resolved later in the loop); it says "when it is in your tools" instead.
16. **Pinned order is the owner's order** in `skills.pinned`; over the 32 KB limit at run time the later ones are dropped with a warning.
17. **Phase timing**: §12 puts phase B after the first release; this plan is written against current `main` with plugins still in core and keeps every core test on fakes so it does not depend on the split.
