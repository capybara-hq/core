---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/plugin-anthropic": patch
"@capybara-hq/plugin-connector-mcp": patch
"@capybara-hq/plugin-connector-openapi": patch
"@capybara-hq/plugin-lark": patch
"@capybara-hq/plugin-model-fake": patch
"@capybara-hq/plugin-object-store-s3": patch
"@capybara-hq/plugin-openai": patch
"@capybara-hq/plugin-openai-compatible": patch
"@capybara-hq/plugin-sandbox-docker": patch
"@capybara-hq/plugin-sandbox-e2b": patch
"@capybara-hq/plugin-slack": patch
"@capybara-hq/plugin-todo": patch
---

npm release metadata: published packages carry `description`, `repository` (with `directory`, required by npm provenance) and `homepage`; plugin packages built by pack-plugin pass `description` / `repository` / `homepage` / `keywords` through and now ship `README.md`, `LICENSE`, plain files listed in `files` (slack's `app-manifest.yaml`) and `THIRD-PARTY-NOTICES.txt` for bundled dependencies. SDK, kernel and testing publish without the dev-only `@capybara-hq/source` export condition (`publishConfig.exports`) and depend on each other with `^` ranges. `@capybara-hq/design` and the `example-*` plugins are now private.
