---
"@capybara-hq/kernel": minor
---

Tool presentation for the conversation page: `GET /conversations/:id/tools?keys=…` returns each tool's title, kind (command, read, edit, search, connector, meta, tool), key arguments and source. `title` and `keyArgs` are left out of the tool definition fingerprint, so they never trigger drift review; a connector refresh that changes only them updates the stored definition silently and logs `connector.tool_display_updated`. Remote titles are cleaned of control, bidi and invisible characters before they are kept. Builtin tools declare their key arguments.

An extension written without the SDK types that already passed a top-level `title` on a tool gets a new fingerprint for that tool: its remembered grants no longer match and older eval cases report the tool definition as changed.
