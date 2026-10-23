---
name: writing-apps
description: Use when writing a connector template package (capybara.kind = connector-template), a skill package (kind = skill) or an app bundle (kind = app, app.yaml: plugins + connector templates + skills) for the enterprise directory, or when changing the kernel's directory import and org install / uninstall (packages/kernel/src/directory): the capybara section of package.json, the app.yaml schema and lock (npm name + range + exact version + sha512), how to write editableEndpoint and defaultToolPolicies, the semantics of import (prepare / confirm, deployPlugins) and org install / uninstall, the JSON Schemas in packages/plugin-sdk/schemas/, and that M6 does not support app upgrades. For writing a plugin itself see writing-plugins; for writing a connector plugin see writing-connectors.
---

# Writing app bundles and connector templates

Packages in the enterprise directory (D9 / D16 / D17) are uniformly npm-pack tgz files whose `package.json` carries a `capybara` section, with four `kind`s (C21):

| kind | Content | Item name | Who installs |
|---|---|---|---|
| `plugin` | A plugin package (see "Plugin packages" in `.agents/skills/writing-plugins`) | the plugin manifest name | An enterprise admin installs it to the deployment; an org "install" = enable in this org |
| `connector-template` | A connector template: references a connector plugin and presets the endpoint and auth (no credentials) | the npm package name without the scope | An org admin (a connector is created once credentials are filled in) |
| `skill` | A skill: `SKILL.md` and other files at the package root | the `name` in `SKILL.md` | An org admin (imported as an org skill) |
| `app` | An app bundle: `app.yaml` combines plugins + connector templates + skills | the `name` in `app.yaml` | An enterprise admin imports it (all plugin permissions reviewed at once); an org admin installs it |

Connector templates and skills also accept zip (with `package.json` at the root). Non-plugin packages are never allowed install scripts or dependency fields such as `dependencies` / `peerDependencies` (nothing is executed or installed); `version` must be semver. The format and validation are pure functions in the SDK: `packages/plugin-sdk/src/plugin-package.ts` (`parsePackageSection`, `validateConnectorTemplate`), `app-manifest.ts` (`parseAppManifest`), `catalog.ts` (catalogs). The kernel reads packages in `packages/kernel/src/directory/archive.ts` (a package is always treated as malicious input, and nothing is written until all validation passes).

**JSON Schema**: `packages/plugin-sdk/schemas/app.v1.schema.json` (`app.yaml`) and `catalog-index.v1.schema.json` (the directory catalog `index.json`) are generated from the zod schemas by `pnpm gen:package-schemas`, and `pnpm check` (`check:package-schemas`) ensures they do not drift. After changing `AppManifestSchema` / `CatalogIndexSchema`, regenerate them. Rules JSON Schema cannot express (the lock version satisfying the range, uniqueness of names / ids / paths, the plugins a template references being listed, a template's static rules, path safety) are decided only by `parseAppManifest` / `parseCatalogIndex`, and external CI that validates catalogs must run them too.

## Connector templates (C30)

```json
{
  "name": "@acme/crm-mcp",
  "version": "1.0.0",
  "capybara": {
    "kind": "connector-template",
    "publisher": "Acme",
    "description": "Acme CRM over MCP",
    "displayName": { "zh": "Acme CRM", "en": "Acme CRM" },
    "template": {
      "plugin": "connector-mcp",
      "pluginVersion": "^0.1.0",
      "connector": "mcp",
      "endpoint": { "url": "https://mcp.acme.example/mcp" },
      "editableEndpoint": ["url"],
      "auth": { "type": "bearer", "ownership": "org" },
      "defaultToolPolicies": { "search": "allow", "delete_record": "deny" },
      "icon": "icon.svg"
    }
  }
}
```

- `plugin` / `connector`: the connector plugin name and its `Connector.kind`. **At import time that connector plugin must already be loaded on this replica**: the kernel validates the endpoint against its `endpointSchema` and confirms that every path in `editableEndpoint` is a field in the endpoint schema; if it is not loaded, the import is rejected (`directory.invalid_package`). At org install it is re-checked against the connector loaded at that time (not loaded -> `directory.not_deployed`).
- `pluginVersion` (optional, a semver range): the version requirement on the connector plugin. At import it is checked against the version loaded on this replica (not satisfied -> `directory.invalid_package`), and at org install (and in the list's "installable") against the version loaded at that time (not satisfied -> `directory.not_deployed`, with the version in the message). Templates inside an app bundle are additionally checked against the lock.
- `endpoint`: the endpoint preset, visible to every org, and **no credential-like keys may appear at any level** (`token`, `apiKey`, `secret`, `password`, `authorization`, `cookie` and so on, compared ignoring case and `-` / `_`); the kernel also checks headers / query / URL userinfo by the connector install rules.
- `editableEndpoint`: the dotted paths an org may change at install (letters, digits, `_`, `-`, <= 50 entries, no duplicates, must not look like credential fields). List only fields that really differ by org (such as the `url` of a self-hosted service, a tenant id); changing a path that is not listed -> 400 `validation_failed`. The whole merged endpoint is then re-checked against the schema, the credential check and the OAuth address policy.
- `auth`: the same shape as the auth methods of the connector install API (`ConnectorAuthSchema`: `none` / `bearer` / `basic` / `api_key` / `headers` / `oauth_code` / `oauth_client`), **containing no credentials** (extra fields are rejected). An org can only fill in credentials: static credentials via `credential`, OAuth via `client: { clientId, clientSecret? }`. `ownership` defaults to `auth.ownership`, and if given it must match; it cannot be given when `auth.type = none`.
- `defaultToolPolicies`: **local tool name** (without `<slug>__`) -> `allow` / `ask` / `deny`. After install, a tool with the same name in the tool snapshot uses it as its default policy, recorded as `policy_source 'template'` (kept after drift review, like an admin's setting); tools not listed are derived from annotations as usual. An authorization-code connector lists no tools at install; it is applied when the first member connects and the first tool snapshot is obtained. When unsure, do not write `allow`.
- `icon`: an `.svg` / `.png` in the package, <= 64 KB, whose content must really be svg / png. The icon is served only through a kernel route (nosniff + CSP sandbox), and the web app uses only `<img>`.

## App bundles (C31)

`package.json`: `{ "name": "@acme/app-crm-suite", "version": "1.0.0", "capybara": { "kind": "app", "manifest": "app.yaml" } }`.

```yaml
schemaVersion: 1
name: crm-suite                # directory item name, ^[a-z0-9][a-z0-9-]{0,63}$
version: 1.0.0                 # must equal the version in package.json
publisher: Acme
description: CRM tools for sales teams
displayName: { zh: CRM 套件, en: CRM Suite }
icon: icon.svg
plugins:                       # <= 20
  - name: crm                  # plugin manifest name
    npm: "@acme/plugin-crm"
    version: ^1.0.0            # a plugin already installed in the deployment and satisfying the range is left alone
    lock:
      version: 1.2.0           # must satisfy version
      integrity: sha512-…==    # sha512 of that version's tgz (npm's dist.integrity)
    optional: false            # optional plugin: skipped at org install if not installed in the deployment / version not satisfied (templates using it are skipped too)
connectorTemplates:            # <= 20, template has the same shape as the template in a connector template package
    # template.plugin references the connector plugin connector-mcp already in the deployment (not listed in plugins), see isKnownConnectorPlugin below
  - id: crm-mcp
    displayName: { zh: CRM, en: CRM }
    template: { plugin: connector-mcp, connector: mcp, endpoint: { url: "https://…" }, auth: { type: bearer, ownership: org } }
skills:                        # <= 50, directories in the package, each containing SKILL.md
  - path: skills/crm-notes
```

- **Plugin packages are not packed into the app bundle**: at import the kernel fetches `lock.version` from the configured `packages.npmRegistry` according to the lock and **trusts only `lock.integrity`** (`app.lock_mismatch`), not npm metadata; the fetched package is exactly the same as when installed separately (same sha256). So the release flow is: first publish the plugin to npm, take `dist.integrity` and write it into the lock, then pack the app bundle. An offline deployment must configure an npm mirror / private registry, otherwise app bundle import is unavailable.
- A template's `plugin` must be listed in `plugins` or be a connector plugin already in the deployment; when `pluginVersion` is given, the locked version must satisfy it (checked only for plugins listed in `plugins`). "Already in the deployment" is told to the parser by the caller through `parseAppManifest(yaml, { isKnownConnectorPlugin: (name) => … })`: when the kernel imports it passes "plugins loaded on this replica that provide `connector@1`"; **without this option a template can reference only plugins listed in `plugins`**, and referencing a builtin / installed `connector-mcp` like the example above reports `connectorTemplates.0.template.plugin: connector plugin connector-mcp is not listed in plugins …`. When external CI validates an app bundle, give this callback according to which connector plugins the target deployment has (e.g. `(n) => ["connector-mcp", "connector-openapi"].includes(n)`), or list the connector plugin in `plugins` as well.
- Unknown fields are always rejected (a misspelled field is an error, not ignored); duplicate YAML keys are an error, and `app.yaml` is <= 256K characters.
- The total bytes of one import (the app bundle + all plugin packages, all in memory during validation) <= `directory.maxBundleBytes` (default 4 x `packages.maxBytes`); over it -> 413 `app.bundle_too_large`.
- Agent templates in an app are deferred (C32); stdio MCP is not supported.

### Enterprise import: prepare -> confirm (`/api/v1/admin/directory/apps/*`)

- `POST apps/prepare/file` (raw bytes) or `apps/prepare/npm {package, version?}`, or importing an app-kind item from a catalog: unpack, validate all components, download all plugins according to the lock, and **write nothing until everything passes**; then the plugins go into the package store (source `directory`), files go into object storage, and a 24-hour staging record is written, and a review is returned: each plugin's action (`install` not in the deployment / `upgrade` installed but not satisfying the range, swapped per the lock / `keep` installed and satisfying the range, or a builtin / config-declared plugin), permissions and their additions and removals relative to the current snapshot, migration warnings, sensitive items, and the template and skill lists. A builtin / config-declared plugin not satisfying the range -> `app.plugin_conflict`; a downgrade to a version with unexecuted migrations -> `plugin.downgrade_unsupported`.
- `POST apps/:stagingId/confirm {reviewHash, deployPlugins}`: `reviewHash` must match the review, and is recomputed against the deployment state at that moment (a plugin installed / upgraded / swapped after the review -> `app.review_stale`); for plugins with action `install` it writes the permission snapshot (audit `plugin.permissions_approved` carrying `app`) and creates the directory item version.
  - `deployPlugins: true`: `upgrade` plugins also get a snapshot; after commit it first installs all plugins to the deployment and then enables them all (each replica reconciles, no restart), returns each result, and a failure does not roll back the committed item; an `upgrade` that did not get installed restores the original snapshot (audit `plugin.permissions_restored`) and the old version keeps running.
  - `deployPlugins: false`: only creates the item, does not touch the deployment, and also **does not write a snapshot for `upgrade` plugins** (a snapshot must correspond to the version actually running, F-O). To use the app afterwards, an enterprise admin goes to the plugin admin console and installs by the sha256 in the item version (`POST /api/v1/admin/plugins/:name/install {sha256}` -> `…/approve` if needed -> `…/enable`); while a required plugin is not installed in the deployment, org install returns `directory.not_deployed`.
- Expired staging is cleaned up by the maintenance job `app-staging-cleanup` (hourly); plugin packages already stored remain in the content-addressed package store and, with no install record referencing them, are never loaded.

### Org install and uninstall (`/api/v1/orgs/:orgId/directory/:itemId/install`, `app-installs`)

- Installing an app needs `org.plugins.manage`, `connectors.manage` and `skills.manage` together (re-checked inside the org row lock); item policy `disabled` -> `directory.item_disabled`; `needs_approval` with no grant for this org -> 202 and a request pending enterprise admin approval is created (or upgraded), otherwise 201.
- **Plugins in an app are judged by the app item's policy, ignoring each plugin item's needs_approval / allow** (C22). **Exception (Ruling M-5, overriding C22's app path)**: a plugin's own directory item (`kind = plugin`, same name) set to `disabled` is a master switch, and no route may newly enable this plugin in an org: not direct enabling, not via the plugin item, not via an app that contains it. Org install of an app that contains it returns 403 `directory.item_disabled` (the message names the plugin; orgs where it is already enabled are unaffected), and reviewing the import of an app bundle that contains it is likewise rejected (`directory.item_disabled`). To stop a plugin, disable its own item; there is no need to disable the apps that contain it one by one.
- Plugin judgment (the list's "installable" and install use the same logic, based on the ranges and `optional` written into the item version's `resolved.plugins` at confirmation): a required plugin not installed in the deployment, or whose loaded version does not satisfy the range in `app.yaml` -> `directory.not_deployed` (the message carries the deployed version and the required range); an optional plugin in these situations (or whose plugin item is disabled) is skipped, and a template whose `plugin` is a skipped optional plugin is skipped too. Skipped plugins and templates are listed in the install result `installed.skipped` (`{ plugins, connectorTemplates }`) and in the audit `app.installed`.
- Request body: `{ version?, app: { connectors: { <template id>: {…} }, pluginConfigs?: { <plugin name>: <org-level config> } } }`. `pluginConfigs` accepts only plugin names in `app.yaml` `plugins` (others -> 400 `validation_failed`) and is **used only for plugins newly enabled by this install**: a plugin already enabled in this org is recorded as pre-existing and its config is untouched; on new enablement it is validated against that plugin's `config.org` schema (same as `PUT /orgs/:orgId/plugins/:plugin`), and a plugin that needs org-level config to be enabled cannot be installed without it.
- In order: enable plugins in this org (sorted by requires, providers first; ones already enabled in this org are recorded as pre-existing) -> create connectors from templates (the request body `app.connectors[<template id>]` gives `name?` / `slug?` / `endpoint?` (limited to `editableEndpoint`) / `credential?` or `client?`) -> import skills (if an org skill of the same name exists, a new version is added, recorded as pre-existing and the version number noted). Each component is recorded in `app_install_components` as soon as it is built (new / pre-existing). **If any step fails, the components newly created by this install are undone in reverse order**, the install is recorded as `failed`, and 502 `app.install_failed` is returned.
- Uninstall (`DELETE app-installs/:installId`, also needing the three permissions) **removes only components newly created by this install and not in use elsewhere**, and writes the kept ones and the reasons into the report: `pre_existing` (already there), `used_by_agents` (the skill is selected by an agent / the connector is referenced by an agent), `used_by_other_install` (another app install in this org also uses it; ownership goes to the earliest install), `used_by_connectors` (a connector provided by the plugin is still in use), `used_by_plugins` (another enabled plugin depends on it). Uninstalling a `failed` install, or one still `installing` after `directory.staleInstallMinutes` (default 30) (a replica crashed midway), cleans up as a rollback (versions added on an existing skill are also rolled back); one still installing -> `app.install_in_progress`.
- **M6 does not support app upgrades**: a new version must be uninstalled and then installed again.

## Checklist for writing packages

1. Connector template: first install and enable the corresponding connector plugin in a development deployment, then import the template; check the endpoint preset and `editableEndpoint` against that plugin's `endpointSchema`.
2. App: publish the plugins to npm first, and write `dist.integrity` in the lock; the `version` in `app.yaml` matches `package.json`; each skill directory has a `SKILL.md`.
3. Local validation: the SDK's `parsePackageSection(pkg, SDK_VERSION)` and `parseAppManifest(yaml, { isKnownConnectorPlugin })` return no `errors` (when a template references a connector plugin not listed in `plugins`, `isKnownConnectorPlugin` must be given, see above).
4. Test references: `packages/kernel/test/directory/` (`archive`, `directory`, `app-import`, `app-install`, `org`, `requests`, `catalogs`) and the dual-replica acceptance test `m6-segment3.dual.test.ts`; run `pnpm exec vitest run <path>` from the repo root.
