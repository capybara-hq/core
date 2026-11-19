---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

macOS restricted operations now enforce the open network: a grant's open public internet goes
through the operation's own proxy, which decides every connection on the resolved address and dials
the address it checked. Private and LAN, CGNAT, ULA, link-local, cloud metadata (Azure
`168.63.129.16` included), NAT64, loopback (another process's localhost port, `localhost` itself)
and this host's own addresses stay closed, for names and IP literals alike (the patched sandbox
runtime's `resolvedAddressStrict`). The device reports `openPublic: true` on macOS. Listening stays
refused on macOS. The write rules gain the system persistence paths (`SANDBOX_SYSTEM_WRITE_DENIES`,
now exported by the SDK) and, at operation start, the resolved target of every protected home
location reached through a symbolic link (a dotfile manager's `~/.config` or `~/.zshrc`). Only the
escalated pair runs unwrapped, and an escalated call's environment drops every `CAPYBARA_`
variable.
