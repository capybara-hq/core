---
"@capybara-hq/web": patch
---

The web server forwards connected machines' WebSocket upgrades on `/device/connect` to a gateway
replica (`CAPYBARA_WEB_GATEWAY_URL`); compose puts web and gateway on a `devices` network.
