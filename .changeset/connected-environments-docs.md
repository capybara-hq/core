---
"@capybara-hq/capybara": patch
---

Documents connected environments: the gateway's `/device/connect` route must be reachable over
`wss://` on the public origin (WebSocket upgrade allowed, idle connections kept open), the
`environments.device.*` keys, and the `@device` provider.
