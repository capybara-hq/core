# @capybara-hq/capybara

## 0.2.0

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
- 452b6e4: Sub-agents (package ecosystem phase C): agents can dispatch sub-agents with the builtin `agent` tool,
  plugins can ship agent templates, and a conversation's sandbox runs the commands of parallel
  sub-agents concurrently. The Claude Code plugin import also brings in `agents/*.md`, and with
  superpowers' `subagent-driven-development` a small plan runs end to end.
  
  The kernel shares a conversation's sandbox between up to `sandbox.maxConcurrentCommands` holders
  (new, hot, default 6) under shared leases, keeps lifecycle changes exclusive, and kills only a
  crashed holder's commands by their tag.
  
  Rolling upgrade: finish it before anyone uses sub-agents. A replica of an older version re-enqueues
  the sub-agents it resumes (an approval decided there, its sweeps) on the ordinary run queue and runs
  them with the parent's definition and a sandbox of their own, and it resumes parents waiting on
  sub-agents early; the new wait sweep repairs the unpaired `agent` calls this can leave. Older
  replicas also don't read the per-holder sandbox records; new holders
  write the old busy marker (value `v2`) as well, so an older replica that takes a sandbox after a new
  holder crashed still kills the leftover commands. Anything that marker misses runs until the
  in-sandbox time limit (`sandbox.limits.maxCommandSeconds`).
  
  Agent definitions gain an optional `subagents` block (general-purpose, plugin and inline templates,
  allowlisted org agents, `dispatchable`), checked on save (`agent.subagents_invalid`), and the
  kernel declares the model purposes `subagent_fast`, `subagent_standard` and `subagent_capable`.
  
  The builtin tool `agent` (always loaded under `tool_search`, default policy `allow`) lists the
  agent's sub-agent roster in its description, with owner and plugin text made inert (one line per
  entry, `<` / `>` shown as `‹` / `›`).
  
  An `agent` call dispatches its sub-agent as a run of a read-only child conversation (messages to
  it are refused with `conversation.read_only`, 409) on the new queue `cap-kernel-subagent-runs`;
  the parent waits and gets the child's final reply as the tool result. Every dispatch is audited
  `subagent.dispatched`. An empty roster offers no `agent` tool.
  
  The wait sweep repairs sub-agent runs: a child whose enqueue was lost is enqueued again, a running
  child without job or lock fails `run.orphaned`, the children of a finished parent are stopped, and
  a parent whose resume was lost resumes once. A sub-agents wait timeout stops that step's children.
  A child stopped outside its worker reports to its parent at once.
  
  Sub-agent limits per parent run: `subagents.maxConcurrentPerRun` (4), `subagents.maxDispatchesPerRun`
  (50) and `subagents.maxTokensPerRun` (5 000 000), all hot, with per-organization values in the
  deployment setting `subagentLimitOverrides`; calls beyond them are refused with an actionable text,
  and the `agent` tool description shows the organization's concurrency limit. Every child model
  call (compaction included) adds its tokens to the parent run's counter; at the cap a running child
  ends with `run_finished { reason: "budget" }`. A child stopped by its parent's sub-agents wait
  timeout reports `timed out`, and a lost timeout job is recovered by the wait sweep through the new
  `runs.wait_expires_at` (migration 0054). Migration 0055 indexes the parent links, so deleting a
  conversation never scans every child or dispatch row.
  
  Sub-agents' permissions and approvals: a child's policy is the parent agent's current version with
  the frozen template overlay on top; its approvals and questions go to the person who started the
  parent run, appear in the parent conversation as `subagent_waiting` (and as the usual cards in the
  IM thread of a channel conversation, updated once the child is done), and link from the inbox to
  the parent (`ApprovalView.parentConversationId`). "Approve for this conversation" on a child is
  stored on the parent conversation. Hooks fire in sub-agents with `parent` set, `usage.report`
  payloads of a sub-agent carry `parent`, and the parent's `agent` result is audited `tool.called`
  and fires `tool.postExecute`.
  
  Other org agents can be dispatched as sub-agents when the parent's owner allowlists them, they opt
  in with `subagents.dispatchable`, and the person who started the conversation can use them; the
  gates are checked at every dispatch and follow-up (a refusal is audited `subagent.refused`). Such
  a sub-agent runs the agent's version frozen at its first dispatch, with the starter's personal
  credentials, approvals and grants for that agent, and the parent's policies on top of its own.
  
  Stopping a run stops its sub-agents: a parent stopped while it waits gets the stop text in its open
  `agent` calls (audited and passed to `tool.postExecute`), every terminal state of a parent (its
  deadline included) stops its active children, and removing a member stops their sub-agent runs too.
  
  `GET /conversations/:id/subagents` lists a conversation's sub-agents (status, tool calls, usage,
  pending approvals and questions), `GET /conversations/:id/usage` sums a conversation's usage with its
  sub-agents', the conversation view gains `parentConversationId` and `subagentType`, a sub-agent's
  sandbox status is its parent's, a child is opened through its parent conversation, and the parent's
  stream carries an ephemeral `subagent_progress` message after each sub-agent step.
  
  Plugins ship agent templates as `agents/<name>.md` (listed in `plugin.json` `agents` or scanned):
  the packer ships and checks them, the import review lists them (`agentTemplates`, part of
  `reviewHash` when there are any), and an org install creates one org template per plugin and name
  (component `agent_template`, action `agents.manage`). Upgrades add a version to changed templates
  and list them in the diff, rollbacks write the previous definition back, and uninstalling keeps a
  template an agent selects (`used_by_agents`).
  
  Claude Code plugins' `agents/*.md` are imported as agent templates (`<plugin>:<name>`): tools go
  through the Claude tool-name table, model aliases map to tiers, and the report says what was
  dropped or ignored (`agent_imported`, `agent_invalid`, `agent_tools_unmapped`,
  `agent_model_mapped`, `agent_skills_truncated`, `agent_field_ignored`). The Claude Code tool-name
  map now points `Task` / `Agent` at the `agent` tool when the agent has it; conversations get the
  new map with their next skills snapshot. `capybara plugins import` prints agent templates.
  
  Replay and evals cover sub-agents: a parent's full-run replay returns the recorded `agent` results
  and starts no child; a sub-agent's run can be added as an eval case (under the parent's agent, or
  the dispatched org agent), replays from its logged definition and preamble, and reports the new
  drift reason `subagent_changed` when a candidate's effective definition differs; the trajectory
  links each `agent` call to its sub-agent and back.
  
  A translated Claude plugin whose agents all fail translation now imports with `agent_invalid`
  items (raw `agents/*.md` files are never read as templates); `*` in an agent's tools and a pattern
  in `disallowedTools` are reported (`agent_tools_inherited`, `agent_tools_narrowed`).
  
  `GET /orgs/:orgId/agent-templates` lists the organization's installed agent templates (for the
  agent editor, action `agents.create`), and the organization's catalog item detail returns the
  plugin's agent template files (`agents`).
- 85d8d40: Rename to extension terms before the first release
- e07bdd4: Package formats: plugin.json and marketplace.json replace the `capybara` package.json section,
  the bundle manifest and the catalog index.json, which are removed from the SDK.
- Updated dependencies [dad2a4f]
- Updated dependencies [89b4521]
- Updated dependencies [c2c826b]
- Updated dependencies [d682a55]
- Updated dependencies [9a5a340]
- Updated dependencies [452b6e4]
- Updated dependencies [85d8d40]
- Updated dependencies [e07bdd4]
- Updated dependencies [141d834]
- Updated dependencies [329db81]
- Updated dependencies [9493b97]
- Updated dependencies [21b1385]
  - @capybara-hq/kernel@0.2.0
