---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

An extension shipped in a builtin platform plugin (a `builtin: true`, not required bootstrap entry
such as file-preview) is now enabled in every org, existing and future, like a required one: the
org enablement helpers count live builtin platform catalog items, so its tools, previewers and
other org-scoped capabilities work everywhere. Before, its plugin showed on with a locked switch
while the extension stayed off in every org with no way to turn it on.
