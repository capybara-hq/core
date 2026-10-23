---
"@capybara-hq/plugin-slack": minor
"@capybara-hq/plugin-lark": minor
"@capybara-hq/testing": minor
---

Slack and Lark implement webhook inbound mode (`Channel.webhook.handle`).
Slack: optional secret `signingSecret`; `v0` HMAC signature checked in constant time with a 300 s
timestamp window; `url_verification` echoes the challenge; `event_callback` and the interactivity
form (`payload=`, block_actions) go through the Socket Mode parser, so `messageId` / `eventId` match.
Lark: optional secrets `encryptKey` and `verificationToken`; encrypted bodies are signature-checked
(SHA-256 of timestamp + nonce + key + body, 300 s window) and decrypted (AES-256-CBC); without
`encryptKey` only plaintext with a matching token is accepted; URL verification echoes the challenge;
events and `card.action.trigger` share the long-connection parser. Missing secrets reject with 401.
Bot ids are cached per connection in `ctx.kv` for one hour.
Testing: `slackEventCallback`, `signSlackWebhook`, `slackInteractiveForm`, `encryptLarkWebhook`,
`signLarkWebhook`.
