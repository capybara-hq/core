# @capybara-hq/testing

Test helpers for [Capybara](https://github.com/capybara-hq/core) plugins and the kernel: PostgreSQL / Valkey / S3 test containers,
a dual-replica harness that runs two kernel replicas against the same database and Redis, and fake
third-party servers (model providers, MCP, OpenAPI, OAuth, Slack, Lark and others). Use it as a
devDependency in a plugin's tests; it needs Docker.

```bash
npm install --save-dev @capybara-hq/testing
```

- How plugin tests are written: "Test template (dual-replica)" in
  [.agents/skills/writing-plugins](https://github.com/capybara-hq/core/tree/main/.agents/skills/writing-plugins).
- The repository: [capybara-hq/core](https://github.com/capybara-hq/core).

Capybara is on 0.x: these helpers may change in breaking ways between minor versions.

## License

[Apache-2.0](https://github.com/capybara-hq/core/blob/main/LICENSE). See `NOTICE`.
