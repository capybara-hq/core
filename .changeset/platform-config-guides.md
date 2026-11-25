---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

`extensions.platform-config` lists the extension's platform setup guides (`guides`: id and title,
in the optional `locale`) and, when a guide exists and the deployment config is invalid or leaves a
required field without a value, a `next` step naming `extensions.platform-guides`. An agent reading
the config now learns that the extension ships a setup guide instead of guessing the operation.
