---
"@capybara-hq/kernel": patch
---

Extension display names: an extension package stores its plugin.json `displayName`
(`extension_packages.display_name`, migration 0066; packages stored before it have none until
their next version), a config-declared extension reads it from its plugin directory's
`.capybara-plugin/plugin.json`, and one resolver (`ExtensionDisplayNames`: the package, else the
live catalog item of the same name, else null) adds `displayName` to the admin extension list and
detail, the org extension list, both models lists (`providers[].displayName`) and the deployment
config view. The config UI hint check can no longer throw out of an extension load, and stripping
invalid hints leaves `default` / `const` / `enum` / `examples` values untouched.
