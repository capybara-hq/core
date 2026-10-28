---
"@capybara-hq/capybara": patch
---

The kernel images no longer carry the bootstrap plugin packages: compose `init` (or the first
`capybara start`) downloads them from npm (`CAPYBARA_PACKAGES__NPM_REGISTRY` for a mirror), and an
offline deployment mounts a directory holding the pinned tgz files at `/app/bootstrap`
(`CAPYBARA_BOOTSTRAP__DIR`). The `NPM_REGISTRY` and `NODE_USE_ENV_PROXY` build arguments are gone.
