# @capybara-hq/plugin-sdk

The plugin SDK of [Capybara](https://github.com/capybara-hq/core), an open-source enterprise agent platform. It holds the types,
contracts (`model-provider@2`, `channel@1`, `connector@1`, `sandbox@1`, `object-store@1` and
others) and pure functions that plugins are written against, plus the JSON Schemas of catalogs and app
manifests (`schemas/`). A plugin depends only on this package and third-party npm packages; the host
provides it at runtime.

```bash
npm install @capybara-hq/plugin-sdk
```

- Writing a plugin: [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins)
  and the reference plugin [plugins/example-counter](https://github.com/capybara-hq/core/tree/main/plugins/example-counter).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).

Capybara is on 0.x: the SDK may change in breaking ways between minor versions, and each release's
notes describe how to migrate.

## License

[Apache-2.0](https://github.com/capybara-hq/core/blob/main/LICENSE). See `NOTICE`.
