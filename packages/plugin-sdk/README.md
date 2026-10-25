# @capybara-hq/plugin-sdk

The SDK for writing plugins for [Capybara](https://github.com/capybara-hq/core), an open-source enterprise agent platform. It holds
the types, extension point contracts (`model-provider@2`, `channel@1`, `connector@1`, `sandbox@1`,
`object-store@1` and others) and pure functions that a plugin's extension is written against, and the
package formats: the plugin manifest `.capybara-plugin/plugin.json` (`parsePluginManifest`),
connector template files `connectors/<id>.json` (`parseConnectorTemplateFile`) and the marketplace
manifest `marketplace.json` (`parseMarketplaceManifest`), with their JSON Schemas in `schemas/`
(`plugin.v1`, `connector-template.v1`, `marketplace.v1`; reference them from a file's `$schema` as
`https://capybarahq.com/schemas/<file>`). An extension depends only on this package and third-party
npm packages; the host provides it at runtime.

```bash
npm install @capybara-hq/plugin-sdk
```

- Writing an extension: [.agents/skills/writing-extensions](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-extensions)
  and the reference plugin [plugins/example-counter](https://github.com/capybara-hq/core/tree/main/plugins/example-counter).
- Writing a plugin (manifest, skills, connector templates, dependencies, marketplaces):
  [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).

Capybara is on 0.x: the SDK may change in breaking ways between minor versions, and each release's
notes describe how to migrate.

## License

[Apache-2.0](https://github.com/capybara-hq/core/blob/main/LICENSE). See `NOTICE`.
