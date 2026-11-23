---
"@capybara-hq/plugin-tools": patch
---

`capybara-plugin check` runs "Config classification": `plugin-config-unbound` (an error, replacing
the warning `plugin-org-override-unbound`) refuses an overridable deployment field on an extension
with no org-bound entry (mark it `platformOnly`), and `plugin-org-url-net` requires every
overridable URL field to reach the network through `configUrlFetch` and refuses URL-named string
fields not declared `z.url()`. The packer and "Config forms" read only the deployment config schema.
