---
"@capybara-hq/plugin-sdk": minor
---

Add the extra bootstrap manifest format (`BootstrapExtraManifestSchema`, `parseBootstrapExtraManifest`)
and the git marketplace username helpers (`suggestGitUsername`, `GIT_MARKETPLACE_USERNAME_DEFAULT`,
`GIT_USERNAME_RE`). A git entry's `path` may be `.` / `./`, the repository root of a single-plugin
repository.
