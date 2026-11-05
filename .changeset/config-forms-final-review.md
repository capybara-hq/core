---
"@capybara-hq/kernel": patch
"@capybara-hq/plugin-tools": patch
"@capybara-hq/web": patch
---

Config forms review fixes. Kernel: a config UI hint conversion that throws (a hand-made package)
no longer fails the org extension list, the org config refusal or the channel connection schema:
one never-throwing conversion serves the plain schema (hints stripped), else none, with one
warning per schema. Plugin-tools: the packer refuses a packed `plugin.json` whose text is over
`PLUGIN_MANIFEST_LIMITS.manifestChars`. Web: saving a replaced secret resets the deployment config
form even when the view comes back unchanged; the install wizard and the upgrade dialog title the
extension config card with its display name.
