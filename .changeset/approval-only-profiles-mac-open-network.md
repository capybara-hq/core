---
"@capybara-hq/device": patch
"@capybara-hq/plugin-sdk": patch
---

macOS restricted operations now enforce the sandbox network on the resolved address: the
operation's own proxy decides every connection and dials the address it checked. Private and LAN,
CGNAT, ULA, link-local, cloud metadata (Azure `168.63.129.16` included), NAT64, loopback (another
process's localhost port, `localhost` itself) and this host's own addresses stay closed in the open
network and in the allowlist alike, for names and IP literals (an allow-listed literal gets no
carve-out; the patched sandbox runtime's `resolvedAddressStrict`). The device reports
`openPublic: true` on macOS; a runtime without the network patch is refused. Behind a fake-IP
resolver (a router answering every name with `198.18.0.0/15`), the proxy re-resolves the name
through DNS-over-HTTPS (RFC 8484) at the SDK's new `SANDBOX_FAKE_IP_DNS` endpoints, judges the real
answer, and refuses when that lookup fails. Listening stays refused on macOS. The write rules gain
the system persistence paths (`SANDBOX_SYSTEM_WRITE_DENIES`, now exported by the SDK) and, at
operation start, every symbolic link on the way to a protected home location plus its final target
(a dotfile manager's `~/.zshrc` chain), with no move of their ancestors. Only the escalated pair
runs unwrapped, and an escalated call's environment drops every `CAPYBARA_` variable.
