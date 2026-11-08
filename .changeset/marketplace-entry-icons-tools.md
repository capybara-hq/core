---
"@capybara-hq/plugin-tools": minor
---

`capybara-plugin marketplace --write` fills each entry's `icon` with the repository path of the
plugin's `plugin.json` `icon` (`./plugins/<dir>/<icon>`) and refreshes it on listed entries like
`summary` / `displayName` (`marketplace-display-stale` in `--check`).
