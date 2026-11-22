---
"@capybara-hq/device": patch
---

The login service is now per connection: one launchd agent `top.capybara.device.<deviceId>` or one
systemd instance `capybara-device@<deviceId>.service` (of a shared template) runs
`start --connection <deviceId>`, so two connections of one machine start, stop and uninstall
independently. The old single `top.capybara.device` agent and `capybara-device.service` unit are
never touched: their plain `start` (no `--connection`) says how to upgrade and exits 0, so the
service manager leaves them stopped. `service uninstall|status -c <deviceId>` also work for an
installed service whose connection has lost its credential.
