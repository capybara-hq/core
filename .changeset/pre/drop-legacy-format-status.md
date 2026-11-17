---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

Drop the `legacy_format` extension status and the `catalog.legacy_format` / `extension.legacy_format`
error codes: a package without `.capybara-plugin/plugin.json` is refused as an ordinary invalid
package whose message names the expected manifest path.
