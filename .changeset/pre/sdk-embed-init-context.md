---
"@capybara-hq/plugin-sdk": minor
---

The `init` message to an embed carries `context` as `EmbedInitContext`, narrowed on `scope`: an org
embed gets `{ scope: "org", orgId, conversationId? }`, a platform page of the admin console
`{ scope: "platform" }` (no `orgId`).
