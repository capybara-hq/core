---
"@capybara-hq/kernel": minor
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/testing": patch
---

The org UI routes gate every contribution by its slot: the slot's `minRole` (`org.settings.section`
admin and above, `org.page` member and above, conversation and agent slots any member), then its
scope (a readable conversation; an agent the caller can read in this org). `platform.page` is never
listed or served through an org route. `GET /orgs/:orgId/ui/contributions` takes `?slot=` and lists
`slot` and the resolved `after` anchor instead of `place`, ordered by extension name, then manifest
order. Views, actions and embed tokens take `agentId` for `agent.detail.section`; embed claims carry
it, and `ctx.ui.verifyEmbedToken` returns null when the current role no longer meets the slot's
`minRole`. `UiRenderArgs` gains `slot`, `scope` and `agentId`; `EmbedClaims` gains `agentId`.
