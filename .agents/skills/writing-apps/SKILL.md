---
name: writing-apps
description: 'Use when writing a connector template package (capybara.kind = connector-template), a skill package (kind = skill) or a plugin, the bundle of extensions + connector templates + skills (kind = app, app.yaml until plan 0b), for the catalog, or when changing the kernel''s catalog import and org plugin install / uninstall (packages/kernel/src/catalog): the capybara section of package.json, the app.yaml schema and lock (npm name + range + exact version + sha512), how to write editableEndpoint and defaultToolPolicies, the semantics of import (prepare / confirm, deployPlugins) and org install / uninstall, the JSON Schemas in packages/plugin-sdk/schemas/, and that M6 does not support plugin upgrades. For writing an extension itself see writing-extensions; for writing a connector extension see writing-connectors.'
---

# Writing plugins (bundles) and connector templates

Terms (2026-10-24 rename): a **plugin** is the install unit that bundles extensions, connector templates and skills (called an "app bundle" before; its format is still `app.yaml` and `kind: app` until plan 0b replaces it with `.capybara-plugin/plugin.json`); an **extension** is the in-process code (`.agents/skills/writing-extensions`); the **catalog** is what a deployment has imported (formerly the enterprise directory); a **marketplace** is a manifest listing importable packages (formerly a catalog source). The `kind` values and package fields below are the current format and keep their old names until plan 0b.

Packages in the catalog (D9 / D16 / D17) are uniformly npm-pack tgz files whose `package.json` carries a `capybara` section, with four `kind`s (C21):

| kind | Content | Item name | Who installs |
|---|---|---|---|
| `plugin` | An extension package (see "Extension packages" in `.agents/skills/writing-extensions`) | the extension manifest name | An enterprise admin installs it to the deployment; an org "install" = enable in this org |
| `connector-template` | A connector template: references a connector extension and presets the endpoint and auth (no credentials) | the npm package name without the scope | An org admin (a connector is created once credentials are filled in) |
| `skill` | A skill: `SKILL.md` and other files at the package root | the `name` in `SKILL.md` | An org admin (imported as an org skill) |
| `app` | A plugin: `app.yaml` combines extensions + connector templates + skills | the `name` in `app.yaml` | An enterprise admin imports it (all extension permissions reviewed at once); an org admin installs it |

Connector templates and skills also accept zip (with `package.json` at the root). Packages other than extension packages are never allowed install scripts or dependency fields such as `dependencies` / `peerDependencies` (nothing is executed or installed); `version` must be semver. The format and validation are pure functions in the SDK: `packages/plugin-sdk/src/plugin-package.ts` (`parsePackageSection`, `validateConnectorTemplate`), `app-manifest.ts` (`parseAppManifest`), `catalog.ts` (marketplace `index.json`). The kernel reads packages in `packages/kernel/src/catalog/archive.ts` (a package is always treated as malicious input, and nothing is written until all validation passes).

**JSON Schema**: `packages/plugin-sdk/schemas/app.v1.schema.json` (`app.yaml`) and `catalog-index.v1.schema.json` (the marketplace `index.json`) are generated from the zod schemas by `pnpm gen:package-schemas`, and `pnpm check` (`check:package-schemas`) ensures they do not drift. After changing `AppManifestSchema` / `CatalogIndexSchema`, regenerate them. Rules JSON Schema cannot express (the lock version satisfying the range, uniqueness of names / ids / paths, the extensions a template references being listed, a template's static rules, path safety) are decided only by `parseAppManifest` / `parseCatalogIndex`, and external CI that validates marketplaces must run them too.

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

- `plugin` / `connector`: the connector extension name and its `Connector.kind`. **At import time that connector extension must already be loaded on this replica**: the kernel validates the endpoint against its `endpointSchema` and confirms that every path in `editableEndpoint` is a field in the endpoint schema; if it is not loaded, the import is rejected (`catalog.invalid_package`). At org install it is re-checked against the connector loaded at that time (not loaded -> `catalog.not_deployed`).
- `pluginVersion` (optional, a semver range): the version requirement on the connector extension. At import it is checked against the version loaded on this replica (not satisfied -> `catalog.invalid_package`), and at org install (and in the list's "installable") against the version loaded at that time (not satisfied -> `catalog.not_deployed`, with the version in the message). Templates inside a plugin are additionally checked against the lock.
- `endpoint`: the endpoint preset, visible to every org, and **no credential-like keys may appear at any level** (`token`, `apiKey`, `secret`, `password`, `authorization`, `cookie` and so on, compared ignoring case and `-` / `_`); the kernel also checks headers / query / URL userinfo by the connector install rules.
- `editableEndpoint`: the dotted paths an org may change at install (letters, digits, `_`, `-`, <= 50 entries, no duplicates, must not look like credential fields). List only fields that really differ by org (such as the `url` of a self-hosted service, a tenant id); changing a path that is not listed -> 400 `validation_failed`. The whole merged endpoint is then re-checked against the schema, the credential check and the OAuth address policy.
- `auth`: the same shape as the auth methods of the connector install API (`ConnectorAuthSchema`: `none` / `bearer` / `basic` / `api_key` / `headers` / `oauth_code` / `oauth_client`), **containing no credentials** (extra fields are rejected). An org can only fill in credentials: static credentials via `credential`, OAuth via `client: { clientId, clientSecret? }`. `ownership` defaults to `auth.ownership`, and if given it must match; it cannot be given when `auth.type = none`.
- `defaultToolPolicies`: **local tool name** (without `<slug>__`) -> `allow` / `ask` / `deny`. After install, a tool with the same name in the tool snapshot uses it as its default policy, recorded as `policy_source 'template'` (kept after drift review, like an admin's setting); tools not listed are derived from annotations as usual. An authorization-code connector lists no tools at install; it is applied when the first member connects and the first tool snapshot is obtained. When unsure, do not write `allow`.
- `icon`: an `.svg` / `.png` in the package, <= 64 KB, whose content must really be svg / png. The icon is served only through a kernel route (nosniff + CSP sandbox), and the web app uses only `<img>`.

## Plugins (C31)

`package.json`: `{ "name": "@acme/app-crm-suite", "version": "1.0.0", "capybara": { "kind": "app", "manifest": "app.yaml" } }`.

```yaml
schemaVersion: 1
name: crm-suite                # catalog item name, ^[a-z0-9][a-z0-9-]{0,63}$
version: 1.0.0                 # must equal the version in package.json
publisher: Acme
description: CRM tools for sales teams
displayName: { zh: CRM 套件, en: CRM Suite }
icon: icon.svg
plugins:                       # <= 20, the extensions (field name kept until plan 0b)
  - name: crm                  # extension manifest name
    npm: "@acme/plugin-crm"
    version: ^1.0.0            # an extension already installed in the deployment and satisfying the range is left alone
    lock:
      version: 1.2.0           # must satisfy version
      integrity: sha512-…==    # sha512 of that version's tgz (npm's dist.integrity)
    optional: false            # optional extension: skipped at org install if not installed in the deployment / version not satisfied (templates using it are skipped too)
connectorTemplates:            # <= 20, template has the same shape as the template in a connector template package
    # template.plugin references the connector extension connector-mcp already in the deployment (not listed in plugins), see isKnownConnectorPlugin below
  - id: crm-mcp
    displayName: { zh: CRM, en: CRM }
    template: { plugin: connector-mcp, connector: mcp, endpoint: { url: "https://…" }, auth: { type: bearer, ownership: org } }
skills:                        # <= 50, directories in the package, each containing SKILL.md
  - path: skills/crm-notes
```

- **Extension packages are not packed into the plugin**: at import the kernel fetches `lock.version` from the configured `packages.npmRegistry` according to the lock and **trusts only `lock.integrity`** (`plugin.lock_mismatch`), not npm metadata; the fetched package is exactly the same as when installed separately (same sha256). So the release flow is: first publish the extension package to npm, take `dist.integrity` and write it into the lock, then pack the plugin. An offline deployment must configure an npm mirror / private registry, otherwise plugin import is unavailable.
- A template's `plugin` must be listed in `plugins` or be a connector extension already in the deployment; when `pluginVersion` is given, the locked version must satisfy it (checked only for extensions listed in `plugins`). "Already in the deployment" is told to the parser by the caller through `parseAppManifest(yaml, { isKnownConnectorPlugin: (name) => … })`: when the kernel imports it passes "extensions loaded on this replica that provide `connector@1`"; **without this option a template can reference only extensions listed in `plugins`**, and referencing a builtin / installed `connector-mcp` like the example above reports `connectorTemplates.0.template.plugin: connector plugin connector-mcp is not listed in plugins …`. When external CI validates a plugin, give this callback according to which connector extensions the target deployment has (e.g. `(n) => ["connector-mcp", "connector-openapi"].includes(n)`), or list the connector extension in `plugins` as well.
- Unknown fields are always rejected (a misspelled field is an error, not ignored); duplicate YAML keys are an error, and `app.yaml` is <= 256K characters.
- The total bytes of one import (the plugin + all extension packages, all in memory during validation) <= `catalog.maxBundleBytes` (default 4 x `packages.maxBytes`); over it -> 413 `plugin.bundle_too_large`.
- Agent templates in a plugin are deferred (C32); stdio MCP is not supported.

### Enterprise import: prepare -> confirm (`/api/v1/admin/catalog/plugins/*`)

- `POST plugins/prepare/file` (raw bytes) or `plugins/prepare/npm {package, version?}`, or importing an app-kind entry from a marketplace: unpack, validate all components, download all extension packages according to the lock, and **write nothing until everything passes**; then the extension packages go into the package store (source `catalog`), files go into object storage, and a 24-hour staging record is written, and a review is returned: each extension's action (`install` not in the deployment / `upgrade` installed but not satisfying the range, swapped per the lock / `keep` installed and satisfying the range, or a builtin / config-declared extension), permissions and their additions and removals relative to the current snapshot, migration warnings, sensitive items, and the template and skill lists. A builtin / config-declared extension not satisfying the range -> `plugin.extension_conflict`; a downgrade to a version with unexecuted migrations -> `extension.downgrade_unsupported`.
- `POST plugins/:stagingId/confirm {reviewHash, deployPlugins}`: `reviewHash` must match the review, and is recomputed against the deployment state at that moment (an extension installed / upgraded / swapped after the review -> `plugin.review_stale`); for extensions with action `install` it writes the permission snapshot (audit `extension.permissions_approved` carrying `app`) and creates the catalog item version.
  - `deployPlugins: true`: `upgrade` extensions also get a snapshot; after commit it first installs all of the plugin's extensions to the deployment and then enables them all (each replica reconciles, no restart), returns each result, and a failure does not roll back the committed item; an `upgrade` that did not get installed restores the original snapshot (audit `extension.permissions_restored`) and the old version keeps running.
  - `deployPlugins: false`: only creates the item, does not touch the deployment, and also **does not write a snapshot for `upgrade` extensions** (a snapshot must correspond to the version actually running, F-O). To use the plugin afterwards, an enterprise admin goes to the extensions page of the admin console and installs by the sha256 in the item version (`POST /api/v1/admin/extensions/:name/install {sha256}` -> `…/approve` if needed -> `…/enable`); while a required extension is not installed in the deployment, org install returns `catalog.not_deployed`.
- Expired staging is cleaned up by the maintenance job `app-staging-cleanup` (hourly; the job name is kept); extension packages already stored remain in the content-addressed package store and, with no install record referencing them, are never loaded.

### Org install and uninstall (`/api/v1/orgs/:orgId/catalog/:itemId/install`, `plugin-installs`)

- Installing a plugin needs `org.extensions.manage`, `connectors.manage` and `skills.manage` together (re-checked inside the org row lock); item policy `disabled` -> `catalog.item_disabled`; `needs_approval` with no grant for this org -> 202 and a request pending enterprise admin approval is created (or upgraded), otherwise 201.
- **Extensions in a plugin are judged by the plugin item's policy, ignoring each extension item's needs_approval / allow** (C22). **Exception (Ruling M-5, overriding C22's bundle path)**: an extension's own catalog item (`kind = plugin`, same name) set to `disabled` is a master switch, and no route may newly enable this extension in an org: not direct enabling, not via the extension item, not via a plugin that contains it. Org install of a plugin that contains it returns 403 `catalog.item_disabled` (the message names the extension; orgs where it is already enabled are unaffected), and reviewing the import of a plugin that contains it is likewise rejected (`catalog.item_disabled`). To stop an extension, disable its own item; there is no need to disable the plugins that contain it one by one.
- Extension judgment (the list's "installable" and install use the same logic, based on the ranges and `optional` written into the item version's `resolved.plugins` at confirmation): a required extension not installed in the deployment, or whose loaded version does not satisfy the range in `app.yaml` -> `catalog.not_deployed` (the message carries the deployed version and the required range); an optional extension in these situations (or whose extension item is disabled) is skipped, and a template whose `plugin` is a skipped optional extension is skipped too. Skipped extensions and templates are listed in the install result `installed.skipped` (`{ plugins, connectorTemplates }`) and in the audit `plugin.org_installed`.
- Request body: `{ version?, plugin: { connectors: { <template id>: {…} }, extensionConfigs?: { <extension name>: <org-level config> } } }`. `extensionConfigs` accepts only extension names in `app.yaml` `plugins` (others -> 400 `validation_failed`) and is **used only for extensions newly enabled by this install**: an extension already enabled in this org is recorded as pre-existing and its config is untouched; on new enablement it is validated against that extension's `config.org` schema (same as `PUT /orgs/:orgId/extensions/:extension`), and an extension that needs org-level config to be enabled cannot be installed without it.
- In order: enable extensions in this org (sorted by requires, providers first; ones already enabled in this org are recorded as pre-existing) -> create connectors from templates (the request body `plugin.connectors[<template id>]` gives `name?` / `slug?` / `endpoint?` (limited to `editableEndpoint`) / `credential?` or `client?`) -> import skills (if an org skill of the same name exists, a new version is added, recorded as pre-existing and the version number noted). Each component is recorded in `plugin_install_components` as soon as it is built (new / pre-existing). **If any step fails, the components newly created by this install are undone in reverse order**, the install is recorded as `failed`, and 502 `plugin.install_failed` is returned.
- Uninstall (`DELETE plugin-installs/:installId`, also needing the three permissions) **removes only components newly created by this install and not in use elsewhere**, and writes the kept ones and the reasons into the report: `pre_existing` (already there), `used_by_agents` (the skill is selected by an agent / the connector is referenced by an agent), `used_by_other_install` (another plugin install in this org also uses it; ownership goes to the earliest install), `used_by_connectors` (a connector provided by the extension is still in use), `used_by_plugins` (another enabled extension depends on it). Uninstalling a `failed` install, or one still `installing` after `catalog.staleInstallMinutes` (default 30) (a replica crashed midway), cleans up as a rollback (versions added on an existing skill are also rolled back); one still installing -> `plugin.install_in_progress`.
- **M6 does not support plugin upgrades**: a new version must be uninstalled and then installed again.

## Checklist for writing packages

1. Connector template: first install and enable the corresponding connector extension in a development deployment, then import the template; check the endpoint preset and `editableEndpoint` against that extension's `endpointSchema`.
2. Plugin: publish its extension packages to npm first, and write `dist.integrity` in the lock; the `version` in `app.yaml` matches `package.json`; each skill directory has a `SKILL.md`.
3. Local validation: the SDK's `parsePackageSection(pkg, SDK_VERSION)` and `parseAppManifest(yaml, { isKnownConnectorPlugin })` return no `errors` (when a template references a connector extension not listed in `plugins`, `isKnownConnectorPlugin` must be given, see above).
4. Test references: `packages/kernel/test/catalog/` (`archive`, `catalog`, `plugin-import`, `plugin-install`, `org`, `requests`, `marketplaces`) and the dual-replica acceptance test `m6-segment3.dual.test.ts`; run `pnpm exec vitest run <path>` from the repo root.
