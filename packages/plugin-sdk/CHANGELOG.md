# @capybara-hq/plugin-sdk

## 0.1.0-rc.22

### Minor Changes

- caa4575: Auto mode replaces the sandbox tiers. `SandboxLimits` now carries `mode` (`auto` / `sandbox`) and
  `network` (`{ kind: "open-public" | "allowlist", hosts }`) instead of tiers, egress and allowlists;
  the device protocol reports a `mode` feature and a `{ mode, allowedDomains }` policy summary, and
  the policy op may only narrow to `sandbox`. `ModelCallPurpose` and `UsagePurpose` gain `review`.
  Removed: `SandboxTier`, `SANDBOX_TIERS`, `isSandboxTier`, `compareTiers`, `tierAtMost`, `minTier`,
  `DEV_HOSTS`, `UNSANDBOXED_NOT_ALLOWED_MESSAGE`, `DeviceRemoteGrants`, and the old limit fields
  (`egress`, `allowHosts`, `tier`, `defaultTier`, `allowUnsandboxed`, `devHosts`). A provider that
  ignores the new fields runs as an allowlisted sandbox.

## 0.1.0-rc.21

### Patch Changes

- f78281b: A connector template and a custom connector can carry `git: { hosts: [{ host, username }] }`, the
  git hosts the connector's credential serves in sandboxes. Adds `GitSourceSchema`, `parseGitSource`,
  `validateGitSource` and `GIT_HOST_USERNAMES`; `validateConnectorTemplate` checks the field.

## 0.1.0-rc.20

### Minor Changes

- 76828c0: Device policy ops carry an op id. The device protocol's `policy` op now requires `opId` (non-empty,
  no `:`, at most 128 characters); the new `policyStatus` op asks a device what became of an op id
  (`applied`, `refused`, `started` or `unknown`, with its policy summary now); a hello may carry
  `recentOps`, the outcomes of the latest 100 policy ops; the new feature `policyOpId` announces all
  three. `capybara-device` logs each policy op in `policy-ops.json` next to `policy.json` (`started`
  before the change, then `applied` or `refused`; the last 100 kept), answers a repeated op id from
  that log without applying it again, and reports the log in every hello. The kernel sends its op id
  with each `policy` op.
  
  The SDK's hello parser keeps one `recentOps` entry per op id (the last one listed). `capybara-device`
  keeps a refusal's message in the log cut to 500 characters, never logs an applied op as refused
  when releasing the policy lock fails after the write, and keeps an op the log already says was
  applied as applied.

## 0.1.0-rc.19

### Minor Changes

- da677b6: context@1, conversation source, lifecycle hooks: the `context@1` extension point and provider types,
  `ToolSpec.sources` with `ToolCallContext.source`, `ownerAccountId` and `role`, and the observe-only
  mounts `org.member_removed`, `agent.deleted` and `org.deleted`.

## 0.1.0-rc.18

### Patch Changes

- 67e6ad5: A local OS-sandboxed device now kills what a foreground command leaves running (`server &`,
  `nohup …`) when the command ends, by its process group and by a per-command marker for processes
  that left the group. Inside the sandbox no later command could signal them, so they leaked. A
  background task launch, whose command starts with the new `BACKGROUND_LAUNCH_LINE`
  (`@capybara-hq/plugin-sdk`), keeps what it starts. The `Bash` description tells the model to use
  `run_in_background` for servers and watchers.
- e76028b: ScheduleCalendar: the scheduled task runs of a week or a month (time grid with a now line, three blocks side by side then +N, a dense lane, 6 × 7 month cells, the phone agenda, roving keyboard focus, loading, empty and load-failed states); the layout.calendar-* sizes and the ink / fail on hover and selected contrast pairs (also in the SDK's theme readability check)

## 0.1.0-rc.17

### Patch Changes

- 8471657: A local policy change made on the machine (`capybara-device policy ...` while the service runs, a
  flipped localhost proxy guard, a new tier ceiling) reaches the deployment at once: the device
  pushes its new summary in a `policy` frame (new in the device protocol), and the kernel stores it
  as it stores the hello's, so the device page and the next `device_paths` line show it.
- a3ca5ef: The super admin sets the platform's sandbox levels (`sandbox.tiers.max`, `default`,
  `allowUnsandboxed`) on the admin settings page (`PUT /api/v1/admin/settings` `sandboxTiers`). A field
  set in the startup config (env, file or Nacos) wins and is read-only there; an API token or the
  Platform tool may only lower them. The dev hosts preset (`DEV_HOSTS`) adds `storage.googleapis.com`,
  where Playwright's Chromium download (Chrome for Testing) is served from.

## 0.1.0-rc.16

### Minor Changes

- 2682d5f: Agent templates turn skills off with `disallowedSkills` (`<plugin>:<name>`, `<plugin>:*` or a bare
  `<name>`, at most 64; `isDisallowedSkillRef`) instead of selecting them: `selectedSkills` is
  removed. Creating an agent from a template turns those skills off and lists every name in `skills`
  as carried or unavailable; saving an agent as an org template writes its off-list.
- 2e52ca1: Network asks: `ExecResult.network` reports the hosts a command was refused and the layer that
  refused them (`parseOpResult("exec")` keeps the valid entries, at most 20, and drops a malformed
  report); the device hello may carry `features` and a local policy summary; a new device op `policy`
  edits a device's allowed domains; exec args may carry run or task `grants`; `SandboxActor.runId`;
  the `approval` card gains `scopeLabels` and the `skipped` state.
- 8fa0e32: Sandbox tiers: `SandboxTier` (`strict` < `dev` < `open`), `SANDBOX_TIERS`, `isSandboxTier`,
  `compareTiers`, `tierAtMost`, `minTier` and the dev hosts preset `DEV_HOSTS`. `SandboxLimits`
  requires `tier` and `devHosts` and may carry `defaultTier` and `allowUnsandboxed` (local exec args:
  whether the command may run without a sandbox; absent = no), with the refusal text
  `UNSANDBOXED_NOT_ALLOWED_MESSAGE`; `SandboxProvider` gains the optional
  `update(h, limits, signal)` and `limitsApplyAt`. Device protocol: the local policy summary replaces
  `network` with `tier` (absent = follows the org), `effectiveTier`, `isolation`, `localhost` and
  `unixSockets`; the hello feature `tiers`; the `policy` op takes `tier` (null = follow the org) and
  `isolation: "sandbox"` instead of `network`. `DeviceNetworkMode` is removed.
- 95fc4b0: Skills are on by default and pinning is gone. Every skill on in an org is on for every agent unless
  the agent's new `disabledSkills` turns it off (a plugin's skills by name, a whole plugin as `"all"`
  including skills it gains later, or a skill without a plugin by id); builtin skills, the agent's
  own and its shared skills cannot be turned off. `skills.orgSkills` and `skills.pinned` are removed
  from the agent definition (refused on save; migration 0116 rewrites every agent version), run start
  no longer injects pinned skill bodies (an old conversation gets a "Pinned skills removed" notice),
  and `agent.pinned_invalid` is gone. A sub-agent template's `skills` become one logged line telling
  the child to load them with `Skill` first. `plugin.json` `skills[].pinned` and the import confirm's
  `pinnedSuggestions` are removed; the skill APIs drop `suggestPinned`, `entryBytes` and
  `tokenEstimate` and the library list gains `builtin`; the Claude Code import reports a
  `session_start_hook` warning instead of a pin hint. The Platform tool's `agents.create` /
  `agents.update` take `disabledSkills`, and `platform.me` lists the agent's skills.

## 0.1.0-rc.15

### Minor Changes

- ac35f95: Bootstrap manifest entries may be `builtin: true`: builtin in the catalog, imported after the
  extensions load (so they may ship skills), and a failure does not stop the start

## 0.1.0-rc.14

### Minor Changes

- 6a4ffff: New UI parts for theme plugins: `message.user.bubble`, `code-block`, `menu`, `segmented`,
  `stat-card`, `switch` (`aria-checked`) with `switch.knob`, `org-avatar` and `agent-chip`
  (`aria-pressed`); `message.assistant` promises `aria-busy` while its text streams, and the web sets
  it on the live reply. `UiPartState` gains `aria-checked` and `aria-pressed`.

## 0.1.0-rc.13

### Minor Changes

- 7423fa7: Question cards can be skipped and say a text reply works. `ChannelCard` kind `question` gains the
  state `skipped` (the person sent a message instead of answering) and `textReply?: "plain" |
  "mention"` (pending cards: the person may answer by replying in the DM, or in the group thread
  mentioning the bot). `questionRenderableInline(form, { textReply })` accepts a field with
  `allowOther` when the card has `textReply` (draw no Other button: Other is a plain reply), also for
  multi-select. `renderCardAsText` writes the hint line and the skipped label; channel plugins use
  `questionTextReplyHint` and `questionStateLabel` for the same copy (an unknown state returns itself).

## 0.1.0-rc.12

### Patch Changes

- bae65fe: Channel connections choose their inbound mode when they are created. The config UI hint
  `inboundModes` (connection level, top-level fields) ties a field to inbound modes: forms draw it
  only in those modes and require it there, and the kernel refuses a create, config change or mode
  switch that leaves a required field empty (`extension.config_invalid`). `inboundModeFields` and
  `missingInboundModeFields` read the hint. `POST /channels` takes `inboundMode`;
  `GET /channels/schema/:plugin` says whether webhook inbound is usable (`inbound`). A connection name
  nobody typed yet is reported unresolved as `no_name`. The fake-im fixture's `webhookToken` is
  webhook-only. 新建渠道 sends the guide's mode, follows it with the credential fields, and shows
  less noise before save.

## 0.1.0-rc.11

### Minor Changes

- f172ba6: Built-in elements carry the public `data-cap-part` hooks of the `UI_PARTS` catalog (`owner` is now a
  list of files, since one part can be drawn by several components); the design package adds
  `DecorationLayer`, `ReplaceableFrame` and `SafeModeBanner`, the `decoration` layering token,
  `Sidebar` `brand` and `AppShell` `capState` (`data-cap-state`). `check:ui-parts` enforces the hooks.
- 460567f: The `client` section of the plugin extension (`PluginClientSection`, `validateClientSection`,
  `CLIENT_LIMITS`, `CLIENT_ASSET_TYPES`, `CLIENT_API_VERSION`) and `suggestedAppearance` in
  `plugin.json` (`SuggestedAppearance`, `appearanceIssues`). `extension.client` needs
  `permissions.client: true` and the reverse.
- 107a004: Component contributions: `kind: "component"` in the manifest `ui`, listed in the new
  `permissions.ui.components`, which needs the new `permissions.client: true`.
  `validateUiContributions` checks both directions, refuses an id in more than one of
  `views` / `embeds` / `components` and a component with a `path`. `UiView` gains `data` (a
  `JsonValue`), accepted only by `validateUiView(view, { component: true })`, at most
  `UI_LIMITS.componentDataBytes` (32768) bytes of JSON.
- 25e6ef3: The UI slot catalog gains the `component` kind, single (replaceable) slots with `cardinality`,
  `replaceable` and `builtin`, and the slots `shell.brand`, `shell.overlay`, `conversation.empty`
  and `conversation.composer.frame`.
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.
- 5d464ce: The client stylesheet rule is one function in the SDK: `clientCssProblem` (with `wrapClientCss`, the
  `@layer extensions` wrap the packer stores). `capybara-plugin pack` runs it on the file as it stores
  it and the kernel's import runs it on the stored bytes, so a plugin that packs cleanly imports
  cleanly: a broken `url(` fragment, a bad url token or a brace that would end the
  `@layer extensions` block early is refused at pack time (`client-css-remote`), not only at import.
  The packer no longer loads the kernel for this.

### Patch Changes

- c4b4f6f: Applying a suggested appearance at org level reports `from` as the value in effect (the org's own
  entry, else the platform's) with `followsPlatform`, and pins nothing when the org follows a
  platform that already uses the suggestion. Replacements are listed and applied in plugin.json
  order (recorded at import in `catalog_item_versions.appearance_order`, since the jsonb manifest
  does not keep key order; the item detail and the org extension list show them in that order). A
  second ref to one slot is skipped as `not-eligible`, and `parsePluginManifest` refuses it
  (`shell.brand` and `shell.brand@1` in one `suggestedAppearance.replacements`).
- f2786a6: At org level, applying a suggested appearance judges the followed platform default theme by its
  eligibility: a stored default that is no longer eligible renders the built-in, so applying the
  plugin's theme is reported as a change. `permissions.client: true` without a client section is
  reported as "permissions.client is true but extension.client is missing".
- ec5f411: `validateClientSection` refuses an asset path with a segment outside `[A-Za-z0-9._-]` (such as a
  literal `%2e%2e`, which the kernel's exact-key delivery never serves) and an asset without a file
  name before its extension (`.png`). `validateUiView` refuses component view `data` that JSON would
  silently drop or rewrite (functions, NaN or Infinity, `undefined` in an array, Maps, Dates, cycles);
  an `undefined` object property is still accepted. A `permissions.client` without a client section
  is reported with the same plain text as the forward case.

## 0.1.0-rc.10

### Minor Changes

- aa81e5a: Setup checks contract: an extension registers the live rows of its setup guides with
  `ctx.setup.check(id, { place, run })` during `setup`, each id listed in the new
  `permissions.setupChecks` (`SETUP_CHECK_ID_RE`, at most 32; ids with `:` stay the kernel's).
  `run` gets the org, the extension's effective config, the locale, the mode, an abort signal and the
  target: a channel connection with its config, or a connector with its ids and OAuth client id
  (never the client secret or a member's token). Results are `ok` / `failing` / `unknown` with plain
  text `reason` and `fix` (en required, zh optional, 300 / 500 characters) and no details field;
  `validateSetupCheckResult` returns a fresh copy or why it is invalid. `SETUP_CHECK_LIMITS` holds
  the run limits. A check never writes, passes `signal` on, does not retry and never puts a secret
  in its result.
- 2219734: Setup guides v2: a guide is a Markdown document `guides/<id>.md` (optional `guides/<id>.zh.md`)
  declared in `plugin.json` `setupGuides` as `{ id, place, template? }`. The SDK adds the place
  registry (`channel-connection`, `connector-template`; modes, audiences, typed variables), the
  parser (`parseSetupGuide`: title, `::: mode` / `::: audience` sections, `::check` lines, titled
  code fences), the validator (`validateSetupGuide`, including zh parity), the renderer
  (`renderSetupGuide`: substitution into the parsed tree, link policy, raw HTML as text, blocks) and
  the drift hash (`setupGuideHash`, code blocks and check lines only). The v1 steps-and-files format
  and its helpers are removed.

### Patch Changes

- 70a50f5: Add the `setup` agent docs topic: how an agent helps a person through a plugin's setup guide with
  the `setup` operations, and what stays with the person (secrets, OAuth consent, the guide ack).
  
  The `plugin-format` and `extensions` topics describe v2 setup guides (Markdown documents, places,
  sections, check lines) and setup checks (`ctx.setup.check`, `permissions.setupChecks`).

## 0.1.0-rc.9

### Minor Changes

- d495d7d: The `init` message to an embed carries `context` as `EmbedInitContext`, narrowed on `scope`: an org
  embed gets `{ scope: "org", orgId, conversationId? }`, a platform page of the admin console
  `{ scope: "platform" }` (no `orgId`).
- 18defa0: `platform.page` contributions are served to super admins on org-less routes under
  `/api/v1/admin/ui/` (`contributions`, `views/:plugin/:id`, `actions/:plugin/:id`,
  `embeds/:plugin/:id/token`, `stream`): the extension must be running (no org enablement applies)
  and gets the platform's deployment config. `UiRenderArgs` / `UiActionArgs` become unions narrowed
  on `scope`: the platform variant has `role: "superAdmin"` and no `orgId`. `EmbedClaims` gain
  `scope: "org" | "platform"` (`orgId` absent exactly for the platform scope); a platform token
  verifies only for a `platform.page` contribution while the account is still an active super admin,
  and an org token never verifies for one. `ctx.ui.invalidate` takes no `orgId` for a `platform.page`
  contribution (refreshing the admin console's stream) and throws when one is given.
- 0a35407: Add the UI slot catalog (`UI_SLOTS`, `uiSlot`, `parseSlotRef`, `PLACE_SLOTS`, arrangement keys).
- cf93278: The org UI routes gate every contribution by its slot: the slot's `minRole` (`org.settings.section`
  admin and above, `org.page` member and above, conversation and agent slots any member), then its
  scope (a readable conversation; an agent the caller can read in this org). `platform.page` is never
  listed or served through an org route. `GET /orgs/:orgId/ui/contributions` takes `?slot=` and lists
  `slot` and the resolved `after` anchor instead of `place`, ordered by extension name, then manifest
  order. Views, actions and embed tokens take `agentId` for `agent.detail.section`; embed claims carry
  it, and `ctx.ui.verifyEmbedToken` returns null when the current role no longer meets the slot's
  `minRole`. `UiRenderArgs` gains `slot`, `scope` and `agentId`; `EmbedClaims` gains `agentId`.
- 199f895: UI contributions name a slot (`slot: "conversation.panel"`, optionally `@<n>`, plus `after` for
  slots with anchors); `place` stays accepted as a deprecated input. `validateUiContributions` now
  covers only structural problems, and the new `resolveUiSlots` drops a contribution to an unknown
  slot or version instead of failing the extension. `normalizePlace` is removed.

### Patch Changes

- ec79610: One name: devices. The program says device everywhere: `credential.json` holds `deviceId` (a file
  from an older version is unusable: run `capybara-device logout` and log in again), the default
  directory is `~/capybara-device/<deviceId>`, the sign-in follows the kernel's `device_sign_in.*`
  error codes, and `status` prints `device`. SDK doc comments say device instead of environment.

## 0.1.0-rc.8

### Minor Changes

- c1c7b0f: Theme file format: `parseThemeFile`, `ThemeFileSchema`, `THEME_LIMITS`, `themeIdOf` and the
  `themes` field of `plugin.json` (a plugin may consist of themes only).
  A parsed theme holds only the file's own values; `mergeThemeSchemes` merges it onto the current
  built-in tokens (skipping overrides the built-ins no longer know), and
  `parseThemeFile(id, json, { readability: false })` re-reads a version already in a catalog without
  judging its readability again.
- ff5e3bf: Add theme asset checks: `sanitizeThemeSvg` (strict, namespace-aware SVG sanitizer that re-serializes
  the parsed tree), `checkWoff2`, `checkPng` and `validateThemeAssets`.
- 00e742e: Add `THEME_FONTS` (the built-in font stacks, generated from the design tokens) and the stored-theme
  re-validation helpers `canonicalThemeValue`, `isThemeFontFamily` and `isThemeAssetPath`.
- 0158d0c: Add the theme token allowlist (`THEME_TOKENS`, `THEME_OVERRIDABLE`, `THEME_CONTRAST`, `THEME_SEPARATION`) and `checkThemeReadability`, with the color math (`contrastRatio`, `oklabL`, `compositeOver`) moved into the SDK.

## 0.1.0-rc.7

### Minor Changes

- 09dea3e: A connector template file may say `"defaultEnabled": false`: the template then starts switched
  off in every org, even where its plugin is on, until an org admin switches it on, and while off it
  creates no connector and needs no org input (no 需要配置). Ignored for a builtin plugin and for a
  template the super admin gave its own scope.
- 60ce217: IM approval cards show what the web shows, never the raw call input: the approval card's
  `inputPreview` now carries one line, the tool's confirmation summary in the card language (a
  Platform operation's `summary`), else the tool's title and key argument (`Title: arg`), redacted
  and at most 300 characters; the full input stays behind the card's web link. `renderCardAsText`
  labels the line Summary / 摘要 and leaves it out when it is empty.
- 5ec789c: IM time zone and language per person: channel@1 `InboundSender` gains optional `timeZone` (IANA)
  and `locale` (`zh` / `en` or a BCP 47 tag). The kernel records on an IM `user_message` the
  platform's zone (when valid), else the account setting, else the org default, and the platform's
  language (`zh` / `zh-*` Chinese, any other tag English), else the UI language of the person's most
  recent web message in the org, else the org's `locale`. Any message without a language uses the
  latest web language the same way, and run start falls back to the author's settings for a message
  from an older log. The fake channel's sender profile takes `timeZone` and `locale`.
- 2435645: A `marketplace.json` entry may carry `icon`: an absolute `https://` URL whose path ends in `.svg` /
  `.png`, or a `./<path>.svg|png` inside a git marketplace's repository (read at the refreshed
  commit). Display only; the SDK exports `marketplaceEntryIcon`, `MARKETPLACE_ICON_RE` and
  `MARKETPLACE_LIMITS.iconBytes` (the plugin icon limit), and the JSON Schema has the field.
- ebe127f: OAuth connectors work with Slack-like token endpoints. A token response with `token_type: "user"`
  (Slack's `oauth.v2.user.access`) is accepted and sent as `Authorization: Bearer`, like `Bearer`;
  an `oauth_code` / `oauth_client` auth preset may list more accepted types in `tokenTypes`, and
  any other type is still refused (`unsupported_token_type`). A token endpoint error reported as
  HTTP 200 with `{ "ok": false, "error": … }` (or an `error` and no token) is a refusal with that
  code, like a 400: `invalid_refresh_token`, `token_revoked` and `token_expired` join `invalid_grant`
  in deleting the person's connection so they are asked to reconnect, transient codes such as
  `ratelimited` count as unavailable, and other codes keep the credential.
- d6fd4a9: `plugin.json` gains `setupGuides`: setup material a plugin ships for a place (`channel-connection`
  first), with localized plain-text steps and template files (`yaml` / `json` / `text`, optionally
  one per mode). The SDK exports the places, their modes and variables, the limits,
  `setupGuidePlaceholders`, `unknownSetupGuidePlaceholders`, `setupGuideModes`,
  `setupGuideFileProblem` and the pure renderer `renderSetupGuideText` (`{{name}}` placeholders, no
  other syntax; values escaped per language).

### Patch Changes

- c85f0b6: Connector templates shipped `"defaultEnabled": false` show up correctly in previews. Moving one
  from its own scope back to following its plugin lists the orgs it turns off in. A platform update
  no longer asks for input on an added template that is shipped off. An update that changes
  `defaultEnabled` on a template lists, for each org without a switch of its own, the template
  under `needsConfig` (now on) or under the new `turnedOff` (now off, with the agents using it and
  the connectors it keeps). OAuth hardening: an auth preset's `tokenTypes` refuses `DPoP`, and a
  token endpoint's HTTP 200 with RFC 6749's `temporarily_unavailable` or `server_error` counts as
  unavailable instead of a refusal.
- 3cbf6e8: Kernel-generated IM text speaks the person's language, not the org's: `/new`, `/env`, bind prompts
  and card-click replies use the sender's platform language, else the bound person's latest web
  message language, else the org's; delivered cards and notices use the language recorded on the
  conversation's latest user message (in a group thread, the person who triggered the run).
  `ChannelSendArgs.locale` carries that language to the extension.

## 0.1.0-rc.6

### Minor Changes

- c505b45: Add `SandboxRoots`, `DEFAULT_SANDBOX_ROOTS` and `rootsOf`, an optional `roots` on `SandboxHandle`, and the device protocol v1 frames with `parseDeviceFrame`.

### Patch Changes

- ebbfeb5: Sandbox tools use the instance's real paths: `validateSandboxPath`, `skillSandboxDir`,
  `skillSandboxPath` and `renderSkillBody` take an optional instance root, `validateSandboxPathShape`
  checks a path without its roots, and device protocol roots must be clean absolute paths; the
  kernel builds every model-visible path from the held instance's roots, tool descriptions say "the
  workspace directory", and each conversation records its environment's directories in an
  `environment_paths` system line on its first sandbox call and whenever they change.

## 0.1.0-rc.5

### Patch Changes

- f31ec88: Agent docs topics are titled "Authoring: ..." and the docs check catches both "in the code, not in the docs" and "in the docs, gone from the code".

## 0.1.0-rc.4

### Minor Changes

- 4a92acb: Model kinds and display fields on `ModelInfo`, an optional `embed` on `ModelProvider`, `{ orgId, config }` call options, `validateEmbedResult`, and an `embedding` usage purpose whose conversation fields are optional.
  
  `ctx.models.embed` / `describe` for extensions that declare embedding purposes in
  `permissions.models` (no longer reserved): the kernel resolves the org's model for the purpose,
  splits batches by `maxBatch`, validates results, records a `model_usage` row per call and delivers
  it through `usage.report` with purpose `embedding`. Each batch is limited by the new hot config
  `models.embedTimeoutMs`; `embed` takes an optional per-call `signal`. `capybara-plugin check` reports `ctx.models`
  without `permissions.models` as `perm-models` (was `perm-reserved`).
  
  `ctx.models.embed` fires the `model.request` hook once per call, before anything is sent, so policy
  hooks (DLP) see the texts sent to embedding vendors. `ModelRequestHookPayload` is now a union:
  `ModelCallRequestHookPayload` (steps, compaction, titles, `WebFetch`; the former interface) or
  `EmbeddingRequestHookPayload` (`purpose: "embedding"`, `orgId`, `extension`, `embeddingPurpose`,
  `provider`, `model`, `input`, `dimensions?`, `inputType?`, no conversation fields); narrow on
  `purpose` before reading `request`. A policy denial rejects the call with the new error code
  `model.hook_denied` (403; an extension route that lets it escape answers 403, not 500), writes a
  `hook.denied` audit row and records no usage. `model.response` does not fire for embeddings.

## 0.1.0-rc.3

### Minor Changes

- f222ff8: Agent templates describe a whole agent: `selectedSkills`, `connectors` (a connector template of the
  plugin, or a described need), `subagents` (general, template types, inline types), `modelRef`,
  `quickActions` and `instructionFiles`, all optional with limits; existing files parse unchanged.
  A connector entry may carry `policies` (tool name to `ask` / `deny`); an inline sub-agent's
  `tools` is optional (absent = all of the agent's tools, `[]` = none).
  A sub-agent dispatch resolves a template's `selectedSkills` names without pinning them.
- 7c8d05e: Extension points list the majors the kernel accepts (`EXTENSION_POINTS[name].majors`). The kernel
  refuses a plugin that provides an unsupported major (such as `sandbox@1`) with
  `extension.unsupported_extension_point` and asks it to upgrade.
- 2a12327: Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
  normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
  on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
  integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
  deprecated version as newer or as an item's latest marketplace version, picks the newest stable
  non-deprecated compatible version when an import names none, and refuses importing or requesting a
  deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
  version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
  list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- fddab56: Add `orgAccess(schema, "readonly" | "override")` and `orgAccessOf`: a deployment config field can allow an org to override it per call. `configJsonSchema` publishes the level as `x-org`, and `validateConfigUi` refuses `x-org` outside top-level deployment fields and on secrets marked `readonly`.
  
  Every call the kernel makes for an org carries the extension's effective deployment config for that org as `config` (optional in the types, so older extensions compile): `web-search@1` / `web-fetch@1` `search` / `fetch` args and `configured(orgConfig, config)`, `directory@1` `listMembers` args and `configured(orgConfig, config)`, `ToolCallContext`, `UiRenderArgs` (and so `UiActionArgs`), `FilePreviewArgs`, and a third hook handler parameter `call: HookCall` (`{ config }`).
- 99a00cd: Platform and org layering: org admins can switch off `all` plugins and components, deployment config
  fields carry org levels with per-org copies and an effective config delivered to every org-bound
  extension call, and org admins can turn off single extension tools.
- 2fb7d41: The SDK ships agent docs (`agent-docs/`: platform concepts, plugin format, skills, agent and
  connector templates, tool naming, writing an extension, one topic per extension point), served by
  the kernel's `AgentDocs`. `ExtensionPointInfo` gains `description`, and `package.json` is an
  exported subpath. `check:agent-docs` keeps the generated field tables in step with the schemas.
- 6b4da7f: `sandbox@2` replaces `sandbox@1`: a provider makes an environment's file system
  (`createFileSystem`, `destroyFileSystem`, `destroyFileSystemByName`, `FileSystemGoneError`) apart from
  its instances, which attach to it and may be destroyed while the files stay; `create` takes an
  optional `image` (without it the provider uses its own published image); skill paths carry a
  digest (`/skills/<name>@<digest12>/`).

## 0.1.0-rc.2

### Minor Changes

- 0ec51d1: Config UI hints: `ui(schema, hints)` attaches presentation hints (labels, help, widgets, options,
  sections, array items, presets, secrets drawn per item) to an extension config schema;
  `configJsonSchema` turns a config schema into the JSON Schema for forms (`x-ui`, `x-secret`,
  `x-hot`, titles from labels, no values under secrets) and `validateConfigUi` checks the hints.
  `secret()` now merges with existing meta. `plugin.json` accepts `extension.configSchemas`. The
  kernel's config JSON Schema now comes from the SDK (`hot` is emitted as `x-hot`).
  
  Compatibility (pre-1.0 ruling): a plugin packed by the new plugin-tools that declares config
  carries `extension.configSchemas`, which an older kernel's strict section parser refuses
  ("unrecognized key") rather than through the SDK range. Kernel and plugins move together before
  1.0, so upgrade the kernel before importing such plugins.
- 8892d50: Add the `web-search@1` and `web-fetch@1` extension points (`WebSearchProvider`, `WebFetchProvider`, `WebProviderError`, `isPublicHostname`), `ExtensionPointInfo.selection`, and the `web_fetch` model call purpose. A `web-fetch@1` provider that fetches from inside the deployment must refuse non-public addresses after DNS resolution (documented on `WebFetchProvider`).

## 0.1.0-rc.1

### Patch Changes

- 8bf0b04: The builtin tools take Claude Code's names: `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`,
  `Deliver`, `Skill`, `SkillWrite`, `AskUserQuestion`, `ReadToolOutput`, `ToolSearch` and `Agent`
  (formerly `sandbox_bash` … `sandbox_deliver`, `skill_load`, `skill_write`, `ask_user`,
  `read_tool_output`, `tool_search` and `agent`). Every description, error and system text that names
  a builtin uses the new names; a request recorded before the rename is rebuilt with the old texts,
  so it replays with no drift. Several parameters are renamed as well (see the builtin tool
  parameters changeset).
- 32580d3: Model-visible tool keys of connectors are `mcp__<slug>__<tool>` and those of extensions
  `plugin__<plugin>__<tool>` (aligned with Claude Code). The SDK exports `parseToolKey`,
  `connectorToolKey`, `extensionToolKey`, `ParsedToolKey` and `BUILTIN_TOOL_NAME_RE`; hook payloads'
  `toolKey` carry the new keys, so an extension that matches keys should use `parseToolKey`.
