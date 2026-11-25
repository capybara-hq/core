---
"@capybara-hq/capybara": patch
---

Plugin embeds delegate Chrome's local network access permission: after a network change (VPN,
hosts file, a proxy) leaves the app's page on a public connection while the embed's own requests
reach the same host at a private address, Chrome now asks once instead of blanking the embed.
