---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/kernel": patch
"@capybara-hq/testing": patch
"@capybara-hq/capybara": patch
---

Marketplace downloads refuse private addresses and redirects: every host must resolve to a public
address (or be listed in `marketplaces.allowPrivateHosts`), and the connection is pinned to the
checked address.

Plugins can be read from git commits (smart HTTP over the same network rules: depth 1, no tags or
submodules, size and file limits); `@capybara-hq/testing` adds `startFakeGitServer`.
The SDK exports `hostSdkProblem` (the host SDK range check of `validatePluginPackageJsonFor`).

Git marketplaces: a marketplace can be a git repository (`owner/repo`, an https `.git` URL or
`form: "git"`, optional `ref`); a refresh reads `.capybara-plugin/marketplace.json` or treats a
single-plugin repo as one entry, and skips an unchanged commit. `path` and `git` entries are
imported from git (source `git`, with host, repo, path, commit and "follows a branch" recorded),
`POST /api/v1/admin/catalog/import/git` imports one plugin straight from git, and
`marketplaces.allowedHosts` limits the hosts entries may download from (migration 0046).

Every catalog version records a content digest (sha256 over its files, the same for a tgz and a
git tree). Re-importing an imported version with other content records `<version>+git.<sha12>` /
`+sha256.<12>` (the same content is refused as already imported); versions are ordered by semver
without build metadata, ties by import time. Marketplace entries and catalog items show
`contentChanged` when an imported version's commit or integrity no longer matches the entry (a
refresh resolves the branch heads of imported branch-following git entries, migration 0047). An
archive without plugin.json is a skills-only plugin versioned `0.0.0-sha256.h<12>`.
