# Channel inbound mode on 新建渠道, and fields that follow it

Status: approved by the maintainer (2026-11-09, acceptance feedback on 新建渠道 with Slack).
Builds on `2026-11-09-setup-guides-v2-design.md` (§8 mode switch, §9.2 channel connections) and the
extension config forms spec (config UI hints, `x-ui`).

## 1. Problem

On 新建渠道 the guide's mode switch only changes which instructions show: the connection is always
created in `long_connection` (`POST /channels` has no `inboundMode`), and the credential fields do
not follow the mode. Slack's `appToken` (Socket Mode) and `signingSecret` (webhook) are both
optional in its connection schema, so the form asks for neither, and a webhook connection can only
be made by creating a long-connection one and switching it on the detail page.

## 2. Contract: the `inboundModes` hint

`ConfigUiHints.inboundModes?: ChannelInboundMode[]` (`"long_connection" | "webhook"`), in
`@capybara-hq/plugin-sdk` `config-ui.ts`:

- Allowed only at the `connection` level and only on a top-level field of the connection schema
  (`validateConfigUi` reports it elsewhere); a non-empty list of known modes, each once. A secret
  field may carry it.
- Meaning: the field belongs to those inbound modes. A form draws it only when the connection's
  mode is listed, and there it is **required**, whatever the zod schema says (the schema keeps it
  optional, because the other mode does not use it). A field without the hint is drawn in every mode.
- `inboundModeFields(schema)` (pure, SDK) lists the hinted top-level fields and their modes;
  `missingInboundModeFields(schema, mode, has)` names the fields a mode requires that have no value.

Slack declares `appToken: inboundModes ["long_connection"]` and `signingSecret: ["webhook"]`
(a plugins PR after the SDK release).

## 3. The kernel enforces it (designer's call)

"Hints never change what validates" stays true for the config schema: the zod parse is unchanged.
The **channel connection service** adds one rule of its own, on top of the parse:

- `POST /channels` takes an optional `inboundMode` (default `long_connection`); `webhook` needs plugin
  support and a usable `channels.webhookBaseUrl` (409 `channel.webhook_unavailable`, as a switch).
- On create, and on an update that changes the config or the mode, every field the effective mode
  requires (§2) must have a value: the parsed config's value, or for a secret left as "keep", the
  stored one. Otherwise 400 `extension.config_invalid` with an issue per field
  (`path` = the field, message `required in <mode> mode`), mapped to the field by the form.
- A rename, rebind, policy or status change does not re-check: a connection made before the hint
  existed keeps working until its config or mode is changed.

Why enforce: a webhook connection without a signing secret refuses every request, and a long
connection without an app token never connects; the API and the Platform tool should not create
either. The hint is read from the connection's form JSON Schema (invalid hints are already
stripped there), so a plugin without the hint behaves exactly as before.

## 4. The schema route says whether webhook is usable

`GET /channels/schema/:plugin` adds `inbound: { webhookSupported, webhookAvailable, webhookPublic }`:
the plugin implements `Channel.webhook`; the kernel would accept webhook mode (a usable
`channels.webhookBaseUrl`); and that base URL is a public https address (not loopback, a private or
link-local IP, `localhost`, `*.localhost`, `*.local`, `*.internal` or a single-label host). Webhook
URLs are built from `channels.webhookBaseUrl`, not `http.publicUrl`, so that is the address checked.

## 5. Web

- 新建渠道: the guide's mode switch is the connection's 接收方式 (a `fill` `Segmented`), sent as
  `inboundMode`. The default is the guide's default, except `long_connection` when webhook is not
  public (`webhookPublic` false), with a one-line hint that webhook needs a public HTTPS address.
  Picking webhook while it is unavailable shows why and keeps 创建 disabled. Without a guide that
  has modes there is no switch and the connection is created in `long_connection`, as before.
- The config form gets the schema for the mode: fields of other modes removed, fields of this mode
  added to `required` (`channelSchemaForMode`). Values typed in a hidden field are kept in the draft
  but not sent.
- Detail page: 凭据 applies the stored mode. Switching modes in 接收方式 shows the fields the new mode
  requires that are not set yet, and saves them with the mode in one PATCH.
- Guide noise on 新建渠道 (setup guides v2 §9.2 amended): check rows collapse into one line
  「保存后可以逐项检查」; everything after the guide's last top-level thematic break (`---`) is
  reference material for a saved connection (Slack: Sign in with Slack, manifest updates) and is not
  shown before save (a web rule on the rendered blocks; the format is unchanged).
- `{{connectionName}}` follows the 名称 field (debounced, the previous render kept while the next
  one loads); with no name typed its reason is `no_name` (「填写名称后显示」), not `not_saved`.

## 6. Not changed

The DB default (`long_connection`), the PATCH semantics, the guide format and the drift rules.
