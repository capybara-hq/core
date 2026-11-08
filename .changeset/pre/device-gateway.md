---
"@capybara-hq/kernel": patch
"@capybara-hq/capybara": patch
---

The gateway role holds connected machines' WebSocket connections at `GET /device/connect`: the
machine credential and protocol are checked before the upgrade, one connection per environment
across replicas under a Redis lease (the newest connection wins), relayed requests are forwarded
and results written back; revocation, takeover, lease loss and shutdown close the socket.
