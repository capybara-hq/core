# Setup guides v2: Markdown guides, connector templates, live checks and agent-assisted setup

- Date: 2026-11-09, written against `main` at `3c853865`.
- Status: approved by the maintainer on 2026-11-09, with the answers to the review questions
  recorded in §18 and folded into the sections they change. Implemented on `docs/setup-guides-v2`;
  the visual baselines, the release gate and the Slack plugin migration (plan tasks 17–19) follow. The
  skills writing-plugins, writing-extensions, writing-connectors, writing-channels,
  writing-extension-ui, writing-web-ui and writing-kernel-api describe the result. Plan:
  `docs/superpowers/plans/2026-11-09-setup-guides-v2.md`. Supersedes `2026-11-08-plugin-setup-guides-design.md` (v1,
  shipped) wherever they differ; v1's routes, ack semantics and visibility rules carry over unless
  a section here says otherwise.
- Related: the plugin format (`2026-10-22-package-ecosystem-design.md` §4,
  `.agents/skills/writing-plugins`), connector templates and component state
  (`2026-11-05-plugin-component-management-design.md` §15, P2-10, P4-6),
  channels (`.agents/skills/writing-channels`), connectors and OAuth
  (`.agents/skills/writing-connectors`), the extension host and effective config
  (`.agents/skills/writing-extensions`, `2026-11-07-platform-org-layering-design.md`), `ctx.ui`
  (`.agents/skills/writing-extension-ui`, the model for check registration), the `Platform` tool
  (`2026-11-07-platform-tool-design.md` §6, §9), the design system (`docs/design/spec.md` §6.9,
  §6.16.4).
- Markers: **(decided)** is the maintainer's decision of 2026-11-09; **(designer's call)** is
  decided here and may be overturned in review. Unmarked text restates current code or follows
  directly from a decision.

## 1. Intent

v1 gave a plugin a way to ship setup material (Slack's app manifest) that the kernel renders with
safe values and the web shows where the person needs it. Three things limit it:

1. **The format is rigid.** A guide is a list of plain-text steps plus template files. Anything
   that reads like a README (a heading, a table of scopes, a link, a warning paragraph, a
   per-mode explanation) does not fit, so the real setup text stays in the plugin's README on
   GitHub and the in-product guide is a thin copy of it. Slack's connector setup (README
   "Slack connector") has no in-product guide at all: an org admin reads GitHub and hand-edits
   `https://capybara.example.com/api/v1/oauth/callback` into a manifest.
2. **It covers one place.** Only channel connections. Connector templates, where an org admin
   registers an OAuth app and pastes its client id and secret, need the same help.
3. **It is static.** The person follows the steps and only learns whether they worked when the
   bot stays silent or a member's Connect fails. The platform could tell them ("Bot token works",
   "Request URL verified", "The app lacks the scope `commands`") while they are on the page, and
   an agent could walk them through it in chat.

v2 makes a guide a **dynamic Markdown document** (decided), adds the **connector template**
place (decided), designs **checks embedded in the document** that the plugin's extension runs
(decided), and exposes guides and checks to the **`Platform` tool** so an agent can assist
(decided). All of it ships as one delivery, built in ordered waves (§17) (decided).

## 2. Goals, non-goals, anti-goals

Goals:

1. A plugin author writes a guide the way they write a README: `guides/<id>.md`, Markdown,
   `{{variables}}` for the values only the deployment knows (decided).
2. Fenced code blocks render with a copy button; a manifest is just a code block (decided).
3. Variables are escaped for where they stand (prose, inline code, a YAML or JSON code block, a
   link) so no value can break the document or the pasted file (decided).
4. The kernel renders; what reaches the browser is sanitized Markdown with no raw HTML and links
   that follow one policy (decided).
5. Guides appear on channel connections (as v1) and on connector templates (org admin: turning the
   template on and entering the OAuth client; member: connecting), and a new place is a new place
   id with its variables, modes and page, nothing else (decided).
6. Mode-specific text (long connection vs webhook) is marked by sections in the document, and the
   page has a mode switch (decided).
7. The drift notice stays, keyed by a content hash per place and mode, with v1's ack semantics,
   including "a mode switch never clears drift" (decided).
8. A guide can embed live checks that run in the plugin's extension with the org's effective
   config and the target's secrets, on the extension side only, and return ok / failing / unknown
   with a localized reason and fix (decided).
9. An agent can read a rendered guide, read and run its checks and explain failures through the
   `Platform` tool; entering secrets and confirming third-party changes stay with people (decided).

Non-goals:

- A template language. Still no conditionals, loops, filters or includes; mode sections are the
  only branching, and they are chosen by the page, not computed from values.
- Pushing configuration to the third party (Slack's manifest API, creating the app for the
  person) or reading the third party's app configuration beyond what a check does.
- Guides for model providers, deployment extension config, sandboxes and object stores in this
  delivery. The place registry leaves room for them (§9.4); each is a later, small change.
- Translating guides. A plugin ships English and optionally Chinese; nothing is machine-translated.
- Checks that change anything (a check never writes, on the platform or at the third party).
- Background re-checks and notifying org admins about failing checks (decided 2026-11-09, §18
  item 5): checks run only when a person or an agent asks. Later: a periodic locked job per org
  that re-runs the checks of live targets and notifies org admins when one turns failing.

Anti-goals (a failure even if it works):

- A plugin puts active content on a kernel page: a script, an iframe, an image that loads, a
  `javascript:` link, HTML that renders as HTML.
- A secret reaches a rendered guide, a check result, a cache entry, a log line, the browser or an
  agent.
- A connection or connector shows "the plugin changed its setup" because someone renamed it or the
  public URL moved, or stops showing it because someone toggled the mode.
- A check runs with more data than the extension already receives for that target, or runs in an
  org where the extension is off or needs configuration.
- Viewing a guide makes the deployment hammer a third-party API (no rate limit, no cache, every
  replica and every viewer calling).

## 3. Terms

| Term | Meaning |
|---|---|
| guide | One setup document a plugin ships: `guides/<id>.md` (+ `guides/<id>.zh.md`), declared in `plugin.json` `setupGuides` |
| place | Where a guide is shown, with its variables, modes, audiences and target: `channel-connection`, `connector-template` |
| target | The object a guide is rendered for: a channel connection, a connector made from a template, or none yet (新建渠道, a template not yet set up) |
| mode | A place-defined alternative chosen on the page and stored on the target (`long_connection` / `webhook`) |
| audience | Who the rendered text is for at a place: `admin` (sets the integration up) or `member` (uses it); chosen by the page, never by a switch |
| section | A block of the document that applies to one mode or one audience (`::: mode webhook` … `:::`) |
| check | A live status row in a guide (`::check bot-token Bot token works`), run by the plugin's extension (`ctx.setup.check`) or by the kernel (`capybara:*`) |
| ack | What a target records about the guide it was set up with (`guide_ack`), the basis of the drift notice |

## 4. The format

### 4.1 Declaration in `plugin.json`

```json
{
  "setupGuides": [
    { "id": "slack-app", "place": "channel-connection" },
    { "id": "slack-connector", "place": "connector-template", "template": "slack" }
  ]
}
```

- `setupGuides` (≤ 8) is optional; `schemaVersion` stays 1 and the generated
  `plugin.v1.schema.json` changes in place (pre-0.1.0: no compatibility layer, decided).
- `id`: `^[a-z0-9][a-z0-9-]{0,63}$`, unique in the plugin. The documents are at the fixed paths
  `guides/<id>.md` (English, required) and `guides/<id>.zh.md` (Chinese, optional) **(designer's
  call: a convention instead of a `path` field; one less thing to get wrong, and the file name
  tells a reader of the repository which guide it is)**.
- `place`: one of `SETUP_GUIDE_PLACES` (§9). A `channel-connection` guide needs the plugin's
  extension to provide `channel@1` (checked as in v1).
- `template` (only and required for `connector-template`): the id of one of the plugin's own
  connector templates (`connectors/<template>.json`). At most one guide per template; at most one
  `channel-connection` guide per plugin **(designer's call: v1 used "the first guide of the
  place"; v2 makes it a rule so the lookup is unambiguous)**.
- The steps / files / title fields of v1 are gone; the title is the document's first heading
  (§4.2).

### 4.2 The document

A guide is CommonMark + GFM (tables, strikethrough, task lists, autolinks) with four additions:
variables, mode and audience sections, check lines, and a `title` on code fences.

- **Title**: the document must start (after blank lines) with exactly one level-1 heading,
  `# Create the Slack app`. It is the guide's title (≤ 100 characters) and is not repeated in the
  body. Further `#` headings are refused; `##` to `####` are the guide's structure.
- **Variables**: `{{name}}`, spaces inside the braces allowed, `name` matching
  `[A-Za-z][A-Za-z0-9]*`, as in v1. Where they may stand and how they are escaped: §6.
- **Sections** (decided: a section marker): a line `::: mode <mode>` or `::: audience <audience>`
  opens a section, a line `:::` closes it. Both lines start in column 0 and are outside fenced
  code. Sections do not nest, except one `mode` section inside an `audience` section
  **(designer's call: enough for Slack and every case we know; nesting rules stay one sentence)**.
  The mode or audience must be one the place defines (§9). Text outside every section applies to
  all modes and audiences.
- **Checks**: a line `::check <check-id> <label>` in column 0, outside fenced code, is a block of
  its own (the scanner splits it from the paragraph around it, so no blank lines are needed).
  `<check-id>` is `^[a-z0-9][a-z0-9-]{0,47}$` for the plugin's own checks or
  `capybara:<id>` for a kernel check (§10.6); `<label>` (≤ 80 characters, plain text, no
  variables) is the row's label in the document's language. A check line that an open HTML block
  would swallow is refused (end the HTML with a blank line). A check line inside a mode section
  runs only for that mode. **(designer's call: the label lives in the document, the code lives in
  the extension; the zh document carries the zh label, so the extension never needs i18n for
  labels, and the row shows its label even when the extension is not loaded.)**
- **Code fences**: the info string is `<language> [title="<text>"]`. `<language>` decides the
  escaping (§6.2) and the label; `title` (≤ 100 characters, plain text, no variables) is the
  block's heading (`App manifest (Socket Mode)`) and, with the language, its file name for a
  download later. Every fenced block gets a copy button (decided); an indented code block is
  refused (it cannot carry a language, and a stray four-space indent should not silently become
  a block the author did not mean) **(designer's call)**.
- Directive lines and fence info strings never hold variables. Why the syntax is line-based and
  not `remark-directive`: three fixed line shapes are recognized by a scanner that tracks fenced
  code, need no Markdown extension in the parser and degrade to visible plain lines when the file
  is read on GitHub **(designer's call)**.

### 4.3 Languages

- `guides/<id>.md` is the canonical English document; `guides/<id>.zh.md` the Chinese one.
  The page renders the viewer's locale and falls back to English.
- **The two documents carry the same material (decided 2026-11-09)**: the same sections in the
  same order, the same check ids in the same sections, and byte-equal fenced code blocks in the
  same sections (title excepted; comments inside code are not translated). `capybara-plugin pack` / `check` and the
  importer refuse a zh document that differs, with an error that names the block and the first
  differing line: `guides/slack-app.zh.md: code block 2 ("应用 manifest（Socket Mode）") differs
  from guides/slack-app.md block 2 at line 14; code blocks must be identical in every language`. Then the pasted
  manifest is the same whatever the admin's language, and drift (§11) needs only the English
  document. Comments inside a manifest stay English, as they are now.

### 4.4 Limits

| What | Limit |
|---|---|
| Guides per plugin | 8 |
| Bytes per document (each language), UTF-8 without NUL and without U+E000–U+E0FF | 64 KiB |
| Fenced code blocks per document | 24 |
| Check lines per document | 16 |
| Sections per document | 16 |
| Heading / title / check label / fence title | 100 / 100 / 80 / 100 characters |
| Markdown nesting depth | 16 (deeper content renders as text, as the design `Markdown`) |

The private-use range is refused because the renderer uses it for its placeholder sentinels
(§6.1).

### 4.5 Validation

- The SDK (`packages/plugin-sdk/src/setup-guide.ts`) holds the parser, the validator and the
  renderer as pure functions (`parseSetupGuide`, `validateSetupGuide`, `renderSetupGuide`), so
  the toolchain, the kernel and a plugin's own tests share them. The SDK gains the Markdown
  parser dependencies the design package already uses (`mdast-util-from-markdown`,
  `mdast-util-gfm`, `micromark-extension-gfm`) plus `mdast-util-to-markdown`
  **(designer's call: the SDK may depend on third-party packages; one parser everywhere means a
  guide that packs also renders)**. SDK API change: `pnpm gen:sdk-api` and a changeset.
- `capybara-plugin pack` / `check` (and so `check:plugin-pack`): the documents exist, sizes and
  limits, title, sections well formed and known to the place, check ids well formed, variables
  known to the place and allowed where they stand (§6), language parity (§4.3), no indented code,
  and every plugin check id used by a document is declared in the extension's
  `permissions.setupChecks` (§10.2). A new command `capybara-plugin guide <id> [--locale zh]
  [--mode m] [--audience a] [--var name=value…]` prints the rendered document, so an author sees
  what an admin will see **(designer's call)**.
- The kernel's package reader (`readPluginFiles`) runs the same validation at import; a guide
  that fails it fails the import with `catalog.invalid_manifest` naming the guide and the problem.
  An unknown variable is not an import error (a plugin written for a newer kernel still imports;
  the variable stays as written), as in v1. An unknown `capybara:` check renders as `unknown`
  ("not supported by this platform version").
- Stored on import with the version like v1's files: the documents in `catalog_files` by sha256,
  their paths in `catalog_item_versions.files`, the normalized `setupGuides` in the manifest.

## 5. The Slack example

### 5.1 `plugin.json`

```json
{
  "setupGuides": [
    { "id": "slack-app", "place": "channel-connection" },
    { "id": "slack-connector", "place": "connector-template", "template": "slack" }
  ]
}
```

The slack extension declares `permissions.setupChecks: ["bot-token", "bot-scopes", "app-token"]`
and registers them with `ctx.setup.check` (§10.2). The two `.yaml.tmpl` files and
`app-manifest.connector.yaml` are removed; the README's "Create the Slack app" and "Slack
connector" sections shrink to a pointer at the guides plus what is only for operators.

### 5.2 `guides/slack-app.md` (channel connection)

`````markdown
# Create the Slack app

This connects one Slack workspace to Capybara as a bot. People message the bot directly, mention
it in channels and use the slash commands `/new`, `/env` and `/capybara`. You need permission to
create apps in the workspace (with "Only allow pre-approved apps", a workspace admin approves the
app after step 2).

## 1. Create the app from the manifest

Open <https://api.slack.com/apps>, choose **Create New App → From a manifest**, pick your
workspace and paste the manifest below. It registers the bot scopes, the events and the slash
commands the plugin needs.

::: mode long_connection
Socket Mode needs no public address: Slack keeps a connection open to Capybara.

```yaml title="App manifest (Socket Mode)"
# Slack app manifest for the Capybara Slack plugin, Socket Mode (long connection).
# Reference: https://docs.slack.dev/reference/app-manifest (checked 2026-11-09).
display_information:
  # Slack caps app names at 35 characters; shorten it in the app settings if it is longer.
  name: "{{connectionName}}"
  description: Chat with your organization's Capybara agents.
  background_color: "#3d2f24"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: capybara
    always_online: true
  slash_commands:
    - command: /new
      description: Start a new conversation (direct message)
      should_escape: false
    - command: /env
      description: List or set your default environment (direct message)
      usage_hint: "[name]"
      should_escape: false
    - command: /capybara
      description: Run a skill
      usage_hint: "<skill> [args]"
      should_escape: false
oauth_config:
  # Sign in with Slack (identity-source@1).
  redirect_urls:
    - "{{signInCallbackUrl}}"
  scopes:
    bot:
      - chat:write # post and update replies and cards
      - commands # slash commands /new, /env, /capybara
      - im:write # conversations.open: tell the bot's own DM from other DMs
      - im:history # message.im: direct messages to the bot
      - app_mentions:read # app_mention: @capybara in channels
      - channels:history # message.channels: thread replies in public channels
      - groups:history # message.groups: thread replies in private channels
      - users:read # users.info; team_join / user_change; users.list
      - users:read.email # directory@1: email addresses in users.list
settings:
  event_subscriptions:
    bot_events:
      - message.im
      - app_mention
      - message.channels
      - message.groups
      - team_join
      - user_change
  interactivity:
    is_enabled: true
  socket_mode_enabled: true
  org_deploy_enabled: false
  token_rotation_enabled: false
```

## 2. Create the app-level token

Under **Basic Information → App-Level Tokens** choose **Generate Token and Scopes**, add the scope
`connections:write` and copy the `xapp-…` token into the **App-level token** field below.

::check app-token App-level token opens a Socket Mode connection
:::

::: mode webhook
In webhook mode Slack posts events, card clicks and slash commands to this connection's address
and checks it when you save.

```yaml title="App manifest (webhook)"
# Slack app manifest for the Capybara Slack plugin, webhook inbound mode.
# Reference: https://docs.slack.dev/reference/app-manifest (checked 2026-11-09).
display_information:
  # Slack caps app names at 35 characters; shorten it in the app settings if it is longer.
  name: "{{connectionName}}"
  description: Chat with your organization's Capybara agents.
  background_color: "#3d2f24"
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: capybara
    always_online: true
  slash_commands:
    - command: /new
      url: "{{webhookUrl}}"
      description: Start a new conversation (direct message)
      should_escape: false
    - command: /env
      url: "{{webhookUrl}}"
      description: List or set your default environment (direct message)
      usage_hint: "[name]"
      should_escape: false
    - command: /capybara
      url: "{{webhookUrl}}"
      description: Run a skill
      usage_hint: "<skill> [args]"
      should_escape: false
oauth_config:
  # Sign in with Slack (identity-source@1).
  redirect_urls:
    - "{{signInCallbackUrl}}"
  scopes:
    bot:
      - chat:write # post and update replies and cards
      - commands # slash commands /new, /env, /capybara
      - im:write # conversations.open: tell the bot's own DM from other DMs
      - im:history # message.im: direct messages to the bot
      - app_mentions:read # app_mention: @capybara in channels
      - channels:history # message.channels: thread replies in public channels
      - groups:history # message.groups: thread replies in private channels
      - users:read # users.info; team_join / user_change; users.list
      - users:read.email # directory@1: email addresses in users.list
settings:
  event_subscriptions:
    request_url: "{{webhookUrl}}"
    bot_events:
      - message.im
      - app_mention
      - message.channels
      - message.groups
      - team_join
      - user_change
  interactivity:
    is_enabled: true
    request_url: "{{webhookUrl}}"
  socket_mode_enabled: false
  org_deploy_enabled: false
  token_rotation_enabled: false
```

Slack checks the Request URL `{{webhookUrl}}` when you create the app or save **Event
Subscriptions**, and Capybara answers the check, so the channel connection must be saved first.
If Slack reports the URL unverified, save the connection here, then retry under **Event
Subscriptions**.

## 2. Copy the signing secret

Copy **Basic Information → App Credentials → Signing Secret** into the **Signing secret** field
below. Every webhook request is verified with it; without it every request is refused.

::check capybara:webhook-public Webhook address is reachable from the internet
::check capybara:webhook-received Slack has delivered a signed request
:::

## 3. Install the app and copy the bot token

Choose **Install App → Install to Workspace** and copy the **Bot User OAuth Token** (`xoxb-…`)
into the **Bot token** field below.

::check bot-token Bot token works
::check bot-scopes The app has every scope in the manifest

## Sign in with Slack

The manifest's redirect URL `{{signInCallbackUrl}}` is for **Sign in with Slack**. It needs the
deployment's public URL; without it, delete the redirect URL from the manifest or ask your super
admin to set `http.publicUrl`.

::check capybara:public-url The platform has a public URL

## When the plugin changes this manifest

After a Slack plugin update that changes the manifest, Capybara shows a notice on this connection.
Open the app at <https://api.slack.com/apps>, go to **App Manifest**, paste the new manifest,
save, reinstall the app if Slack asks, then confirm here with **I have updated the Slack app**.
`````

Notes on the example:

- The level-2 heading numbering differs per mode ("2. Create the app-level token" vs "2. Copy the
  signing secret"); each mode reads as one numbered list on the page because the other mode's
  section is not rendered.
- `{{connectionName}}`, `{{signInCallbackUrl}}` and `{{webhookUrl}}` inside the YAML stay inside
  author-written double quotes, as v1 required; in prose `{{webhookUrl}}` stands in inline code.
- `bot-scopes` reads the scopes Slack reports for the bot token (`x-oauth-scopes` on
  `auth.test`) and fails naming the missing ones with the fix "paste the manifest again and
  reinstall the app"; it catches exactly the case the drift notice warns about.

### 5.3 `guides/slack-connector.md` (connector template)

`````markdown
# Set up the Slack connector

The Slack connector lets agents search, read and send Slack messages, canvases, lists and files
**as the person using them**, through Slack's MCP server. Each member connects their own Slack
account; there is no shared org token.

::: audience admin
An org admin sets it up once: create an internal Slack app (a separate app from the bot), then
enter its client id and secret here. Members connect afterwards.

## 1. Create the OAuth app

Open <https://api.slack.com/apps>, choose **Create New App → From a manifest** in the company
workspace and paste the manifest below. It turns on MCP and requests the user scopes the
{{templateName}} template asks for.

```yaml title="App manifest (Slack connector)"
# Slack app manifest for the {{templateName}} connector template ({{pluginName}} {{pluginVersion}}).
# A separate internal app: user scopes only, MCP on, no bot, no Socket Mode.
# Reference: https://docs.slack.dev/reference/app-manifest and
# https://docs.slack.dev/ai/slack-mcp-server/ (checked 2026-11-08).
display_information:
  name: "Capybara connector"
  description: Lets Capybara agents use Slack as you, with your permission.
  background_color: "#3d2f24"
oauth_config:
  redirect_urls:
    - "{{oauthCallbackUrl}}"
  scopes:
    user:
      - search:read.public
      - search:read.private
      - search:read.mpim
      - search:read.im
      - search:read.files
      - search:read.users
      - channels:history
      - groups:history
      - mpim:history
      - im:history
      - channels:read
      - groups:read
      - mpim:read
      - im:read
      - channels:write
      - groups:write
      - mpim:write
      - im:write
      - chat:write
      - canvases:read
      - canvases:write
      - lists:read
      - lists:write
      - files:read
      - files:write
      - reactions:read
      - reactions:write
      - emoji:read
      - users:read
      - users:read.email
settings:
  is_mcp_enabled: true
  org_deploy_enabled: false # true for an Enterprise Grid org-wide install
  socket_mode_enabled: false
  token_rotation_enabled: false
```

::check capybara:public-url The platform has a public URL

## 2. Keep the app internal

- Leave **Manage Distribution** off. Slack's MCP server serves only internal apps and Marketplace
  apps.
- Do **not** enable PKCE in the app settings: it turns the app into a public client for good.
  Capybara stays a confidential client.
- Keep token rotation off (the manifest does); without it user tokens do not expire.
- Approve or install the app as your workspace requires (with "Only allow pre-approved apps", a
  workspace admin approves it; on Enterprise Grid, an org admin).

## 3. Enter the client

Copy **Basic Information → App Credentials → Client ID** and **Client Secret** into the fields
below. The secret is stored encrypted and reads back only as "set".

::check capybara:oauth-client The client id and secret are entered
::check capybara:oauth-token-endpoint Slack accepts the client id and secret
::check capybara:connector-tools A member connected and the tool list was read

### Reusing the bot app instead

You can add the user scopes, turn on MCP and add the redirect URL `{{oauthCallbackUrl}}` to the
bot's app instead, as long as token rotation stays off (rotation is app-wide and would expire the
bot's `xoxb` token). Slack prefix-matches redirect URLs, so one entry `{{publicUrl}}/api/v1/`
covers this callback and the Sign in with Slack callback `{{signInCallbackUrl}}`.

## When the plugin changes this manifest

After an update that changes the scopes, Capybara shows a notice on the connector. Paste the new
manifest under **App Manifest**, save, and confirm here with **I have updated the Slack app**.
Members reconnect when Slack asks them to.
:::

::: audience member
## Connect your Slack account

Choose **Connect** and approve on Slack's consent screen. Agents then act in Slack as you, and
writes (sending, creating, reacting, uploading) ask you first unless your admin changed that.

**Disconnect** deletes the token in Capybara but does not revoke it at Slack: also remove the app
under your Slack profile's **Apps**, or ask a workspace admin.

::check capybara:connector-connected Your Slack account is connected
:::
`````

### 5.4 The Chinese documents

`guides/slack-app.zh.md` and `guides/slack-connector.zh.md` translate the prose and check labels
and keep the code blocks byte-equal (§4.3), for example:

```markdown
## 3. 安装应用并复制机器人令牌

选择 **Install App → Install to Workspace**，把 **Bot User OAuth Token**（`xoxb-…`）填进下方的
**机器人令牌**。

::check bot-token 机器人令牌可用
::check bot-scopes 应用具备 manifest 中的全部权限
```

## 6. Variables, escaping and rendering

### 6.1 How substitution stays safe

Substituting into Markdown source and then parsing it would let a value become syntax: a
connection named `[x](https://evil)` would become a link, a backtick run would close a code span.
So the renderer **parses first and substitutes into the tree** **(designer's call)**:

1. Section selection: the scanner keeps the lines outside sections plus the sections of the
   requested mode and audience; it removes the directive lines and turns each `::check` line into
   a placeholder paragraph it can find again.
2. Each known variable occurrence `{{name}}` is replaced by a sentinel `U+E000 <n> U+E001`
   (private-use characters, refused in source, §4.4, and inert in Markdown); unknown variables
   stay as written.
3. The text is parsed to mdast (CommonMark + GFM).
4. The tree is walked; each sentinel is replaced by its value, escaped for the node it sits in
   (§6.2). A sentinel in any other node (a heading's link title, an image alt) reverts to the
   literal `{{name}}`; the toolchain already refused it there.
5. The tree is sanitized (§7.1) and cut into blocks (§7.2). Prose blocks are serialized back to
   Markdown with `mdast-util-to-markdown`, which escapes text, so a value is literal text when the
   web parses it again.

Rendering is deterministic: the same document, variables, mode, audience and locale give the same
blocks byte for byte.

### 6.2 Escaping by context

| Where the variable stands | What is inserted |
|---|---|
| Text (paragraph, list item, heading, table cell, emphasis) | The value as a text node; control characters (C0, C1, U+2028, U+2029) become spaces. Serialization escapes Markdown syntax, and the text is kept from being auto-linked (§7.1). A `url` variable holding an http(s) URL becomes an explicit link. |
| Inline code | Control characters and newlines become spaces; the serializer picks a fence longer than any backtick run in the value. |
| Fenced code, language `yaml` / `yml` / `json` | JSON-string-escaped without the quotes (`"` → `\"`, newline → `\n`; C1 controls, U+2028 and U+2029 as `\uXXXX`), as v1: authors put the variable inside double quotes, and the value stays one string whatever it holds (YAML double-quoted scalars take JSON escapes). The toolchain warns when a `text` variable stands outside double quotes there. |
| Fenced code, any other language (`text`, `sh`, `toml`, `ini`, …) | Control characters (newline included) become spaces. The toolchain warns when such a variable is a `text` variable (§6.3), since nothing quotes it. |
| Link destination (`[text]({{webhookUrl}})`, `<{{publicUrl}}>`) | Only `url` variables (§6.3) at the start of the destination; the result must be an absolute http(s) URL or the link renders as its text. |
| Anywhere else (fence info string, directive line, link title, image) | Refused by the toolchain; left as the literal `{{name}}` by the kernel. |

### 6.3 The variables per place

Every variable is deterministic and none is a secret (decided, as v1). Each has a type: `url`
values are built by the kernel from deployment settings and ids; `text` values contain whatever a
person typed (names); `token` values are ids and enum values (`[a-z0-9._-]`).

Common to every place:

| Variable | Type | Value | Unresolved when |
|---|---|---|---|
| `publicUrl` | url | `http.publicUrl`, no trailing slash | not set |
| `orgName` | text | the org's name | never |
| `pluginName` | token | the plugin (catalog item) name | never |
| `pluginVersion` | token | the item's latest version | never |
| `mode` | token | the mode rendered | the place or guide has no modes |

`channel-connection` (modes `long_connection`, `webhook`; audience `admin` only):

| Variable | Type | Value | Unresolved when |
|---|---|---|---|
| `webhookUrl` | url | `<channels.webhookBaseUrl>/channels/webhook/<connectionId>` | before the connection exists (`not_saved`); no webhook base URL (`webhook_base`) |
| `signInCallbackUrl` | url | `<publicUrl>/api/v1/auth/sso/<plugin>/callback` | no `publicUrl` |
| `connectionName` | text | the connection's name; on 新建渠道 the name typed so far | nothing typed (`no_name`) |

`connector-template` (no modes; audiences `admin`, `member`):

| Variable | Type | Value | Unresolved when |
|---|---|---|---|
| `oauthCallbackUrl` | url | `<publicUrl>/api/v1/oauth/callback` (`OAUTH_CALLBACK_PATH`) | no `publicUrl` |
| `signInCallbackUrl` | url | as above, for the template's plugin (useful when one app serves both) | no `publicUrl` |
| `templateId` | token | the template id (`slack`, the file's base name) | never |
| `templateName` | text | the template's display name in the document's language | never |
| `connectorName` | text | the org's connector made from the template, when the page has one | no connector yet |

- An unknown variable stays as written; a known one without a value stays as written and is
  listed in `unresolved` with a reason code (`not_saved`, `no_name`, `public_url`, `webhook_base`,
  `no_connector`), so the web can say why and who fixes it (v1 computed the reasons in the web;
  v2 moves them to the kernel so the `Platform` tool gets them too) **(designer's call)**.
- No variable reads a target's config, a secret, a token, a client id or deployment config
  beyond the two URL settings (decided). `{{clientId}}` is unknown and stays visible.

## 7. Rendering and safety

### 7.1 Sanitizing the tree

After substitution the kernel keeps only these node types: heading (2–4; the title is lifted
out), paragraph, text, emphasis, strong, delete, inline code, code, blockquote, list, list item
(task items keep their box, read-only), table and its rows and cells, thematic break, break, link
**(designer's call: the subset of the design `Markdown` that a setup document needs)**. Then:

- `html` nodes (raw HTML, block or inline) become text nodes with their source: shown literally,
  never rendered (decided: no raw HTML).
- Images become a link to their URL with the alt text when the URL is absolute http(s), else the
  alt text; nothing is ever loaded from a guide.
- **Link policy (decided: links follow a policy)**: a link (inline, reference, autolink) survives
  only when its destination is an absolute `https:` URL, or an `http:` URL built from a `url`
  variable (a dev deployment's public URL). Anything else (`http:` typed by the author,
  `mailto:`, relative paths such as `./README.md`, `javascript:`, `data:`) renders as its text.
  Links open in a new tab with `rel="noopener noreferrer"` (the design `Markdown` already does).
  Link titles are dropped. **(designer's call: https only for author links; a plugin's README
  links are https anyway, and refusing plain http keeps third-party pages out of a downgrade)**.
- Definitions and footnotes are resolved into links or dropped; HTML entities are decoded to
  text.
- **No autolinks from text**: a GFM parser links bare `https://…`, `www.…` and `a@b.c` in text,
  and a backslash escape does not stop it. So before serializing, every text node outside a link
  (a substituted name, raw HTML shown as text, content flattened past the depth limit) gets an
  invisible U+2060 WORD JOINER after the colon of `scheme://`, inside `www.` and before `@`; a
  connection named `https://evil.example` then reads the same but is no link when the web parses
  the block again, whatever renderer consumes it. The only links in a `markdown` block are the
  explicit ones the policy above kept. Code blocks and inline code are never changed (GFM does not
  link inside them), so the value a person copies from them is exact **(designer's call)**.

The web renders the result with the design system's `Markdown`, which independently renders raw
HTML as text, loads no image and links only absolute http(s). Two layers, each enough on its own.

### 7.2 What the route returns

`GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId`, query `mode`, `audience`
(default `admin`), `locale` (`en` / `zh`), and the target: `connectionId` or `name`
(channel-connection), `connectorId` (connector-template). Response `{ guide: RenderedSetupGuide }`:

```ts
interface RenderedSetupGuide {
  itemId: string; plugin: string; version: string;
  id: string;
  place: SetupGuidePlace;
  locale: "en" | "zh";             // the document rendered (zh falls back to en)
  title: string;
  modes: string[];                 // the modes the document's sections use; [] = no switch
  mode: string | null;
  audiences: SetupGuideAudience[]; // the audiences the document has sections for
  audience: SetupGuideAudience;
  blocks: SetupGuideBlock[];
  checks: { id: string; label: string; source: "plugin" | "kernel" }[]; // in document order
  unresolved: { name: string; reason: UnresolvedReason }[];
  hash: string;                    // the content hash of this mode and audience (§11)
  target: { kind: "channel-connection" | "connector"; id: string } | null;
}

type SetupGuideBlock =
  | { kind: "markdown"; text: string }        // sanitized, re-serialized Markdown
  | { kind: "code"; language: string; title: string | null; text: string }
  | { kind: "check"; id: string; label: string };
```

- Code blocks are split out so the page draws them with a title and a copy button, and checks so
  it draws live rows; consecutive other nodes form one `markdown` block **(designer's call: the
  web composes known pieces; it never parses directives)**.
- Visibility and roles as v1: the item must be one the org's catalog shows (else 404
  `catalog.item_not_found`), the guide must be in its latest version (else 404
  `catalog.guide_not_found`), and the caller must hold the place and audience's action (§9),
  else 403 `forbidden`. A target must be a live object of the org on this plugin (or made from
  this template), else 404 `channel.not_found` / `connector.not_found`. `mode` or `audience`
  outside the place's set is 400 `validation_failed`.
- The rendered result is not cached: a render is a PG read of the version row and one stored file
  plus a parse of ≤ 64 KiB.

### 7.3 Web components

- `packages/design` gains `GuideDocument` (renders `blocks`: `Markdown` for prose, `CodeBlock`
  with `title` and `copyable` for code, `CheckRow` for checks) and `CheckRow` (a status row: an
  icon for ok / failing / unknown / running, the label, the reason and fix as muted prose lines,
  the checked-at time and a 重新检查 / Re-check ghost button). Both follow "one box is enough":
  they draw no box and are placed in the page's section card. Design spec §6.9 and a new §6.x
  entry; `/dev/ui` fixtures; zh and en strings **(designer's call)**.
- `apps/web` replaces v1's `SetupGuideBody` with `SetupGuideSection` (one component for every
  place): the mode switch (`Segmented`) when `modes.length > 1`, `GuideDocument`, the unresolved
  lines from `unresolved[].reason`, and the drift notice and ack when the place has drift (§11).
  `InstructionList` stays in the design system for other uses.

## 8. Mode sections and the mode switch

- A place defines its modes; a document uses some of them in `::: mode` sections; the page shows
  the switch when the rendered guide has more than one mode, starting at the target's stored mode
  (`channel_connections.inbound_mode`) or the place's first. Switching re-renders through the
  route with `mode`.
- A mode the document does not use renders only the text outside mode sections.
- Checks inside a mode section belong to that mode; switching modes changes the rows.
- Audiences are not switched by the person: the page passes the audience it serves (§9). An org
  admin on the member page sees the member text, as a member would.

## 9. Places and UI

### 9.1 The place registry

```ts
export const SETUP_GUIDE_PLACES = ["channel-connection", "connector-template"] as const;

interface SetupGuidePlaceInfo {
  modes: readonly string[];
  audiences: readonly SetupGuideAudience[];       // "admin" | "member"
  variables: Readonly<Record<string, "url" | "text" | "token">>;
  /** The org action each audience needs besides catalog.read. */
  actions: Readonly<Partial<Record<SetupGuideAudience, OrgActionName>>>;
  /** Whether targets of the place record acks (§11). */
  drift: boolean;
}
```

| Place | Modes | Audiences (action) | Target | Drift |
|---|---|---|---|---|
| `channel-connection` | `long_connection`, `webhook` | admin (`channels.manage`) | channel connection | yes, per mode |
| `connector-template` | none | admin (`connectors.manage`), member (`connectors.use`) | connector made from the template | yes, admin audience |

The registry lives in the SDK (the toolchain validates against it); the kernel adds, per place,
the value resolver, the target lookup and the page links. A new place is a registry entry, a
resolver, a target lookup and the page that embeds `SetupGuideSection` (decided: more places are
just new place ids).

### 9.2 Channel connections (as v1)

- 新建渠道: once a plugin with a `channel-connection` guide is picked, a 接入指南 FormSection after
  the plugin section renders the guide with `name` (the name typed so far) and no target. The
  check rows collapse into one line 「保存后可以逐项检查」 / "Each check runs once saved" (checks
  need a saved target, §10.4), and everything after the document's last top-level thematic break
  (`---`) is reference material for a saved connection, not shown before save (amended 2026-11-09,
  `2026-11-09-channel-inbound-mode-fields-design.md` §5). The mode switch is the connection's
  inbound mode there (sent as `inboundMode` on create, same spec).
- Channel detail: a 接入指南 section for the connection (its mode by default) with live checks, and
  above it the drift notice and 「我已更新 Slack 应用」 when drifted, as v1.
- `GET channels/schema/:plugin` keeps `guide: { itemId, guideId } | null`; connection views keep
  `setupGuide` and `guideDrift`.

### 9.3 Connector templates

The connector template place has four pages (designer's call on which; all of them already exist):

| Page | Who | Audience | Target |
|---|---|---|---|
| `/plugins/<itemId>/enable` (CatalogInstallWizard), the template's connector step | org admin | admin | none (checks show "checked after saving") |
| `/plugins/<itemId>/connectors` (补充配置) and `/connectors/install?template=` | org admin | admin | none |
| `/connectors/<connectorId>`, for a connector made from a template with a guide | org admin | admin | the connector; live checks; drift notice and ack |
| `/account/connections`, the connector's row | member | member | the connector; a 如何连接 / How to connect link opening a Sheet with the member text and its checks |

- In the wizard step the guide sits above the client fields as its own FormSection, because the
  admin must register `{{oauthCallbackUrl}}` at the third party before they have a client id to
  type.
- The member link appears only when the document has a `member` section.
- How a template page finds its guide: the org catalog item view and the template list
  (`connectors.templates`, `GET …/catalog/:itemId` templates) gain `guide: { itemId, guideId } |
  null` per template, and connector views gain `setupGuide` and `guideDrift` like channel
  connections. The template resolves to the plugin's latest version's guide whose `template` is
  the template id; a connector resolves through `connectors.platform_template_id` (or its catalog
  source for org-owned plugins) to its template.
- **The super admin's `/admin/connector-templates/<id>`** shows the template's guide, admin
  audience, with no org and no target (decided 2026-11-09): `orgName` and `connectorName` are
  unresolved, checks are not shown (they need a target), there is no drift notice. Route:
  `GET /api/v1/admin/catalog/:itemId/guides/:guideId?locale=` (`@SuperAdmin`), the same renderer
  with the platform visibility of the item.
- **Org admins on the member sheet** (decided 2026-11-09): the 如何连接 sheet on
  `/account/connections` shows an org admin (role ≥ admin, `connectors.manage`) a link
  「查看管理员接入指南」 / "Open the admin setup guide" to `/connectors/<connectorId>` (the admin
  text with its checks); members do not see it.

### 9.4 Later places (designed, not built)

| Place | Modes / audiences | Variables beyond the common ones | Page |
|---|---|---|---|
| `model-provider` | — / admin | the provider's callback URL if any | the model provider's config page |
| `extension-config` | — / platform admin, org admin | per extension | the deployment / org extension config form |
| `sandbox`, `object-store` | — / platform admin | none yet | the admin console's provider pages |

Platform-level places need a `platform` audience whose action is the super admin check; the
registry's `actions` takes `{ superAdmin: true }` then. No other shape changes.

## 10. Checks

### 10.1 What a check is

A check answers one question about one target ("does this bot token work?") with:

```ts
export type SetupCheckStatus = "ok" | "failing" | "unknown";

export interface SetupCheckResult {
  status: SetupCheckStatus;
  /** Why, in a sentence: "Slack accepted the token for workspace Acme." ≤ 300 characters each. */
  reason?: { en: string; zh?: string };
  /** What to do when failing: "Reinstall the app and copy the new Bot User OAuth Token." ≤ 500. */
  fix?: { en: string; zh?: string };
}
```

- `ok`: verified now. `failing`: verified wrong, with a reason and (should) a fix. `unknown`: could
  not tell (the third party is down, rate limited, the check does not apply yet); never a
  failure the person must act on.
- Reason and fix are plain text (the web renders them as text; no Markdown), English required.
- A check **never writes**, at the third party or in Capybara, and must be cheap (one or two
  read calls). This is a contract rule the review and the writing-extensions skill state; it is
  not enforceable in process (full trust).

### 10.2 The SDK contract: `ctx.setup.check`

**(designer's call: a registration on `ctx`, like `ctx.ui.view`, not an extension point.)**
Extension points are swappable providers with a cardinality; a check belongs to exactly one
plugin and is addressed by `<plugin>` + id, which is the `ctx.ui.view` shape: registered in
`setup`, declared in the manifest, statically checked.

```ts
// packages/plugin-sdk/src/setup-guide.ts
export interface SetupCheckArgs {
  orgId: string;
  /** The extension's effective config for the org (platform config + the org's copy). */
  config: unknown;
  locale: "en" | "zh";
  mode: string | null;
  target: SetupCheckTarget;
  /** Aborted at the kernel's timeout (§10.5) or when the extension is disposed. */
  signal: AbortSignal;
}

export type SetupCheckTarget =
  | {
      kind: "channel-connection";
      connectionId: string;
      /** The connection config as `channel@1` verify and connect receive it, secrets included. */
      config: unknown;
    }
  | {
      kind: "connector";
      connectorId: string;
      templateId: string;
      /** The OAuth client id when the template uses a manual client; never the secret. */
      clientId: string | null;
      /** The viewing member's account, for member-audience checks; never their token. */
      accountId: string | null;
    };

export interface SetupCheckDefinition {
  place: SetupGuidePlace;
  run(args: SetupCheckArgs): Promise<SetupCheckResult>;
}

interface Ctx {
  setup: {
    /** Only in setup; `id` must be in permissions.setupChecks. Registering an id twice throws. */
    check(id: string, def: SetupCheckDefinition): void;
  };
}
```

Example (slack):

```ts
ctx.setup.check("bot-token", {
  place: "channel-connection",
  run: async ({ target, signal }) => {
    if (target.kind !== "channel-connection") return { status: "unknown" };
    const { botToken } = connectionSchema.parse(target.config);
    if (!botToken) return { status: "unknown", reason: { en: "No bot token is set yet." } };
    const r = await slackApi("auth.test", botToken, { signal });
    return r.ok
      ? { status: "ok", reason: { en: `Slack accepted the token for ${r.team}.` } }
      : {
          status: "failing",
          reason: { en: `Slack refused the token (${r.error}).` },
          fix: { en: "Reinstall the app and copy the new Bot User OAuth Token." },
        };
  },
});
```

- **Manifest**: `permissions.setupChecks: string[]` (each `^[a-z0-9][a-z0-9-]{0,47}$`, ≤ 32).
  Like `ui.view:*`, a `setupCheck:<id>` permission is recorded in the snapshot and shown at review
  but **never blocks loading** **(designer's call)**: a check receives only data the extension
  already receives for the same target (a channel connection's config goes to `verify` and
  `connect`; for a connector it gets ids and the client id, which is not a secret), so it opens
  no new data path. A brand-new extension still needs approval as a whole.
- **Static check** `perm-setup-check` in `pnpm check:extension-permissions`: the id of
  `ctx.setup.check(id, …)` is a literal or same-file const listed in `permissions.setupChecks`
  (same rules and exemption comment as `perm-ui`), proven red on a fixture first.
- **What a connector check does not get (decided 2026-11-09)**: plugin checks never get the OAuth
  client secret or members' tokens; they stay with the kernel and the connector extension's
  `auth()`. The template's plugin (slack) is not the connector extension (connector-mcp) and has
  never held them. The kernel check `capybara:oauth-token-endpoint` (§10.6) verifies the stored
  client against the token endpoint with the secret staying in the kernel.
- The plugin's checks run only in its own extension, and only for targets of its own plugin (a
  channel connection on the plugin, a connector made from one of its templates).

### 10.3 Kernel routes

- `GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks` with the guide route's target,
  `mode` and `audience` → `{ results: Record<checkId, SetupCheckState> }`: the cached state of
  each check of the rendered guide, **never running anything**.
- `POST /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId/checks/:checkId/run`, body
  `{ connectionId? | connectorId?, mode?, audience?, force?: boolean }` → `{ result:
  SetupCheckState }`: runs the check unless a fresh cached result exists (or `force`), §10.4.

```ts
interface SetupCheckState {
  status: SetupCheckStatus | "running" | "not_run";
  reason?: { en: string; zh?: string };
  fix?: { en: string; zh?: string };
  checkedAt?: string;            // ISO time of the result
  cooldownUntil?: string;        // force refused until then
}
```

- Authorization is the guide route's: catalog visibility, then the place and audience action.
  The check must be in the rendered guide for that mode and audience (else 404
  `catalog.check_not_found`) and needs a target (400 `validation_failed`, "checks need a saved
  connection").
- Error mapping into results, not HTTP errors (the row shows them): the extension is not loaded
  on this replica, disabled in the org, or `needsConfig` → `unknown` with a kernel reason ("The
  Slack plugin needs configuration in this organization; an org admin configures it under
  Plugins."); the check id is not registered → `unknown` ("This check needs a newer version of
  the plugin"); a throw → `unknown` ("The check failed to run; retry later"), the error logged
  redacted; a timeout → `unknown` ("The check timed out"); an invalid result (wrong shape, too
  long) → `unknown`, logged.
- `POST …/run` is `@Throttled` (30 per minute per account) **(designer's call)**; over it, 429
  `rate_limited` and the page keeps the last state.

### 10.4 When checks run, and caching

**(designer's call)**:

- **On view, from cache first.** The page reads `GET …/checks`; for each row in `not_run` or with
  a stale result, it calls `POST …/run` without `force` (at most 4 at a time per page). A fresh
  result is returned as is, so many viewers and reloads cost one third-party call per check per
  TTL.
- **On demand.** 重新检查 calls `POST …/run` with `force: true`, allowed once per 10 seconds per
  check and target (`cooldownUntil` otherwise; the cached result is returned).
- **Freshness**: a result is fresh for 5 minutes and for the same **input fingerprint**: an HMAC
  (kernel key) over the target's config revision (`updated_at` of the connection or connector and
  of its credentials row), the extension's effective config revision for the org, the plugin
  version and the mode. Saving a new bot token changes the fingerprint, so the next view reruns
  the check at once. The fingerprint carries no secret and cannot be reversed to one.
- **Never before a target exists.** On 新建渠道 and in the wizard the rows say "checked after
  saving"; no request carries secrets typed into an unsaved form.
- **Not in the background.** Nothing runs checks on a schedule in this delivery (no queue, no
  cron); a check runs only when a person or an agent asks. Background re-checks and admin
  notifications are later work (§2 non-goals, decided 2026-11-09).

### 10.5 Timeouts, limits and errors

| What | Value |
|---|---|
| Per check run | 10 s; the kernel aborts `signal` and records `unknown` ("timed out") |
| Concurrent runs per org (all replicas) | 8; beyond it the run returns `running` and the page retries |
| Forced reruns | 1 per 10 s per check and target |
| Result fresh for | 5 min (and the same fingerprint) |
| `POST …/run` per account | 30 / min |
| Reason / fix | 300 / 500 characters per language; longer → `unknown`, logged |

The extension must pass `signal` to every request (as `ctx.ui` handlers do) and must not retry
inside the check (the person retries; retry policy is the kernel's, as for model providers).

### 10.6 Kernel checks (`capybara:*`)

Checks the kernel answers from its own state, usable by any guide of the place, with no plugin
code **(designer's call on the list)**:

| Id | Place | ok when |
|---|---|---|
| `capybara:public-url` | any | `http.publicUrl` is set (failing: "ask your super admin to set http.publicUrl") |
| `capybara:webhook-public` | channel-connection (webhook) | `channels.webhookBaseUrl` is set and https (the kernel builds webhook URLs from it only, never from `http.publicUrl`) |
| `capybara:webhook-received` | channel-connection (webhook) | a webhook request for this connection passed the plugin's signature check within 7 days (needs the marker below); unknown when none yet |
| `capybara:connection-active` | channel-connection | the connection's `status` is `active`, it has a `bot_user_id` and no `last_error`; `disabled` → failing ("enable it"); `error` or a recorded `last_error` (an active connection retrying) → failing with the `last_error`, redacted again by the connection's secrets over the whole text, cut to 200 characters, and kept only when the result passes validation (control, bidi, separator and lone surrogate rules), else a generic reason; active without a bot identity yet → unknown |
| `capybara:oauth-client` | connector-template | the connector's manual OAuth client id and secret are both stored |
| `capybara:connector-tools` | connector-template | the connector has a tool snapshot (some member connected and the tool list was read); unknown before that |
| `capybara:connector-connected` | connector-template (member) | the viewing member holds a credential for the connector |
| `capybara:oauth-token-endpoint` | connector-template | the token endpoint authenticates the stored client (below) |

**`capybara:oauth-token-endpoint` (decided 2026-11-09: the secret stays in the kernel).** For a
connector whose auth is `oauth_code` with `client: "manual"`, the kernel resolves the token
endpoint as a member's connect would (discovery for `discovery: "mcp"`, the template's `tokenUrl`
for `manual`), then posts one authorization-code exchange with the stored client and a fixed,
invalid code (`code=capybara-setup-probe`, the connector's redirect URI, the template's
`tokenAuthMethod`), through `packages/kernel/src/net` (no redirects, the deployment's egress
rules), 10 s. The answer is read with the OAuth flow's existing refusal parser:

| Token endpoint answers | Status | Reason / fix |
|---|---|---|
| `invalid_grant`, Slack `invalid_code` (the client authenticated, the code is bad, as intended) | ok | "The token endpoint accepted the client." |
| `invalid_client`, `unauthorized_client`, Slack `invalid_client_id`, `bad_client_secret`, HTTP 401 | failing | "The token endpoint refused the client id or secret." / "Copy the Client ID and Client Secret again from the app's Basic Information page." |
| `redirect_uri_mismatch`, Slack `bad_redirect_uri` | failing | "The app does not list the callback URL." / "Add `{{oauthCallbackUrl}}` to the app's redirect URLs." (rendered) |
| anything else, 429, 5xx, a network error, a 2xx with a token (never expected) | unknown | "Could not verify the client; retry later." A token in a 2xx body is discarded unread and not stored. |

It never logs the request body, never stores what it receives and is subject to every limit in
§10.5. Clients from dynamic registration (`client: "dcr"`) answer `unknown` ("Registered
automatically; nothing to check").

Implementation notes (plan task 11):

- "The token endpoint as the connect flow resolves it" is the stored client record's
  `tokenEndpoint` (written at install from discovery or the template's `tokenUrl`) with its
  stored auth method, exactly what the OAuth callback posts the real code to; the redirect URI is
  the callback URL (`http.publicUrl` + `/api/v1/oauth/callback`; without `http.publicUrl` the
  probe answers unknown). The fixed PKCE verifier and the client's `resource` are sent as the flow
  does.
- The deployment's network rules for the probe are `net.httpsProxy` / `net.noProxy`,
  `marketplaces.allowPrivateHosts` (the kernel's one list of internal hosts it may reach) and
  loopback http only under `tools.oauthAllowInsecureLoopback`. A token endpoint on an internal
  address that the list does not name answers unknown with a fixed text naming the network rules
  (the connect flow itself is not under these rules yet).
- Only answers that can carry a refusal (200, 400, 401) are read, at most 64 KiB, and only for
  the refusal code (`parseTokenRefusal`, the parser `tokenRequest` uses); any other 401 is a
  refused client. Other bodies are dropped unread.
- Every kernel check is cached per account (§10.7), the probe included, so it runs once per admin
  per freshness window, inside each admin's run budget and the org's cap. It does not depend on
  the account and could be shared per org, but a per-check scope flag is not added: the cost is a
  handful of token requests per org per five minutes, and keeping every kernel answer per
  account means no kernel check ever needs a reviewed exception to the "one admin's answer is
  never another admin's" rule.
- The kernel's redaction sources for a connector (`Credentials.checkMaterial`) also list the
  forms the values are sent in, as `injectionSecrets` does for a tool call: `Bearer` / Basic
  header values, the base64 token, the decoded `user:pass`, the `encodeURIComponent` forms, and
  for the OAuth client the `client_secret_basic` header the token request sends and `id:secret`.

`capybara:webhook-received` needs one new fact: when the gateway accepts a verified webhook
(`onWebhook` returned `accept`) it sets the Redis key `capk:channel-webhook-seen:<connectionId>`
with a 7-day TTL, at most once a minute per connection (`SET … NX` on a minute key) **(designer's
call: Redis, not a PG write per webhook)**.

### 10.7 Multi-replica

- No in-process state: results, cooldowns, the per-org concurrency count and single-flight live in
  Redis (`capk:setup-check:<orgId>:<targetKind>:<targetId>:<plugin>:<checkId>:<mode>` → the
  redacted result with its fingerprint, TTL 5 min; `…:cooldown`, TTL 10 s; a per-org counter with
  a TTL for the semaphore). Every key has a TTL.
- **Single flight**: before running, the replica takes `capk:setup-check-run:<same key>` with
  `SET NX PX 15000`. A second viewer (any replica) that fails to take it gets the cached result or
  `running`; the page re-reads `GET …/checks` once a second while any row is `running`, up to the
  timeout. The lock is released after the result is written; its TTL covers a crashed replica.
- The check runs on the replica that took the lock, in the extension loaded there (every replica
  loads every enabled extension). A replica where the extension is not loaded answers `unknown`.
- Redis down: checks answer `unknown` ("checks are temporarily unavailable"); guides still render
  (they need only PG). Fail closed for running, open for reading the guide.

### 10.8 Results never leak secrets

- The extension is told never to put a secret in a reason or fix (writing-extensions skill), and
  the kernel enforces what it can before caching or returning: every secret value of the target
  (the connection's `secret()` fields, the connector's stored credentials) and of the org's
  effective config of 8 characters or more is replaced by `[REDACTED]`, as connector results are
  redacted by injected values; the result is then length-checked.
- Results carry no structured details (no `data` field), so there is no place for a token to hide
  **(designer's call)**.
- Logs of a failed check go through the kernel's redacting logger with the same values.

## 11. Drift

v1's rules carry over (decided); what changes is the hash and the second place.

- **The hash covers code blocks and check lines only (decided 2026-11-09)**: sha256 over
  `"capybara-guide-v2" NUL place NUL guideId NUL (mode or "") NUL audience NUL` followed, in
  document order, by each item of the English document after section selection for that mode and
  audience: a fenced code block as `"code" NUL language NUL text NUL` (title excluded) and a check
  line as `"check" NUL checkId NUL`; variables are not substituted and line endings are normalized
  to LF. Prose and typo edits, headings and check labels never raise a notice; a changed manifest,
  an added, removed or moved code block, or an added or removed check does. Variable values are
  left out (renaming a connection or moving the public URL is not plugin drift, as v1 held). The
  Chinese document is left out because its code blocks equal the English ones and it carries the
  same checks (§4.3).
- **Acks**: `channel_connections.guide_ack` stays; `connectors.guide_ack jsonb` is added. Both
  hold `{ guideId, version, hash, mode: string | null }`.
- **Channel connections**: exactly v1 §6: recorded on create (the current guide of the default
  mode), on a PATCH that switches `inboundMode` only when there is no ack or the ack shows no
  drift, and by `POST …/channels/:connectionId/guide-ack { hash }`; **a mode switch never clears
  drift**; the ack route records the current mode's guide and checks the posted hash against it
  (409 `channel.guide_changed` when it moved on); drift is judged on `guide_ack.mode`; no ack, no
  notice.
- **Connectors made from a template**: recorded when the connector is created from the template
  (the wizard and 补充配置 showed the current guide; admin audience, no mode) and by
  `POST /api/v1/orgs/:orgId/connectors/:connectorId/guide-ack { hash }` (`connectors.manage`;
  409 `connector.guide_changed`; 404 `catalog.guide_not_found`; audited
  `connector.guide_confirmed`). Drift = an ack, the template's current guide has the same id and
  its admin hash differs; connector views carry `guideDrift: { from, to } | null`. The notice on
  `/connectors/<id>`: 「Slack 插件更新了连接器的接入配置（v0.1.0 → v0.2.0）：需要在 Slack 应用里
  更新 manifest」 with 「我已更新 Slack 应用」.
- **The member audience has no drift**: members configure nothing at the third party.
- **Template update preview** (super admin, plugin update): when an updated plugin changes the
  admin hash of a template's guide, the preview says "the setup guide of template X changed; org
  admins of N orgs will be asked to update their app" **(designer's call: the counts rule of the
  Platform spec §6.1 applies)**.
- Everything is in PG (acks on the rows, documents and hashes from version rows); no cache.

## 12. Agent-assisted setup (`Platform` operations)

A new domain `setup` **(designer's call: one domain an agent finds by browsing, instead of
guide operations scattered over `channels`, `connectors` and `plugins`)**:

| Operation | Class | Mirrors | Returns |
|---|---|---|---|
| `setup.guides` | read | `GET /api/v1/orgs/:orgId/setup-guides` (new) | The guides this person may see in the org: plugin, guide id, place, title, and per target (channel connections, connectors from templates, templates switched on without a connector) its drift and a summary of cached check states; the web path of each page |
| `setup.read` | read | `GET …/catalog/:itemId/guides/:guideId` | The rendered guide as one Markdown document (blocks joined; checks as `- [check bot-token] Bot token works` lines), modes, mode, audience, unresolved with reasons, the page's web path |
| `setup.status` | read | `GET …/guides/:guideId/checks` | The cached check states |
| `setup.check` | read | `POST …/guides/:guideId/checks/:checkId/run` | One check's state after running it (or the fresh cached one) |

- The new list route serves the web too (a "needs setup" list on the plugins page later) and is
  what `setup.guides` mirrors, since an operation mirrors a route and adds no logic (Platform spec
  §7, `check:platform-ops`). The v1 exclusion of the guide route is removed (it is mirrored now). The super admin's
  template guide route (`GET /api/v1/admin/catalog/:itemId/guides/:guideId`, §9.3) is an
  exclusion, category `internal`: a preview for the admin console, while `setup.read` serves the
  org guides an agent assists with.
- **`setup.check` is a read-class operation with no confirmation (decided 2026-11-09)**: it changes nothing anywhere (contract §10.1), its
  cost is bounded by the cache, the cooldown and the throttle, and a confirmation card for "check
  the bot token" would teach people to click through cards. `force` is available to agents with
  the same cooldown.
- Operation descriptions and errors are English and actionable; `setup.read` says where on the web
  the person types each value ("Ask the person to paste the Bot token into the Bot token field on
  {webPath}; never ask for it in the conversation").
- A `setup` docs topic (`Platform` `read setup`) explains the flow for agents: list, read, explain
  the step the person is on, run checks after they say they did it, explain a failing reason and
  fix, and hand over to the page for every secret and for the ack.

**Human-only boundaries (decided: entering secrets stays human-only; agents never see secret
values)**:

| Stays with a person | Why | How it is enforced |
|---|---|---|
| Entering or rotating a secret (bot token, app token, signing secret, OAuth client secret) | The value must not enter the event log | Channel config writes and connector credentials are already exclusions or `plugin.needs_input` (Platform spec §6.4); no setup operation takes a value |
| Connecting a personal account (OAuth consent) | Only the person can consent at the third party | The connect flow is a browser redirect, an exclusion |
| The ack 「我已更新应用」, for channels and connectors | Only the person knows they changed the third-party app | Both ack routes are `human-only` exclusions |
| Creating the app at the third party | Outside the platform | — |

What an agent may do in the flow: read guides and checks, run checks, switch a channel's inbound
mode (`channels.update`, class `org`, confirmed) and other existing confirmed operations. What an
agent sees: the rendered guide (public URLs, names, the manifest; no secret by §6.3), check
results (redacted, §10.8) and states; never config values or credentials. A person who pastes a
secret into the chat anyway is warned before it is sent (§12.1).

### 12.1 Token paste warning in the composer (decided 2026-11-09)

The conversation composer warns, client side and before sending, when the draft holds something
that looks like a credential. It is a guard against a slip, not a security boundary: nothing is
sent to the kernel to decide, and nothing blocks sending.

- **When**: on paste into the composer and again on send; the draft is scanned in the browser
  (a pure function `findTokenLikeSpans(text): { start; end; kind }[]` in `packages/design`,
  next to the composer). Typed text is checked only on send.
- **Patterns** (case-sensitive, each on a word boundary; `kind` in parentheses):
  - Slack: `xox[bpae]-[0-9A-Za-z-]{10,}` (slack-token), `xoxr-[0-9A-Za-z-]{10,}` (slack-token),
    `xapp-[0-9]-[0-9A-Za-z-]{10,}` (slack-app-token);
  - GitHub: `ghp_[0-9A-Za-z]{36}`, `gho_`, `ghu_`, `ghs_`, `ghr_` with the same tail
    (github-token), `github_pat_[0-9A-Za-z_]{22,}` (github-token);
  - model and cloud keys: `sk-[0-9A-Za-z_-]{20,}` (covers `sk-ant-…`, `sk-proj-…`; api-key),
    `AKIA[0-9A-Z]{16}` (aws-key), `AIza[0-9A-Za-z_-]{35}` (google-key);
  - private keys: `-----BEGIN [A-Z ]*PRIVATE KEY-----` (private-key);
  - JWTs: `eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}` (jwt);
  - **long high-entropy strings**: a run of ≥ 32 characters from `[A-Za-z0-9+/=_-]` with Shannon
    entropy ≥ 4.0 bits per character that contains at least one digit and one letter, outside
    a fenced or inline code span that also holds whitespace-separated words, and not a URL path,
    a UUID (`8-4-4-4-12` hex), a 40- or 64-character lowercase hex string (commit and content
    hashes) or a `data:` URI (high-entropy).
- **UX**: a non-blocking warn `Callout` above the composer: 「这段内容看起来像密钥或令牌（Slack
  令牌）。密钥只应填在设置页的对应字段里，不要发到对话中。」 / "This looks like a secret or token
  (Slack token). Secrets belong in the setting's field, not in the conversation." with two
  actions: 「移除」 / "Remove" (deletes the matched spans from the draft) and 「仍然发送」 / "Send
  anyway" (sends the draft unchanged). On send with a match, the first Enter shows the warning
  instead of sending; 「仍然发送」 or a second Enter sends. Editing the draft so no span matches
  clears the warning. The matched spans are not highlighted in the textarea (no overlay
  component). Nothing is logged or reported; the match never leaves the browser.
- Everywhere the composer is used (new conversation, a conversation, sub-agent replies), not
  only in assisted setup: a pasted token is equally wrong anywhere.

An entry point from the page **(designer's call)**: the 接入指南 section has 让智能体协助 / Ask an
agent, which opens a new conversation with the person's default agent and a draft (not sent)
"Help me finish setting up <title> for <target name>", so the agent starts from `setup.guides`.

## 13. Security

- **Active content**: none can reach the page (§7.1): no raw HTML, no images, https links only
  (or kernel-built http URLs), all text through mdast and the design `Markdown`, which has its own
  guards. Code blocks are text in `<pre>`.
- **Injection through values**: values are substituted into the parsed tree and escaped per node
  (§6), so a name cannot become syntax, a link or a broken YAML string; private-use sentinels are
  refused in source.
- **Secrets**: no variable reads one (§6.3); checks receive what the extension already receives
  and nothing more (§10.2); results are redacted, bounded and detail-free before caching (§10.8);
  fingerprints are HMACs of revisions, not of values; agents read only rendered guides and results
  (§12). Tests render a guide and run checks for a target with secrets and assert the secrets are
  absent from every response, cache entry and log line.
- **Cross-tenant**: catalog visibility (one shared function, as v1), target ownership (org and
  plugin / template) and the place action are checked on every guide and check route; Redis keys
  carry the org id; the per-org semaphore keeps one org from starving others.
- **Third-party load**: cache, single flight, cooldown, throttle and the per-org cap bound calls
  (§10.4, §10.5); checks never run in the background.
- **Trust**: extensions are in-process and fully trusted (approval is governance, not a
  sandbox); the never-write rule and the no-secrets-in-results rule are contract rules backed by
  review and kernel redaction, not by isolation. This is why the checks contract gets its own
  review (§17).
- **Paths and sizes**: fixed package paths, size and count limits at pack and import (§4.4).

## 14. Multi-replica (summary)

- Guides and drift: PG only, stateless rendering, no cache.
- Checks: Redis for results, cooldowns, single flight and the per-org semaphore, every key with a
  TTL; no timers, no in-process maps; a check runs in the request on the replica that took the
  lock; no queue jobs (nothing periodic).
- The webhook-seen marker is a Redis key set by the gateway role with a TTL.
- Acks are written in `@Transactional()` service methods; the audit row is in the same
  transaction; nothing is published after commit.

## 15. Migration from v1

Pre-0.1.0: the format changes directly, with no compatibility layer (decided).

- **SDK**: `PluginSetupGuide` becomes `{ id, place, template? }`; `SetupGuideStep`,
  `SetupGuideFile`, `SETUP_GUIDE_LANGUAGES`, `SETUP_GUIDE_FILE_RE`, `renderSetupGuideText` and
  `setupGuideFileProblem` are replaced by the document parser and renderer (§4.5); the place
  registry replaces `SETUP_GUIDE_MODES` / `SETUP_GUIDE_VARIABLES`; `ctx.setup` and the check
  types are added. `gen:sdk-api`, a changeset bumping `@capybara-hq/plugin-sdk`.
- **Toolchain**: `pack` ships `guides/<id>.md` and `guides/<id>.zh.md` and runs §4.5; the
  `capybara-plugin guide` command is added.
- **Kernel**: `PluginGuides` renders documents (§6, §7), resolves both places and computes v2
  hashes; the check runner, the two check routes, the list route, the connector ack route, the
  webhook-seen marker, `capybara:oauth-token-endpoint`, the super admin's template guide route and
  the `setup` operations are added; the guide route's exclusion is
  removed.
- **Migration** `0106_setup_guides_v2.sql`: `ALTER TABLE capybara.connectors ADD COLUMN IF NOT
  EXISTS guide_ack jsonb;` and `UPDATE capybara.channel_connections SET guide_ack = NULL WHERE
  guide_ack IS NOT NULL;` **(designer's call)**: a v1 ack holds a v1 template hash that no v2 hash
  can equal, so keeping it would show every existing Slack connection a false notice; clearing it
  follows v1's "no ack, no notice" rule. Those connections start tracking at their next mode
  switch or ack.
- **Stored v1 manifests**: catalog versions imported before v2 have v1-shaped `setupGuides`. The
  reader ignores an entry it cannot parse as v2 (that version shows no guide) and logs it once per
  render; updating the plugin brings the v2 guide **(designer's call: not a compatibility layer,
  just a reader that does not crash on old rows)**.
- **Web**: `SetupGuideBody` and `lib/setup-guides.ts` become `SetupGuideSection` on the design
  `GuideDocument`; the channel pages switch over; the connector pages gain the section.
- **Slack plugin** (`capybara-hq/plugins`, released together with the kernel and SDK): the two
  `guides/*.yaml.tmpl` files, `app-manifest.connector.yaml` and the v1 `setupGuides` entry go;
  `guides/slack-app.md`, `guides/slack-connector.md` and their zh documents (§5) and the three
  checks come in; README sections shortened; tests render both guides in every mode and audience
  with `renderSetupGuide` and run the checks against `startFakeSlack`.
- Docs: the writing-plugins, writing-extensions, writing-connectors, writing-channels and
  writing-web-ui skills (core and plugins), design spec §6.9 / new entry, and v1's spec gets a
  "superseded by" line.

## 16. Testing

- **SDK** (pure): parsing (title, sections, nesting rule, check lines, fence titles, indented code
  refused, private-use refused), validation messages, language parity, escaping per context
  (table-driven: a hostile name with `` ` ``, `"`, newlines, `[x](javascript:…)`, `<script>`,
  `{{other}}` in every context; YAML and JSON blocks parse back to the exact value; URL-, `www.`-
  and email-looking names stay text when the output is parsed again), link policy, HTML as text,
  images as links, determinism, the hash (rename, URL change, prose, heading and check label edits
  keep it; a code change, an added or removed code block and an added or removed check line move
  it, §11).
- **Toolchain**: `pack` / `check` fixtures for every refusal, proven red; `guide` command output.
- **Kernel**: rendering for both places, all audiences and modes, with and without targets;
  visibility and role refusals (member on admin audience, org without the item, other org's
  connection); unresolved reasons; the secret-absence test (a connection and a connector with
  secrets set: nothing in the guide, check results, Redis values or captured logs); acks and
  drift for channels (the v1 matrix kept, including the mode-switch rule) and connectors; the
  migration clearing v1 acks.
- **Checks**: a fake extension in `@capybara-hq/testing` (`fake-setup-checks`) with checks that
  pass, fail, throw, hang, return oversized or secret-bearing text and ignore `signal`; timeout,
  redaction, `needsConfig`, disabled in org, not registered; cache freshness and fingerprint
  change; cooldown; throttle; the dual-replica harness for single flight (two replicas, one
  third-party call, the other sees `running` then the result) and the per-org semaphore; Redis
  down.
- **Kernel checks**: each `capybara:*` check, the webhook-seen marker set once per minute;
  `capybara:oauth-token-endpoint` against `startFakeOAuthServer` (default and `dialect: "slack"`)
  for each row of its table, asserting the client secret is absent from logs and results and a
  token in a 2xx body is not stored.
- **Composer token warning**: `findTokenLikeSpans` table tests (every pattern, and the
  non-matches: UUIDs, commit hashes, URLs, prose, code with words); composer tests for paste,
  Enter, 移除 and 仍然发送.
- **Admin template guide**: the super admin route renders with `orgName` unresolved and no checks;
  an org admin gets 403.
- **Platform**: parity and `check:platform-ops` for the four operations; `setup.read` contains no
  secret; ack routes stay excluded; the docs topic passes `check:agent-docs`.
- **Static check**: `perm-setup-check` red on a fixture first, documented in
  `tools/checks/README.md` (runs in full on PRs, as `perm-ui` does: a cheap source scan).
- **Web**: `SetupGuideSection` with the query cache helpers (blocks, mode switch, unresolved lines,
  check rows in every state, 重新检查 cooldown, drift and ack for both places); `GuideDocument`
  and `CheckRow` in `/dev/ui` and jsdom (`findNestedBoxes`); visual baselines through
  `visual-update`.
- **Plugins repo**: Slack guide renders, checks against `startFakeSlack` (token ok, revoked token,
  missing scope, app token), and a live run with `CAPYBARA_TEST_SLACK_*` where available.

## 17. Delivery order

One delivery and one plan (decided): every layer is designed here and built before the work is
called done; nothing is deferred to a later release. The plan runs in ordered waves because each
layer builds on the one before:

1. **Format, rendering and places.** SDK parser, validator, renderer and place registry; toolchain
   (`pack`, `check`, `guide`); kernel rendering for `channel-connection` and
   `connector-template` (org pages and the super admin's template page), target lookups, the list
   route, v2 hashes, the connector ack and drift, the migration; design `GuideDocument` and the web
   section on every channel and connector page, with check rows drawn as static rows until wave 2.
   Everything later depends on the parsed document and the place registry.
2. **The checks contract.** `ctx.setup.check`, `permissions.setupChecks` and `perm-setup-check`;
   the runner, Redis cache, single flight, cooldown, semaphore, redaction; the two check routes;
   the `capybara:*` checks (including `oauth-token-endpoint`) and the webhook-seen marker;
   `CheckRow` live states. Depends on wave 1's rendered `checks` list and targets. **This wave is
   a trust-boundary change (extension code receiving secrets for a new purpose, the kernel calling
   a token endpoint with a stored client secret, results crossing to the browser and to agents,
   multi-replica state): its tasks are reviewed on their own, on the most capable model, per the
   wave-planned-subagent-development skill.**
3. **The `Platform` operations and the assisted flow.** The `setup` domain and its four
   operations, the docs topic, the exclusion changes, the 让智能体协助 entry and the composer's token
   paste warning. Depends on wave 1's routes and wave 2's check routes, since operations only
   mirror routes.
4. **Docs, skills and visual baselines** in core, after the code waves: the skills and design spec
   entries of §15, baselines rendered by the `visual-update` workflow.
5. **The Slack plugin** in `capybara-hq/plugins`, after a core release publishes the SDK, the
   toolchain and `@capybara-hq/testing` with v2: `slack-app.md`, `slack-connector.md` and their zh
   documents, the three Slack checks, the removed v1 files, README, version bump and changeset.

Waves may overlap where files are disjoint, but none merges out of order; the plan
(`docs/superpowers/plans/2026-11-09-setup-guides-v2.md`) splits the waves into tasks with
disjoint files.

## 18. Decisions on the review questions (maintainer, 2026-11-09)

The maintainer approved the design and answered the questions the draft left open; each answer is
folded into the section it changes.

1. **Drift** hashes code blocks and check lines only; prose and typo edits raise no notice (§11).
2. **Chinese code blocks** are byte-equal to the English ones; `pack` / `check` and the importer
   enforce it with an error naming the block and line (§4.3).
3. **Plugin checks never get the OAuth client secret**; the kernel check
   `capybara:oauth-token-endpoint` probes the token endpoint with the stored client, the secret
   staying in the kernel (§10.2, §10.6).
4. **`setup.check`** is a read-class operation with no confirmation (§12).
5. **No background re-checks or admin notifications** in this delivery; listed as later under
   non-goals (§2).
6. **The super admin's `/admin/connector-templates/<id>`** shows the template's guide, admin
   audience (§9.3).
7. **Token paste warning**: the composer warns client side before sending when the draft holds
   something token-like, with a pattern list and a non-blocking warn with 「仍然发送」 (§12.1).
8. **Org admins on the member sheet** get a link to the admin guide (§9.3).
