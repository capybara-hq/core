---
"@capybara-hq/testing": patch
---

The testing package ships fake extensions, one or more per extension point, that core tests load
instead of the official plugins and the plugins repository can reuse: `fake-connector`
(`connector@1`, a small MCP client for `startFakeMcpServer`), `fake-object-store` (`object-store@1`
on the `startTestS3` container), `fake-tools-ui` (a tool, a conversation view, a migration, a skill
and a connector template), `fake-storage-user` (tools that use `ctx.storage`), `fake-embed` (embeds
with token-checked routes and SSE over the bus), `fake-bootstrap-a` / `fake-bootstrap-b` (a model
provider and a PostgreSQL-backed object store that need deployment config) and the dependency pair
`fake-dep-provider` / `fake-dep-requirer`. They live in `fixtures/extensions/<name>` in the pack
layout (now in the package `files`); `fakeExtensionDir`, `fakeExtensionEntry` and
`packFixture(name, outDir)` locate and pack them.
