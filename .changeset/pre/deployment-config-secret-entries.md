---
"@capybara-hq/kernel": patch
---

Deployment config secret records drawn per item: for a secret record some `x-ui.secrets[].path`
names, the admin config view adds `keys` (the record's keys that are set, never values), and
`PUT /api/v1/admin/extensions/:name/config` accepts `secretEntries` (`{ path, key, value?,
renameFrom? }`: set, remove or rename one key) applied under the config lock and validated with
`values`. A path no hint names is 400 `validation_failed`, one in the startup config 409
`extension.config_readonly`. The config view no longer fails when a schema's hint conversion
throws (the hints are dropped with one warning), and a config-declared extension takes its display
name only from a plugin.json of its own name.
