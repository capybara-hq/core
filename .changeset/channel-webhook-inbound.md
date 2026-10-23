---
"@capybara-hq/plugin-sdk": minor
"@capybara-hq/kernel": minor
"@capybara-hq/testing": minor
"@capybara-hq/web": minor
---

Optional webhook inbound for channel connections (E11-D); long connections stay the default.
SDK: `Channel.webhook.handle({ connectionId, config, request, signal })` returns `respond`, `events`
(acked only after every `onEvent` resolves, 503 otherwise) or `reject`; signatures are the plugin's job.
Kernel: migration 0038 adds `channel_connections.inbound_mode`; the gateway role serves
`POST /channels/webhook/:connectionId` outside the API guard (raw body, `channels.webhookMaxBodyBytes`,
uniform 404 `channel.webhook_not_found`); `PATCH .../channels/:id` takes `inboundMode` (409
`channel.webhook_unavailable` without plugin support or `channels.webhookBaseUrl`) and the view gains
`inboundMode`, `webhookSupported`, `webhookUrl`; the supervisor only holds long-connection connections.
Testing: `signFakeWebhook`, `fakeWebhookEvents`, `fakeWebhookChallenge`. Web: inbound mode switch with
the read-only callback URL on the channel page.
