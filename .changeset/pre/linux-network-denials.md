---
"@capybara-hq/device": patch
---

A restricted command on Linux and in the local Docker mode reports the hosts its operation proxy
refused, with the same layers as on macOS. The forwarder answers each refusal with the macOS
proxy's reason as the 403 status phrase ("host is not on the allow list", "address is …",
"resolved to …"), which `sandboxProxyRefusalLayer` reads, and the exec result carries its refusals
as `network.blocked`: a name resolving to a private address gets the address note, a host off the
allowlist the network ask. Both modes now announce `networkReport`.
