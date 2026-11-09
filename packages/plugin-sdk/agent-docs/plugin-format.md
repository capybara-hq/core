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
| `suggestedAppearance` | object | no |
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
- `setupGuides` (at most 8): setup material shown where a person configures what the plugin
  brings. Each guide has an `id`, a `place` (`channel-connection`: 新建渠道 and the channel detail;
  the plugin's extension must provide `channel@1`), a `title` and `steps` (`{ en, zh? }`, plain
  text, a backtick pair shows as inline code) and `files` (`./` paths ending in `.tmpl`, `.yaml`,
  `.yml`, `.json` or `.txt`, at most 64 KiB of text, with a `title` and a `language` of `yaml`,
  `json` or `text`). A step or file may carry `mode` (`long_connection` or `webhook`) to apply to
  that inbound mode only; ship one file per mode instead of conditionals. The kernel fills
  `{{publicUrl}}`, `{{webhookUrl}}`, `{{signInCallbackUrl}}`, `{{connectionName}}`, `{{orgName}}`,
  `{{pluginName}}`, `{{pluginVersion}}` and `{{mode}}` (never a secret); in YAML and JSON put a
  placeholder inside double quotes. `capybara-plugin pack` refuses any other placeholder.
- `extension` is written by the packer; never write it by hand.

## Importing

Plugins reach a deployment through a marketplace (npm, archive, git or path sources) or a direct
import. The super admin reviews one import screen (permissions, components, scope) and confirms
it; an org can upload its own plugin, which the super admin approves if it carries an extension.
