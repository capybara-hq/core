# @capybara-hq/plugin-model-fake

## 0.1.0-rc.19

### Patch Changes

- Updated dependencies [da677b6]
  - @capybara-hq/plugin-sdk@0.1.0-rc.19

## 0.1.0-rc.18

### Patch Changes

- Updated dependencies [67e6ad5]
- Updated dependencies [e76028b]
  - @capybara-hq/plugin-sdk@0.1.0-rc.18

## 0.1.0-rc.17

### Patch Changes

- Updated dependencies [8471657]
- Updated dependencies [a3ca5ef]
  - @capybara-hq/plugin-sdk@0.1.0-rc.17

## 0.1.0-rc.16

### Patch Changes

- Updated dependencies [2682d5f]
- Updated dependencies [2e52ca1]
- Updated dependencies [8fa0e32]
- Updated dependencies [95fc4b0]
  - @capybara-hq/plugin-sdk@0.1.0-rc.16

## 0.1.0-rc.15

### Patch Changes

- Updated dependencies [ac35f95]
  - @capybara-hq/plugin-sdk@0.1.0-rc.15

## 0.1.0-rc.14

### Patch Changes

- Updated dependencies [6a4ffff]
  - @capybara-hq/plugin-sdk@0.1.0-rc.14

## 0.1.0-rc.13

### Patch Changes

- fa555e9: New script directive `slowtool:<ms>:<name>:<json>`: waits, then calls the tool (a message can arrive
  while the step streams).
- Updated dependencies [7423fa7]
  - @capybara-hq/plugin-sdk@0.1.0-rc.13

## 0.1.0-rc.12

### Patch Changes

- Updated dependencies [bae65fe]
  - @capybara-hq/plugin-sdk@0.1.0-rc.12

## 0.1.0-rc.11

### Patch Changes

- Updated dependencies [c4b4f6f]
- Updated dependencies [f172ba6]
- Updated dependencies [f2786a6]
- Updated dependencies [460567f]
- Updated dependencies [ec5f411]
- Updated dependencies [107a004]
- Updated dependencies [25e6ef3]
- Updated dependencies [e531e6d]
- Updated dependencies [5d464ce]
  - @capybara-hq/plugin-sdk@0.1.0-rc.11

## 0.1.0-rc.10

### Patch Changes

- Updated dependencies [70a50f5]
- Updated dependencies [aa81e5a]
- Updated dependencies [2219734]
  - @capybara-hq/plugin-sdk@0.1.0-rc.10

## 0.1.0-rc.9

### Patch Changes

- Updated dependencies [ec79610]
- Updated dependencies [d495d7d]
- Updated dependencies [18defa0]
- Updated dependencies [0a35407]
- Updated dependencies [cf93278]
- Updated dependencies [199f895]
  - @capybara-hq/plugin-sdk@0.1.0-rc.9

## 0.1.0-rc.8

### Patch Changes

- Updated dependencies [c1c7b0f]
- Updated dependencies [ff5e3bf]
- Updated dependencies [00e742e]
- Updated dependencies [0158d0c]
  - @capybara-hq/plugin-sdk@0.1.0-rc.8

## 0.1.0-rc.7

### Patch Changes

- Updated dependencies [09dea3e]
- Updated dependencies [c85f0b6]
- Updated dependencies [60ce217]
- Updated dependencies [3cbf6e8]
- Updated dependencies [5ec789c]
- Updated dependencies [2435645]
- Updated dependencies [ebe127f]
- Updated dependencies [d6fd4a9]
  - @capybara-hq/plugin-sdk@0.1.0-rc.7

## 0.1.0-rc.6

### Patch Changes

- Updated dependencies [c505b45]
- Updated dependencies [ebbfeb5]
  - @capybara-hq/plugin-sdk@0.1.0-rc.6

## 0.1.0-rc.5

### Minor Changes

- 40c8ee0: Tools are on by default: an agent has every builtin, every tool of the extensions enabled in the
  org and every tool of the org's connectors, and its definition stores only what it turns off
  (`disabledTools`, replacing the enabled `tools` list; migration 0092 rewrites stored agents and
  org-made templates to "nothing turned off"). A newly added builtin reaches existing agents; a
  connector the org sets up is on for every agent; tools that cannot run now are left out quietly.
  The Platform tool's agent operations and `platform.me` use the new shape. `createAgent` in
  `@capybara-hq/testing` takes `disabledTools`; model-fake calls a tool on its own only when a
  request offers exactly one.

### Patch Changes

- ca3c570: Agents know who they are and who they talk to (run context): run start writes a `run_context`
  event (the agent version's name and description, the org, today's date, the time zone and language
  of the person whose message started the run; a sub-agent's own name and who dispatched it), first
  in full, then only what changed; the model sees it as a system message at its position and in full
  again after a compaction summary. Every message records its sender (display name and org role; an
  anonymous IM guest by IM name) and a sender line names it when the sender changes. Messages take
  the browser's `timeZone` and `locale`; `GET` / `PUT /api/v1/me/preferences` sets a person's time
  zone, the org settings an org default (`timeZone`). The agent definition gains `description`
  (saved as a version; the profile PATCH no longer takes it). model-fake reads a message's script
  without the sender line.
- Updated dependencies [f31ec88]
  - @capybara-hq/plugin-sdk@0.1.0-rc.5

## 0.1.0-rc.4

### Minor Changes

- 0faae98: model-fake lists model kinds, serves a deterministic embedding model (`kind: "embedding"`, with
  `dimensions` and `maxBatch`) through `embed`, and reads its model list from the per-call config
  (the `models` field is overridable by an org).

### Patch Changes

- Updated dependencies [4a92acb]
  - @capybara-hq/plugin-sdk@0.1.0-rc.4

## 0.1.0-rc.3

### Patch Changes

- 12fd552: Marketplaces list one entry per plugin. `plugin.json` `description` accepts `{ en, zh? }` as well as a string (English; read it with the SDK's `pluginDescription`), and marketplace entries accept an optional `displayName: { zh, en }`. `capybara-plugin marketplace --write` keeps one entry per public plugin at its current version, with `summary` from the localized description and `displayName` from `plugin.json`, replacing a plugin's entry when its version moves; `--check --base` replaces `marketplace-append-only` with `marketplace-version-decrease` (an entry's version only increases) and `marketplace-integrity` (a published version keeps its integrity). `capybara-plugin check` warns, without failing, when a public plugin's description has no `zh` (`release-description-zh`; findings may now be warnings). The kernel returns an entry's `displayName` (null without one) and searches it, and a single-plugin git marketplace takes the summary and display name from `plugin.json`; a catalog item keeps the English description. The market lists show the display name, else the name. model-fake gets a Chinese description.
  
  `--write` also refreshes a listed entry's `summary` and `displayName` from `plugin.json` (`marketplace-display-stale` in `--check`), and `marketplace-version-decrease` also fires when a plugin moves back to an older version a base in the older form lists. Catalog item views (admin and org) and the import review carry `descriptionZh` (the latest version's Chinese description, or null), and the plugin pages show the description in the UI language.
  
  Release order: release core and upgrade the deployed kernels before `capybara-hq/plugins` publishes
  plugins whose `description` is an object (older kernels reject it) and before the official
  marketplace drops older versions.
- Updated dependencies [f222ff8]
- Updated dependencies [7c8d05e]
- Updated dependencies [2a12327]
- Updated dependencies [12fd552]
- Updated dependencies [fddab56]
- Updated dependencies [99a00cd]
- Updated dependencies [2fb7d41]
- Updated dependencies [6b4da7f]
  - @capybara-hq/plugin-sdk@0.1.0-rc.3

## 0.1.0-rc.2

### Patch Changes

- 517ca1e: The deployment config fields carry zh and en form labels.
- 0f1507e: model-fake has a display name: 模拟模型 / Fake model.
- Updated dependencies [0ec51d1]
- Updated dependencies [8892d50]
  - @capybara-hq/plugin-sdk@0.1.0-rc.2

## 0.1.0-rc.1

### Patch Changes

- 72bada5: The scripted model provider accepts `tools:[{"name":…,"input":…},…]` to call several tools in one assistant message.
- Updated dependencies [8bf0b04]
- Updated dependencies [32580d3]
  - @capybara-hq/plugin-sdk@0.1.0-rc.1
