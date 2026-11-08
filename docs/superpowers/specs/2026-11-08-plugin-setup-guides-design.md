# Plugin setup guides: setup material shipped in the plugin, rendered by the kernel

- Date: 2026-11-08, written against `fix/acceptance` at `d53f1ded`.
- Status: decided by the maintainer on 2026-11-08 (marked **(decided)**); the maintainer asked for
  the implementation right away, so the designer's calls below were not reviewed first.
- Related: the plugin format (`2026-10-22-package-ecosystem-design.md` §4,
  `.agents/skills/writing-plugins`), channels (`.agents/skills/writing-channels`), plugin icons
  (commit `48b244e5`, the same visibility rules), the `Platform` tool
  (`2026-11-07-platform-tool-design.md` §9).
- Markers: **(decided)** is the maintainer's decision; **(designer's call)** is decided here and
  may be overturned in review.

## 1. Why

Setting up a channel needs material that lives in the plugin's repository today: Slack's app
manifest is `plugins/slack/app-manifest.yaml` on GitHub. The person configuring the channel has to
find it and hand-edit the values (the webhook Request URL, the sign-in callback, the app name,
Socket Mode or webhooks). When a plugin upgrade changes it (a new scope), nobody notices.

The maintainer's rule: **a plugin declares setup guides in its package; the kernel renders them
with a fixed set of safe values and the web shows them where the person needs them (decided)**.
The kernel also remembers which guide a connection was set up with and says so when an upgrade
changes it.

## 2. The format (`plugin.json` `setupGuides`)

```json
{
  "setupGuides": [
    {
      "id": "slack-app",
      "place": "channel-connection",
      "title": { "en": "Create the Slack app", "zh": "创建 Slack 应用" },
      "steps": [
        { "en": "Open https://api.slack.com/apps and choose Create New App → From a manifest.",
          "zh": "打开 https://api.slack.com/apps，选择 Create New App → From a manifest。" },
        { "mode": "webhook", "en": "Slack verifies {{webhookUrl}} when you save.",
          "zh": "保存时 Slack 会校验 {{webhookUrl}}。" }
      ],
      "files": [
        { "path": "./guides/slack/app-manifest.socket.yaml.tmpl", "language": "yaml",
          "title": { "en": "App manifest", "zh": "应用 manifest" }, "mode": "long_connection" },
        { "path": "./guides/slack/app-manifest.webhook.yaml.tmpl", "language": "yaml",
          "title": { "en": "App manifest", "zh": "应用 manifest" }, "mode": "webhook" }
      ]
    }
  ]
}
```

- `setupGuides` (≤ 8) is optional; the JSON Schema `plugin.v1.schema.json` is generated from the
  zod schema as before, and the format stays `schemaVersion: 1` (an optional key; older manifests
  stay valid) **(designer's call)**.
- `id`: `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the plugin.
- `place`: where the guide is shown. The first cut has one place, `channel-connection` (新建渠道
  and the channel detail page). The place is an enum (`SETUP_GUIDE_PLACES`), so later places
  (`connector-template`, `identity-source`) add a value with their own variables and modes without
  changing the shape **(decided: room for more places)**. A `channel-connection` guide needs the
  plugin's extension to provide `channel@1` (the parser checks it when `extension` is present, the
  kernel's reader when it is absent, since a source `plugin.json` never has it).
- `title`, each step and each file title are `{ en, zh? }` (like `description`; Chinese falls back
  to English) **(designer's call: a third-party plugin need not ship Chinese)**. A title is ≤ 100
  characters, a step ≤ 2000, a guide ≤ 20 steps and ≤ 8 files and has at least one of either.
- **Steps are plain text (designer's call)**: no Markdown, no HTML. The web renders them as text
  nodes; the only markup is a backtick pair, drawn as inline code. Nothing in a step can become a
  link, an image or an element, so a plugin cannot put active content on the page. Placeholders
  are rendered in steps too.
- `files[]`: `path` is a `./…` path inside the plugin (`isSafePackagePath`), ending in `.tmpl`,
  `.yaml`, `.yml`, `.json` or `.txt`; at most 64 KiB, valid UTF-8 without NUL; unique in the guide.
  `language` is `yaml`, `json` or `text` (the code block's label and the escaping, §3). Files are
  validated like the icon: the parser checks the path, the kernel's reader (`readPluginFiles`) and
  the packer check the file exists, its size and its text.
- `mode` (optional, on a step or a file): the file or step applies to one mode only. A place
  defines its modes: `channel-connection` has `long_connection` and `webhook`, the connection's
  `inboundMode`. **Per-mode files instead of conditionals (decided)**: there is no template
  language, a guide ships one file per mode. A guide whose steps and files carry no mode has no
  mode switch.
- The toolchain: `capybara-plugin pack` (and so `capybara-plugin check` / `check:plugin-pack`)
  ships the listed files and fails on a missing or oversized file and on a placeholder the place
  does not define (§3). The kernel never refuses an import for an unknown placeholder, so a plugin
  written for a newer kernel still imports **(designer's call)**.
- Stored on import with the version, like the icon: the normalized manifest in
  `catalog_item_versions.manifest`, the files in the version's object prefix, their sha256 in
  `catalog_item_versions.files`.

## 3. Rendering

**Placeholders (decided)**: `{{name}}` (spaces inside the braces allowed), `name` matching
`[A-Za-z][A-Za-z0-9]*`. Nothing else is syntax: no conditionals, loops, filters or escapes; text
that is not a known placeholder stays as written.

Variables of `channel-connection`, all deterministic, none a secret **(decided: a fixed safe
set)**:

| Variable | Value | Without it |
|---|---|---|
| `publicUrl` | `http.publicUrl`, no trailing slash | unresolved |
| `webhookUrl` | `<channels.webhookBaseUrl>/channels/webhook/<connectionId>` | unresolved before the connection exists, or without a webhook base URL |
| `signInCallbackUrl` | `<http.publicUrl>/api/v1/auth/sso/<plugin>/callback` (Sign in with the platform) | unresolved without `http.publicUrl` |
| `connectionName` | the connection's name; on 新建渠道 the name typed so far (`name` query) | unresolved |
| `orgName` | the org's name | — |
| `pluginName` | the plugin (catalog item) name | — |
| `pluginVersion` | the item's latest version | — |
| `mode` | the mode the guide is rendered for (`long_connection` / `webhook`) | unresolved for a guide without modes |

- **No secrets, ever (decided)**: no variable reads a connection's config, a secret, a token or
  the deployment config beyond the two public URLs. A placeholder for anything else
  (`{{appSecret}}`) is unknown and stays visible.
- An unknown placeholder stays as written **(decided)**; a known one without a value stays as
  written too and is listed in `unresolved`, so the web can say "shown after saving".
- **Escaping by language (designer's call)**: in a `yaml` or `json` file a value is inserted
  JSON-string-escaped without the quotes (`"` → `\"`, newline → `\n`), so a placeholder inside
  double quotes (`name: "{{connectionName}}"`) stays one valid string whatever the name holds
  (YAML double-quoted scalars take JSON escapes). In `text` files and steps control characters
  become spaces. Authors put placeholders inside double quotes in YAML and JSON.
- The renderer is a pure SDK function (`renderSetupGuideText`), so a plugin can test its
  templates; the kernel is the only caller in production.

## 4. Routes

`GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId?mode=&connectionId=&name=` →
`{ guide: RenderedSetupGuide }`:

```ts
interface RenderedSetupGuide {
  itemId: string; plugin: string; version: string;
  id: string; place: "channel-connection";
  title: { en: string; zh?: string };
  modes: string[];            // the modes the guide's steps and files use; [] = no switch
  mode: string | null;        // the one rendered
  steps: { en: string; zh?: string }[];
  files: { title: { en: string; zh?: string }; language: "yaml" | "json" | "text";
           fileName: string; content: string }[];
  unresolved: string[];       // known variables without a value here
  hash: string;               // the template hash of this mode (§6)
}
```

- **Org scoping (decided: like the catalog icon)**: the item must be one the org's catalog shows
  (members never see disabled items, a `named` item only for its listed orgs or as requestable,
  an org-owned item only for its owner or through the share gate, an upload waiting for
  confirmation only for its owner): the visibility rules of `PluginIcons`, now one shared
  function. Otherwise 404 `catalog.item_not_found`; a guide the latest version does not have is
  404 `catalog.guide_not_found`.
- The route is `catalog.read`; each place adds the action of the page it serves:
  `channel-connection` needs `channels.manage` (org admins), checked in the service (403
  `forbidden`) **(designer's call)**.
- `connectionId` must be a live connection of the org whose plugin is the item (else 404
  `channel.not_found`); it supplies `connectionName`, `webhookUrl` and the default mode (its
  `inboundMode`). Without it the default mode is the guide's first. `mode` outside the place's
  modes is 400 `validation_failed`.
- The channel pages find the guide without knowing catalog ids: `GET channels/schema/:plugin`
  gains `guide: { itemId, guideId } | null`, and each connection view gains `setupGuide:
  { itemId, guideId, version } | null` and `guideDrift` (§6). Both resolve plugin → catalog item
  with the same visibility rule.
- `POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack { hash }` → `{ channel }`
  (`channels.manage`): 「我已更新应用」. The hash is the one of the guide the person was shown; a
  different current hash (the plugin moved on meanwhile) is 409 `channel.guide_changed`, a plugin
  without a guide 404 `catalog.guide_not_found`. Audited `channel.guide_confirmed`.
- **Platform tool (decided here)**: both routes are exclusions. The guide is material a person
  pastes into a third-party console (category `internal`: the web's setup section), and the
  confirmation says a person changed a third-party app, which only that person knows (category
  `human-only`).

## 5. Web

- 新建渠道: once a plugin is picked and it has a `channel-connection` guide, a 接入指南
  FormSection after the plugin section: the steps (numbered text, inline code for backticks),
  each rendered file in a `CodeBlock` with its title and 复制, and a mode switch
  (`Segmented`: 长连接 / Webhook) when the guide has modes. The connection name typed so far is
  passed as `name`; unresolved variables get one muted line ("{{webhookUrl}} 保存后显示").
- Channel detail: a 接入指南 section with the same body for the connection (its mode by default),
  and above it the drift notice when §6 says so (a `Callout`, warn): 「Slack 插件更新了接入配置
  （v0.1.0 → v0.2.0）：需要在 Slack 应用里更新 manifest 并重新安装」 with the action
  「我已更新 Slack 应用」 (the ack route).
- Design: `CodeBlock` gains `title` and `copyable` (a copy button that reads 已复制 for two
  seconds; without a clipboard the code is selected), in `packages/design` first, spec §6.9
  updated. i18n zh / en.

## 6. Version drift

- The connection row gets `guide_ack jsonb` (migration 0097): `{ guideId, version, hash, mode }`
  of the guide it was last set up with, null when unknown.
- **The hash is the template hash (designer's call)**: sha256 over `path NUL sha256 LF` of the
  guide's files that apply to the mode, from `catalog_item_versions.files`. It needs no storage
  read, ignores step wording, and changes exactly when a rendered file of that mode changes for
  the same variables (rendering is deterministic). Renaming the connection or moving
  `http.publicUrl` is not plugin drift.
- Recorded on create (the guide the 新建渠道 page showed, the current one), on a PATCH that
  switches `inboundMode` (the person sets the app up for the new mode, the guide of that mode is on
  the page) and by the ack route.
- **A mode switch never clears drift.** The PATCH re-baselines the ack to the new mode's current
  guide only when there is no ack or the ack shows no drift; a drifted ack stays as it is, so the
  notice stays until a person confirms through the ack route. Otherwise switching modes there and
  back would clear the notice unconfirmed, and `channels.update` is reachable by an agent through
  the Platform tool while the ack route is human-only.
- The ack route always records the guide for the connection's **current** mode, and checks the
  posted hash against that mode's current guide (the one the page shows), so it never 409s because
  the kept ack names another mode. Drift is judged on `guide_ack.mode`: after a switch with a kept
  ack, the notice keeps reporting the change to the guide the connection was set up with.
- **Drift** = `guide_ack` is set, the plugin's current `channel-connection` guide has the same id
  and its hash for `guide_ack.mode` differs. The view carries `guideDrift: { from, to } | null`
  (versions). A connection without an ack (created before 0097, or before the plugin had a guide)
  never shows a notice **(designer's call: no false alarms on old rows)**.
- Multi-replica: everything is in PG (the ack on the row, the hashes from the version rows); no
  process state, no cache.

## 7. Security

- Template files are text served inside JSON and shown in `<pre>`; steps are text nodes. No HTML,
  no Markdown, no links built from plugin text.
- No secret reaches a variable (§3); the tests render a guide for a connection with secrets and
  check they are absent.
- Paths are package-safe and checked at pack and import; size and count limits bound the work.
- The guide route follows the catalog icon's visibility and the page's role.

## 8. Out of scope

- Guides for connector templates and identity sources (the place enum leaves room).
- Conditionals, loops or a template language; per-language files (a file is one text for both
  languages; titles and steps are localized).
- Pushing the manifest to the platform (Slack's manifest API) or detecting an outdated app there.
- A drift notice for connections that have no ack.
