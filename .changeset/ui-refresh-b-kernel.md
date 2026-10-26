---
"@capybara-hq/kernel": minor
---

Tool presentation for the conversation page: `GET /conversations/:id/tools?keys=…` returns each tool's title, kind (command, read, edit, search, connector, meta, tool), key arguments and source. `title` and `keyArgs` are left out of the tool definition fingerprint, so they never trigger drift review; a connector refresh that changes only them updates the stored definition silently. Builtin tools declare their key arguments.
