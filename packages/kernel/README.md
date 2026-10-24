# @capybara-hq/kernel

The kernel of [Capybara](https://github.com/capybara-hq/core), an open-source enterprise agent platform: config, database (with its
SQL migrations), extension hosting and the HTTP API. Every capability (models, channels, tools,
sandboxes, storage) is provided by an extension written against
[`@capybara-hq/plugin-sdk`](https://www.npmjs.com/package/@capybara-hq/plugin-sdk).

Most people run Capybara from the published images rather than this package: see
[docs/deploy](https://github.com/capybara-hq/core/tree/main/docs/deploy). The package is published for the
[`@capybara-hq/testing`](https://www.npmjs.com/package/@capybara-hq/testing) helpers and for
embedding the kernel.

- Configuration reference: [docs/config.md](https://github.com/capybara-hq/core/blob/main/docs/config.md).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).

Capybara is on 0.x: the kernel API may change in breaking ways between minor versions, and each
release's notes describe how to migrate.

## License

[Apache-2.0](https://github.com/capybara-hq/core/blob/main/LICENSE). See `NOTICE`.
