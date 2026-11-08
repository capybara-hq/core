---
"@capybara-hq/kernel": minor
"@capybara-hq/capybara": patch
---

Plugin setup guides: an import validates and stores a plugin's `setupGuides` template files with
the version; `GET /api/v1/orgs/:orgId/catalog/:itemId/guides/:guideId?mode=&connectionId=&name=`
renders a guide for the org (the catalog icon's visibility, `channels.manage` for a channel guide)
with a fixed set of safe variables (`publicUrl`, `webhookUrl`, `signInCallbackUrl`,
`connectionName`, `orgName`, `pluginName`, `pluginVersion`, `mode`; never a secret). Channel
connections record the guide they were set up with (`guideAck`, migration 0097), carry
`setupGuide` and `guideDrift` when an upgrade changed the templates of their mode, and
`POST /api/v1/orgs/:orgId/channels/:connectionId/guide-ack { hash }` confirms the platform app was
updated. `GET channels/schema/:plugin` gains `guide`.
