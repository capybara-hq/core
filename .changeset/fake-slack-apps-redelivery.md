---
"@capybara-hq/testing": minor
---

Fake Slack: serve several Slack apps on one fake (`apps`, routed by app token; `auth.test` answers per
bot token), queue envelopes pushed while the target app has no open socket instead of throwing, and
optionally retry unacked envelopes on the app's next socket (`redeliverUnacked`, Slack Socket Mode
semantics). `push` / `pushEvent` / `pushInteractive` take an `appToken` target; `openSockets`,
`socketPeerPorts`, `maxConcurrentSockets` and `connectionsOpened` filter by app; new
`pendingEnvelopes`.
