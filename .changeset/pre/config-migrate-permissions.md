---
"@capybara-hq/capybara": patch
---

`capybara config migrate-permissions --in <file> --out <file>` converts a config file (or a saved
Nacos data id) to the new permission keys (`devices.autoMode` -> `devices.fullAccess`) in place,
keeping every other key and comment, refuses conflicting or invalid values, never overwrites the
output and names the environment variables to rename.
