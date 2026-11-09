# Authoring: the plugin format

A plugin is a directory, packed into a `.tgz` with `capybara-plugin pack` (the published
`@capybara-hq/plugin-tools`; `npx capybara-plugin check` runs the checks).

```
<plugin>/
  .capybara-plugin/plugin.json   the manifest (required)
  package.json                   npm metadata; `version` equals plugin.json `version`
  skills/<name>/SKILL.md         skills (scanned unless plugin.json lists them)
  connectors/<id>.json           connector templates (scanned unless listed)
  agents/<name>.md               agent templates (scanned unless listed)
  themes/<id>.json               themes (scanned unless listed)
  src/index.ts                   the extension (optional; bundled by the packer)
  migrations/*.sql, ui/**        extension migrations and UI files (optional)
```

A plugin without `src/index.ts` is declarative: skills, templates and themes only, no code runs.

## plugin.json

Add `"$schema": "https://capybarahq.com/schemas/plugin.v1.schema.json"` for editor support. The
file is strict: an unknown key is an error. Fields (agent templates are listed under `agents`):

<!-- generated:plugin-manifest -->
| Field | Type | Required |
|---|---|---|
| `schemaVersion` | `1` | yes |
| `name` | string | yes |
| `version` | string | yes |
| `publisher` | string | yes |
| `description` | string or object | yes |
| `displayName` | object | no |
| `icon` | string | no |
| `license` | string | no |
| `homepage` | string | no |
| `dependencies` | array of object | no |
| `skills` | array of object | no |
| `connectorTemplates` | array of object | no |
| `agents` | array of object | no |
| `themes` | array of object | no |
| `setupGuides` | array of object | no |
| `extension` | object | no |
<!-- /generated -->

Rules that the schema cannot show:

- `name`: `^[a-z0-9][a-z0-9-]{0,63}$`. With an extension it must equal the extension's name.
- `version`: an exact semver version, equal to `package.json` `version`. While the platform is in
  release candidates, ranges on official packages are written `^0.1.0-rc.0`.
- `description` is a string or `{ en, zh? }`; `displayName` is `{ zh, en }`.
- `icon` is a `./` path to an `.svg` or `.png` inside the plugin.
- `skills`, `connectorTemplates`, `agents`, `themes` list paths starting with `./` that stay inside the plugin.
  Omit them to scan the default folders. Names and ids are unique within the plugin.
- `dependencies`: plugin name plus semver range; no self-dependency.
- `agents`: at most 64 templates (see `agent-templates`).
- `themes`: at most 10 `<id>.json` files; the id is the file's base name. A theme file is checked
  by `parseThemeFile` (schema `https://capybarahq.com/schemas/theme.v1.schema.json`).
- `setupGuides` (at most 8): `{ id, place, template? }`. Each guide is a Markdown document at
  `guides/<id>.md` (English, required) and `guides/<id>.zh.md` (Chinese, optional), shown where a
  person sets up what the plugin brings. `place` is `channel-connection` (新建渠道 and the channel
  detail; the extension must provide `channel@1`; one per plugin) or `connector-template`
  (`template` names one of the plugin's `connectors/<id>.json`; one per template). See "Setup
  guides" below.
- `extension` is written by the packer; never write it by hand.

## Setup guides

A guide is CommonMark + GFM:

- It starts with exactly one `# Title` (the guide's title, at most 100 characters); use `##` to
  `####` below it.
- `{{name}}` variables come from the place, and none is ever a secret: everywhere `publicUrl`,
  `orgName`, `pluginName`, `pluginVersion`, `mode`; `channel-connection` adds `webhookUrl`,
  `signInCallbackUrl`, `connectionName`; `connector-template` adds `oauthCallbackUrl`,
  `signInCallbackUrl`, `templateId`, `templateName`, `connectorName`. In `yaml` / `json` code put a
  variable inside double quotes. Directive lines and fence info strings hold no variables.
- Sections: a line `::: mode webhook` (modes `long_connection`, `webhook`; channel guides) or
  `::: audience member` (audiences `admin`, `member`; connector template guides) opens one, `:::`
  closes it, both in column 0. Only a mode section may sit inside an audience section. Text outside
  every section applies to all.
- Checks: a line `::check <id> <label>` is a live status row. `<id>` is one of the extension's own
  checks (registered with `ctx.setup.check` and listed in `permissions.setupChecks`; see
  `extensions`) or a platform check `capybara:<id>` (`public-url`, `webhook-public`,
  `webhook-received`, `connection-active`, `oauth-client`, `connector-tools`,
  `connector-connected`, `oauth-token-endpoint`). The label is plain text, at most 80 characters.
- Code fences: `<language> title="<text>"`; every block gets a copy button. Indented code blocks are
  refused. Raw HTML shows as text, images are never loaded, and only `https:` links stay links.
- The zh document has the same sections, the same check ids and byte-equal code blocks.
- Limits: 64 KiB per document, 24 code blocks, 16 checks, 16 sections.

`capybara-plugin pack` and `check` validate the documents; `capybara-plugin guide <id> [--locale zh]
[--mode m] [--audience a] [--var name=value]` prints a guide as an admin will see it.

## Importing

Plugins reach a deployment through a marketplace (npm, archive, git or path sources) or a direct
import. The super admin reviews one import screen (permissions, components, scope) and confirms
it; an org can upload its own plugin, which the super admin approves if it carries an extension.
