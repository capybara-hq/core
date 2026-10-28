# @capybara-hq/plugin-sdk

## 0.2.0

### Minor Changes

- b50154b: Skill invocation metadata and rendering (package ecosystem phase D):
  
  - `SkillInvocation` and `skillInvocation(frontmatter)` read a SKILL.md's
    `disable-model-invocation`, `user-invocable`, `context: fork`, `agent`, `argument-hint` and
    `arguments`; `SKILL_INVOCATION_LIMITS`.
  - `parseSkillArguments`, `renderSkillBody` and `renderSkillInvocation` render `/name args` with
    Claude Code's `$ARGUMENTS`, `$N`, `$name`, `\$` and `${CLAUDE_SKILL_DIR}` rules (nothing is
    executed); `hasShellInjection` finds `` !`command` `` lines; `escapeSkillInvocationTags` makes
    the wrapper tags inert in text that quotes a person's input. The input's `skillName` (the bare
    skill name) names the sandbox directory for `${CLAUDE_SKILL_DIR}` and the files line, never the
    typed `<plugin>:<name>`. A rendered body over `SKILL_INVOCATION_LIMITS.renderedMaxChars`
    (placeholders repeating the arguments) throws a `RangeError` while substituting.
  - `parseSkillMd` now reports wrong types of those keys, and refuses a skill with both
    `disable-model-invocation: true` and `user-invocable: false`.
- 21b1385: `ToolSpec` gains display-only `title` and `keyArgs` (shown on the conversation page's tool rows, never sent to the model), checked by the new `validateToolPresentation` and by `validateToolSpec`. A title or key argument name with control, bidi or invisible characters (Unicode Cc / Cf, except ZWNJ U+200C and ZWJ U+200D, which scripts and emoji sequences need) is rejected.
  
  `ModelCallPurpose` gains `"title"`: conversation title calls fire `model.request` (a policy hook can deny them; the title is then skipped) and `model.response` with `purpose: "title"`, `runId: ""`, `step: 0`, `attempt: 1`. `UsageReportPayload.purpose` is a `UsagePurpose`, now the same values as `ModelCallPurpose`. A hook that switched exhaustively over `purpose` must handle `"title"`.
  
  New extension point `file-preview@1` (org scoped, several providers): a provider lists `previewers`, each with an id, a bilingual title, `accepts` (MIME types with `type/*` wildcards and / or file extensions), `maxBytes` (at most `FILE_PREVIEW_MAX_BYTES`, 20 MiB) and exactly one of `render(args) => UiView` or `embed` (the id of a ui contribution with the new place `"file-preview"`, embed only). `render` reads the file through `args.read()`, a grant for that one file valid only during the call; an embed previewer gets the file as the bridge message `{ type: "file", name, contentType, size, data }` after `init` and its token claims carry `fileId`. `validateFilePreviewProvider` and `previewerAccepts` are exported; an invalid provider fails `setup`.
  
  Extension UI places for the conversation page: `UiPlace` gains `"panel"` (a right panel opened from the title bar), `"section"` (a properties-panel section) and `"inline"` (an inline card); the old `"conversation"` keeps working and means `panel` (`normalizePlace`). A contribution may set `icon` (from `UI_ICONS`, default `puzzle`) and `aliasOf` (a retired id that answers as another contribution of the same extension and kind, not listed). Open targets `UiOpen = { contribution, item? }` go on `UiView.open`, on checklist and keyValue items (with an anchor `id`) and as a parallel `open` array on a table block; `UiRenderArgs` gains `item` (the panel item to scroll to) and `card` (`{ callId, key? }` for an inline card). `ToolResult.card = { view, key? }` names an inline view of the same extension to show under the call: display only, never in the model's context.
  
  An approval `ChannelCard` may carry `denyReason` (a denied approval: the reason the person gave), checked as a non-empty string by `validateChannelCard` and shown by `renderCardAsText` as a `Reason` line in code.

### Patch Changes

- 89b4521: Marketplace downloads refuse private addresses and redirects: every host must resolve to a public
  address (or be listed in `marketplaces.allowPrivateHosts`), and the connection is pinned to the
  checked address.
  
  Plugins can be read from git commits (smart HTTP over the same network rules: depth 1, no tags or
  submodules, size and file limits); `@capybara-hq/testing` adds `startFakeGitServer`.
  The SDK exports `hostSdkProblem` (the host SDK range check of `validatePluginPackageJsonFor`).
  
  Git marketplaces: a marketplace can be a git repository (`owner/repo`, an https `.git` URL or
  `form: "git"`, optional `ref`); a refresh reads `.capybara-plugin/marketplace.json` or treats a
  single-plugin repo as one entry, and skips an unchanged commit. `path` and `git` entries are
  imported from git (source `git`, with host, repo, path, commit and "follows a branch" recorded),
  `POST /api/v1/admin/catalog/import/git` imports one plugin straight from git, and
  `marketplaces.allowedHosts` limits the hosts entries may download from (migration 0046).
  
  Every catalog version records a content digest (sha256 over its files, the same for a tgz and a
  git tree). Re-importing an imported version with other content records `<version>+git.<sha12>` /
  `+sha256.<12>` (the same content is refused as already imported); versions are ordered by semver
  without build metadata, ties by import time. Marketplace entries and catalog items show
  `contentChanged` when an imported version's commit or integrity no longer matches the entry (a
  refresh resolves the branch heads of imported branch-following git entries, migration 0047; git
  sources compare the tree oid of the plugin's directory, so a monorepo commit elsewhere changes
  nothing, migration 0048). An
  archive without plugin.json is a skills-only plugin versioned `0.0.0-sha256.h<12>`.
  
  The import review shows npm provenance for npm and npm-backed marketplace imports (`provenance`:
  repository, commit, workflow and build type from the registry's SLSA attestation, signatures not
  verified; otherwise `checked: false` with a reason) and `provenanceWarning: "repository_mismatch"`
  when a git marketplace's repository differs from the attested one; `@capybara-hq/testing` serves
  attestations (`npmProvenanceAttestations`). An org install whose skill name exists as the org's own
  skill or another plugin's is refused with 409 `plugin.skill_conflict`, nothing written; a reinstall
  of the same plugin still adds a version.
  
  Org admins upgrade an installed plugin in place (spec §10): `POST
  /api/v1/orgs/:orgId/plugin-installs/:installId/upgrade/preview` returns the per-component diff,
  the inputs needed and a `diffHash`; `POST …/upgrade` applies it (409 `plugin.upgrade_stale` on
  another diff, 202 with a request for needs_approval items). An extension-bearing plugin can move
  only to the catalog version carrying the deployment's extension (`plugin.upgrade_target_invalid`);
  a declarative one to any imported version. Skills get new versions, connectors only their
  template-owned fields (credentials kept unless their shape changes), removals follow the uninstall
  rules; a failed step undoes the upgrade (502 `plugin.upgrade_failed`), an interrupted one is undone
  after `catalog.staleInstallMinutes`. Install views gain `upgradeAvailable` and `deploymentPending`
  (migration 0049: status `upgrading`, the upgrade journal, connector components' `template_id`, `dropped` for a component kept
  after leaving the plugin because an agent uses it).
  
  The web console adds git marketplaces (a repository with an optional ref), each entry's source
  (pinned commit or followed branch), "content changed at the same version", a version's origin, the
  import review's npm provenance, an "Import from git" source, and plugin upgrades from the installed
  plugins and the catalog item page (a preview of the changes and inputs, then confirm).
  
  The upgrade preview carries the target version's connector templates its inputs name
  (`templates`). The network, git and upgrade-target errors (`marketplace.host_not_allowed`,
  `private_address`, `redirect`, `git_*`, `path_unsupported`, `plugin.upgrade_target_invalid`) carry
  structured details (host, repo, ref or commit, refused entry, the version rule) next to the message.
  
  `capybara plugins import git:<url>[#<ref>][:<path>]` imports a plugin folder straight from a git
  repository under the same network rules; the CLI's review prints the git location and commit, the
  content digest and npm provenance.
- c2c826b: Marketplace, archive and git downloads can go through an HTTP(S) egress proxy: set `net.httpsProxy`
  (credentials in the URL are sent as Basic proxy auth and never logged) and `net.noProxy` for hosts
  that go direct. Behind the proxy the kernel no longer resolves the target (the proxy does and owns
  SSRF protection for DNS names); IP-literal private targets are still refused, and a proxy refusing
  `CONNECT` is reported as `net.proxy_refused`.
  
  The plugin SDK adds the bootstrap manifest (`parseBootstrapManifest`, `bootstrapFileName`, JSON
  Schema `schemas/bootstrap.v1.schema.json`) for `packages/kernel/bootstrap.json`, the plugins a
  deployment installs at init, each pinned to an exact version and sha512.
  
  Bootstrap plugins replace the builtin extensions. The kernel runs the bootstrap step at start
  (`KernelOptions.bootstrapDir`, optional `bootstrapManifest`; once per manifest across replicas, under
  an advisory lock) before loading extensions: every package is checked against its pinned sha512
  (`bootstrap.integrity_mismatch`, `bootstrap.missing_file`), imported into the catalog and installed
  with source `bootstrap`, pre-approved (snapshot source `bootstrap`) and enabled; a raised version
  upgrades a plugin still at its bootstrap version, a higher one is never downgraded, and an entry
  that left the manifest only loses `required`. A required plugin is enabled in every organization
  without an org config row and cannot be disabled or uninstalled (409 `extension.required`); `start()`
  refuses to serve when a required entry cannot be installed. `KernelOptions.builtinExtensions`, the
  `builtin` extension source and `extension.builtin` are removed. The testing harness takes
  `bootstrap: { dir, manifest }` instead of `builtinExtensions`.
  
  The CLI no longer depends on `@capybara-hq/plugin-openai-compatible` or
  `@capybara-hq/plugin-object-store-s3`. `capybara bootstrap [--dir <path>] [--manifest <path>]` runs
  the bootstrap step from the packages in `/app/bootstrap`, which the kernel image now carries (packed
  from the workspace and checked against `bootstrap.json` at build time); compose `init` runs it
  between `migrate` and `admin create`, and `capybara start` runs it too when it finds the step not
  done (`--bootstrap-dir`, else `/app/bootstrap` when it exists). The CLI's object store (plugin
  imports with files) may now be an enabled, approved install record such as the bootstrap
  object-store-s3, and `capybara extensions list` shows bootstrap plugins with source `bootstrap` and
  desired state `required`.
  `capybara bootstrap` exits 1 when a required entry fails or a package is missing or tampered, and
  exits 0 with warnings when only optional entries still fail after its second pass (as `start` does).
  The org extensions page shows required plugins as "Required" with a read-only switch.
- 9a5a340: Claude Code plugins import from git marketplaces with a translation report; agents can pin skills;
  `skill_load` accepts `<plugin>:<name>`. `parseSkillMd` returns the whole parsed frontmatter
  (`frontmatter`) next to the name, description and body.
  
  Git marketplaces read Claude Code's `.claude-plugin/marketplace.json` (entries with an overlay of
  their component fields and `strict`; npm, archive and command sources are listed as skipped) and
  single Claude plugin repositories. A Claude Code plugin from git goes through the one import review
  with `format: "claude-code"`, a five-group translation report (covered by `reviewHash`), connector
  templates for its remote MCP servers and no extension; every review carries the root LICENSE text
  and each skill's `suggestPinned`, and confirm takes `pinnedSuggestions`. Catalog versions record
  `sourceFormat`, `translation`, `licenseText` and `licenseTruncated`; `capybara plugins import`
  prints the report. The translator takes at most 100 distinct declared paths per component key
  and parses each JSON file once.
  
  Org installs and upgrades record each skill version's source format and pinned suggestion (an
  upgrade that leaves a skill unchanged updates its current version's flag); the org and agent
  skills lists return `plugin`, `sourceFormat`, `suggestPinned`, `entryBytes` and `tokenEstimate`.
  A connector template with personal static auth asks the installer for their own credential:
  install and upgrade planning answer 400 at `connectors.<id>.credential` instead of failing at the
  connector step, and the install wizard asks for it.
  
  Agent definitions take `skills.pinned` (at most 3 selected org skills or the agent's own skills,
  SKILL.md total at most 32 KB); a refused list is 400 `agent.pinned_invalid` with one detail per
  skill and reason.
  
  The `skills_catalog` snapshot records each skill's plugin, the pinned skills' bodies (read from
  storage at run start; a read failure fails the run with `storage.unavailable`) and, when a Claude
  Code skill is present, the tool-name map; `skill_load` resolves `<plugin>:<name>`.
  
  Requests render pinned skills (in the cached system segment, as mid-conversation notices and
  after compaction) and the tool-name map from the log; step replays report `pinned_changed` when a
  candidate pins other skills.
  
  The web import review shows a Claude Code plugin's translation report (five groups with localized
  reasons), its `repository` (display only), each skill's SKILL.md and the LICENSE text (collapsed),
  and "suggest pinned" checkboxes (expanded when the plugin has a SessionStart hook) sent as
  `pinnedSuggestions`; the catalog item shows the format, report and license (or that it was too
  long), and the marketplaces page lists the entries a refresh skipped with the reason (the first
  20 and how many more). Text with bidi or control characters gets a warning line.
  
  The agent page pins skills: selected skills each get a "pin" checkbox (a plugin's suggested skill
  is ticked when selected, a deselected skill is unpinned), with the token estimate, the count limit
  and an over-32 KB warning; `agent.pinned_invalid` shows one line per skill and reason. A reply that
  cannot read the agent's pinned skills, or whose pinned skills changed while it started, says so.
- 7f9627d: Sub-agents (package ecosystem phase C), additive:
  
  - Hooks: `HookScope.parent` and `UsageReportPayload.parent` (`HookParentScope`: the parent
    conversation, run and call) are set when a hook fires in a sub-agent; `conversationKind` stays
    `chat` for sub-agents.
  - `sandbox@1`: `SandboxProvider.concurrentExec`, an optional `tag` on `exec` (`SANDBOX_TAG_RE`) and
    `killTagged(handle, tags, signal)`. A provider that declares `concurrentExec` must implement
    `killTagged`, run commands of several holders at once and start a stopped instance idempotently
    under concurrent calls; a provider without them keeps today's one-command-at-a-time behavior.
  - Plugin agent templates: `agents/<name>.md` (`AgentTemplate`, `parseAgentTemplate`,
    `AGENT_TEMPLATE_LIMITS`, `AGENT_TEMPLATE_NAME_RE`, `AgentTemplateTier`), listed in `plugin.json`
    `agents` (`PluginAgentRef`) or scanned, at most 64 per plugin (`PLUGIN_MANIFEST_LIMITS.agents`);
    the `plugin.json` JSON Schema is regenerated.
- 85d8d40: Rename to extension terms before the first release
- e07bdd4: Package formats: plugin.json and marketplace.json replace the `capybara` package.json section,
  the bundle manifest and the catalog index.json, which are removed from the SDK.
