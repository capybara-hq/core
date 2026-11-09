# @capybara-hq/plugin-tools

## 0.1.0-rc.12

### Minor Changes

- 89278e7: The UI routes serve component contributions: the contributions list carries `kind: "component"`
  (listed with or without a server view), `ctx.ui.view` / `ctx.ui.action` accept ids in
  `permissions.ui.components` and such a view is served like a view of its slot (the slot's role and
  scope rule decide access). Only a component's view may carry `data` (a plain view's or action's
  `data` is 502 `ui.invalid_view`). A tool's `ToolResult.card` may name a component card. The UI
  arrangement gains `{ use }` for single slots (`shell.brand`, `conversation.empty`,
  `conversation.composer.frame`): the org's entry, else the platform's, picks the winner; `use: null`,
  no entry or a `use` naming a contribution not available in the org is the built-in. The
  contributions list shows at most the winner of a single slot, and `GET …/ui/arrangement` lists a
  single slot as `{ slot, candidates, use, followsPlatform }`. `use` on a list slot and `hidden` /
  `order` on a single slot are 400 `validation_failed`. `capybara-plugin check` (`perm-ui`) accepts
  component ids for `ctx.ui.view` / `ctx.ui.action`.
- 810e10a: `capybara-plugin pack` builds a plugin's client code (`src/client.ts[x]`, `client/styles/*.css`,
  `client/assets/**`) into `dist/client/` with a sha384 per file and writes `extension.client`;
  `capybara-plugin check` gains `client-import-forbidden`, `client-css-remote`, `client-size`,
  `client-api-version`, `client-undeclared`, `appearance-invalid` and the warnings
  `client-css-selector` and `ui-part-unknown`.

### Patch Changes

- ef60eb4: `capybara-plugin guide` fills `{{mode}}` with the mode rendered, as the kernel's guide route does,
  so it is no longer reported unresolved; `--var mode=…` is refused in favour of `--mode`.
- e531e6d: The SDK exports `UI_PARTS`, the catalog of built-in elements (`data-cap-part`) plugin CSS may
  select; `capybara-plugin check` reports `ui-part-unknown` against it.
- eaa7768: `client-css-remote` now lets a stylesheet's `url()` name only a file of `client/assets`
  (`../assets/<path>`), a `data:` URL or a `#fragment`; any other relative path is refused too, as
  the kernel refuses it at import. A stylesheet may not contain non-ASCII whitespace, zero-width
  characters or U+FEFF, nor use `image-set()`, `-webkit-image-set()`, `cross-fade()`, `element()`,
  `paint()`, `src()` or `image()` (escapes decoded). Asset paths may use only letters, digits, `.`,
  `_`, `-` and `/`.
- 5d464ce: The client stylesheet rule is one function in the SDK: `clientCssProblem` (with `wrapClientCss`, the
  `@layer extensions` wrap the packer stores). `capybara-plugin pack` runs it on the file as it stores
  it and the kernel's import runs it on the stored bytes, so a plugin that packs cleanly imports
  cleanly: a broken `url(` fragment, a bad url token or a brace that would end the
  `@layer extensions` block early is refused at pack time (`client-css-remote`), not only at import.
  The packer no longer loads the kernel for this.
- Updated dependencies [c4b4f6f]
- Updated dependencies [571318f]
- Updated dependencies [f172ba6]
- Updated dependencies [f2786a6]
- Updated dependencies [b03397f]
- Updated dependencies [56fc173]
- Updated dependencies [ad030b1]
- Updated dependencies [232191e]
- Updated dependencies [bb622c4]
- Updated dependencies [38e9f9b]
- Updated dependencies [44fe453]
- Updated dependencies [8a3472b]
- Updated dependencies [afeb135]
- Updated dependencies [363a2d3]
- Updated dependencies [914e022]
- Updated dependencies [89278e7]
- Updated dependencies [460567f]
- Updated dependencies [ec5f411]
- Updated dependencies [107a004]
- Updated dependencies [25e6ef3]
- Updated dependencies [e531e6d]
- Updated dependencies [5d464ce]
- Updated dependencies [8c49d09]
  - @capybara-hq/kernel@0.1.0-rc.15
  - @capybara-hq/plugin-sdk@0.1.0-rc.11

## 0.1.0-rc.11

### Minor Changes

- ba8ebaf: Setup guides v2: `capybara-plugin pack` / `check` ship and validate the Markdown guide documents
  `guides/<id>.md` and `guides/<id>.zh.md` with the SDK validator (errors fail; warnings such as a
  text variable outside quotes in a yaml block are printed as `plugin-pack-guide` and fail
  nothing; plugin check ids must be in the extension's `permissions.setupChecks`). The new
  `capybara-plugin guide <id>` command prints a guide rendered for a locale, mode, audience and
  variable values. `PackResult` gains `warnings`. The v1 template files are no longer read.
  The permission check gains `perm-setup-check`: every `ctx.setup.check(id, …)` id must be listed in
  `permissions.setupChecks`.

### Patch Changes

- Updated dependencies [848fb39]
- Updated dependencies [2f01b01]
- Updated dependencies [155c1cf]
- Updated dependencies [70a50f5]
- Updated dependencies [6622107]
- Updated dependencies [70a50f5]
- Updated dependencies [aa81e5a]
- Updated dependencies [2219734]
  - @capybara-hq/kernel@0.1.0-rc.14
  - @capybara-hq/plugin-sdk@0.1.0-rc.10

## 0.1.0-rc.10

### Minor Changes

- adfc0af: `capybara-plugin check` reports UI slot problems: a slot this SDK does not know (`ui-slot-unknown`), an `after` that is no anchor of the slot (`ui-slot-anchor`) and a deprecated `place` (`ui-place-deprecated`, a warning).

### Patch Changes

- Updated dependencies [ec79610]
- Updated dependencies [0a5b15d]
- Updated dependencies [c12e7a7]
- Updated dependencies [17fdfb1]
- Updated dependencies [0e765e2]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9
  - @capybara-hq/kernel@0.1.0-rc.13

## 0.1.0-rc.9

### Minor Changes

- 6d9a256: `capybara-plugin pack` ships a plugin's themes (`themes/*.json` or `manifest.themes`) with the fonts
  and logos they reference, and a plugin may hold only themes. `capybara-plugin check` adds the
  "Themes" check: `theme-invalid`, `theme-readability` and `theme-asset` (the 16 MB asset limit is
  summed over the plugin's themes).

### Patch Changes

- Updated dependencies [bbd508e]
- Updated dependencies [00e742e]
- Updated dependencies [b2b3faa]
- Updated dependencies [f120273]
- Updated dependencies [2191e44]
- Updated dependencies [c489ee6]
- Updated dependencies [c1c7b0f]
- Updated dependencies [ff5e3bf]
- Updated dependencies [00e742e]
- Updated dependencies [0158d0c]
  - @capybara-hq/kernel@0.1.0-rc.11
  - @capybara-hq/plugin-sdk@0.1.0-rc.8

## 0.1.0-rc.8

### Minor Changes

- 2435645: `capybara-plugin marketplace --write` fills each entry's `icon` with the repository path of the
  plugin's `plugin.json` `icon` (`./plugins/<dir>/<icon>`) and refreshes it on listed entries like
  `summary` / `displayName` (`marketplace-display-stale` in `--check`).
- d38fcfd: `capybara-plugin pack` (and so `capybara-plugin check`) ships a plugin's setup guide template
  files and refuses a missing, oversized or binary one, a placeholder the guide's place does not
  define (in a file or a step), and a `channel-connection` guide without an extension. The `fake-im`
  test plugin carries a channel setup guide with a file per inbound mode.

### Patch Changes

- Updated dependencies [6599de8]
- Updated dependencies [2de4f26]
- Updated dependencies [dbea14d]
- Updated dependencies [fa23383]
- Updated dependencies [eb83fb5]
- Updated dependencies [09dea3e]
- Updated dependencies [c85f0b6]
- Updated dependencies [cafa6e4]
- Updated dependencies [c3e12b3]
- Updated dependencies [60ce217]
- Updated dependencies [3cbf6e8]
- Updated dependencies [5ec789c]
- Updated dependencies [ff9cd78]
- Updated dependencies [2435645]
- Updated dependencies [2435645]
- Updated dependencies [ebe127f]
- Updated dependencies [48b244e]
- Updated dependencies [f74afee]
- Updated dependencies [d6fd4a9]
- Updated dependencies [733a954]
- Updated dependencies [a4ab6e3]
- Updated dependencies [f035baa]
- Updated dependencies [0e8592b]
- Updated dependencies [cb6f42d]
  - @capybara-hq/kernel@0.1.0-rc.10
  - @capybara-hq/plugin-sdk@0.1.0-rc.7

## 0.1.0-rc.7

### Patch Changes

- 812318c: New package `@capybara-hq/device`: the `capybara-device` program with `login`, `logout`, `status`, `start`, `stop`, `drain` and `policy`: the connection to the deployment, operation dispatch, results kept across reconnects, a local command log, and the OS sandbox mode (every command inside `@anthropic-ai/sandbox-runtime`: writes only under the environment directory, secret paths unreadable, network limited to the local policy intersected with the environment's egress). The plugin-tools dependency check can hold a package to the plugin-sdk-only boundary (`deviceDirs`).
- Updated dependencies [fe7c389]
- Updated dependencies [cfc888b]
- Updated dependencies [60fe3b6]
- Updated dependencies [c505b45]
- Updated dependencies [af3c477]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/kernel@0.1.0-rc.9
  - @capybara-hq/plugin-sdk@0.1.0-rc.6

## 0.1.0-rc.6

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

### Patch Changes

- Updated dependencies [4a92acb]
  - @capybara-hq/plugin-sdk@0.1.0-rc.4
  - @capybara-hq/kernel@0.1.0-rc.6

## 0.1.0-rc.5

### Minor Changes

- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- 99a00cd: Platform and org layering: org admins can switch off `all` plugins and components, deployment config
  fields carry org levels with per-org copies and an effective config delivered to every org-bound
  extension call, and org admins can turn off single extension tools.
- fddab56: `capybara-plugin check` warns (`plugin-org-override-unbound`) when an extension has an org-overridable deployment field but no tool, UI view, action, hook or org-aware extension point to carry the per-call config.

### Patch Changes

- 2a12327: Marketplace entries accept `deprecated: true | { reason? }` (SDK `MarketplaceEntry.deprecated`,
  normalized by `marketplaceEntryDeprecation`; JSON Schema regenerated). A maintainer sets it by hand
  on a published version's entry; `capybara-plugin marketplace --write` keeps it, and the `--base`
  integrity rules ignore it. The kernel returns `deprecated` on marketplace entries, never reports a
  deprecated version as newer or as an item's latest marketplace version, picks the newest stable
  non-deprecated compatible version when an import names none, and refuses importing or requesting a
  deprecated version with 409 `marketplace.entry_deprecated`. The market lists show the newest stable
  version on each row (prereleases fold into 其他版本 unless no stable version can be imported) and
  list deprecated versions under 其他版本 as 已废弃, with the reason, not importable.
- Updated dependencies [49ae0b5]
- Updated dependencies [f222ff8]
- Updated dependencies [d423777]
- Updated dependencies [3a4b54b]
- Updated dependencies [0f383d7]
- Updated dependencies [8f7a0a5]
- Updated dependencies [da49ebd]
- Updated dependencies [90c6125]
- Updated dependencies [16225b1]
- Updated dependencies [3c0ad62]
- Updated dependencies [789068d]
- Updated dependencies [7c8d05e]
- Updated dependencies [abc772e]
- Updated dependencies [8ee4c6c]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
- Updated dependencies [3adad42]
- Updated dependencies [9f554a3]
- Updated dependencies [8fd18a1]
- Updated dependencies [9e90494]
- Updated dependencies [fddab56]
- Updated dependencies [e40774d]
- Updated dependencies [99a00cd]
- Updated dependencies [e0a0d60]
- Updated dependencies [ffc33a2]
- Updated dependencies [45d7275]
- Updated dependencies [5ac4bba]
- Updated dependencies [2fb7d41]
- Updated dependencies [2321382]
- Updated dependencies [3c45446]
- Updated dependencies [cc21d5c]
- Updated dependencies [a965a1a]
- Updated dependencies [7278dec]
- Updated dependencies [bdf5eba]
- Updated dependencies [6b4da7f]
- Updated dependencies [703c779]
- Updated dependencies [77de995]
- Updated dependencies [11f56fa]
- Updated dependencies [927fad3]
- Updated dependencies [7a1e1ae]
- Updated dependencies [0e38b13]
- Updated dependencies [cfee6f0]
- Updated dependencies [26e8757]
  - @capybara-hq/kernel@0.1.0-rc.5
  - @capybara-hq/plugin-sdk@0.1.0-rc.3

## 0.1.0-rc.4

### Minor Changes

- 517ca1e: The packer writes an extension's config schemas into `plugin.json` as `extension.configSchemas`
  (`configJsonSchema`, with the `x-ui` hints) and refuses invalid hints, including `options` /
  `presets` on a secret. `capybara-plugin check` gains "Config forms" (`plugin-config-ui`,
  `plugin-config-labels`: a published plugin labels every rendered config field in zh and en) and
  `release-display-name` (a published plugin's `plugin.json` needs `displayName`).
  `importPluginExtension`, `extensionConfigSchemas` and `missingConfigLabels` are exported.
  
  Compatibility (pre-1.0 ruling): a plugin packed by this version that declares config carries
  `extension.configSchemas`, which an older kernel refuses ("unrecognized key" from its strict
  section parser) rather than through the SDK range. Kernel and plugins move together before 1.0,
  so upgrade the kernel before importing plugins packed by this version.

### Patch Changes

- 9e9ce5b: Config forms review fixes. Kernel: a config UI hint conversion that throws (a hand-made package)
  no longer fails the org extension list, the org config refusal or the channel connection schema:
  one never-throwing conversion serves the plain schema (hints stripped), else none, with one
  warning per schema. Plugin-tools: the packer refuses a packed `plugin.json` whose text is over
  `PLUGIN_MANIFEST_LIMITS.manifestChars`. Web: saving a replaced secret resets the deployment config
  form even when the view comes back unchanged; the install wizard and the upgrade dialog title the
  extension config card with its display name.
- f015dff: Two migration numbering rules: `capybara-plugin check` reports two files of one migrations
  directory that share a number (`migration-duplicate-number`), and `--base <ref>` also fails when
  the diff adds a migration numbered at or below the highest number of its directory at `<ref>`
  (`migration-number-behind-base`; `checkMigrationNumbers` / `diffMigrationNumbers`).
- Updated dependencies [ce0e90c]
- Updated dependencies [9d134ee]
- Updated dependencies [0344386]
- Updated dependencies [1e092a6]
- Updated dependencies [9e9ce5b]
- Updated dependencies [0ec51d1]
- Updated dependencies [8e43ed7]
- Updated dependencies [9b89920]
- Updated dependencies [258d286]
- Updated dependencies [69b3bbe]
- Updated dependencies [489d640]
- Updated dependencies [58d08b1]
- Updated dependencies [70688ca]
- Updated dependencies [49fa38b]
- Updated dependencies [0f1507e]
- Updated dependencies [80f4844]
- Updated dependencies [76da814]
- Updated dependencies [8e928cb]
- Updated dependencies [3455513]
- Updated dependencies [81adaff]
- Updated dependencies [4ef89b8]
- Updated dependencies [c01c117]
- Updated dependencies [f28ed05]
- Updated dependencies [2bd8351]
- Updated dependencies [c9c8625]
- Updated dependencies [8f7ba64]
- Updated dependencies [8892d50]
  - @capybara-hq/kernel@0.1.0-rc.4
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

## 0.1.0-rc.3

### Patch Changes

- f2317ec: `capybara-plugin check` reports `plugin-tool-key-length`: the key `plugin__<extension>__<tool>` of
  every `ctx.tools.register` must fit in 64 characters (a name that is not a literal cannot be
  confirmed, like `perm-tools`).
- 72bada5: The `tool-error-actionable` check accepts `read` as an action verb in a `ToolError` message.
- Updated dependencies [8bf0b04]
- Updated dependencies [e1127f5]
- Updated dependencies [307c611]
- Updated dependencies [1beea7e]
- Updated dependencies [56e83dd]
- Updated dependencies [48d3983]
- Updated dependencies [a1bfe76]
- Updated dependencies [0f4b28a]
- Updated dependencies [8881b9a]
- Updated dependencies [32580d3]
- Updated dependencies [75b1aaf]
  - @capybara-hq/plugin-sdk@0.1.0-rc.1
  - @capybara-hq/kernel@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- 6ad094b: `capybara-plugin pack --bootstrap` (and its `--root`, `--registry` and `--npm-token` options) and
  `packBootstrap` are removed: a starting kernel downloads the bootstrap plugins itself. The pinned
  npm download `downloadPinnedNpmPackage` stays (`check:bootstrap --network` uses it).
- Updated dependencies [75d7a0c]
- Updated dependencies [e69c9d6]
  - @capybara-hq/kernel@0.1.0-rc.1

## 0.1.0-rc.1

### Patch Changes

- 1a22b92: `createDualReplicaHarness` works when `@capybara-hq/testing` is installed from npm: when an
  extension entry is a TypeScript file (the plugin under test by path, `fakeExtensionEntry(...)`),
  each replica runs under tsx, now a dependency of this package and resolved from it, so the
  plugin's `./x.js` imports map to `.ts` and the fake extensions under `node_modules` load. A plugin
  repository no longer needs `NODE_OPTIONS: "--import tsx"`; the plugin-tools README says so.
