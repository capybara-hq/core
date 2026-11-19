---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Linux open network and own loopback listeners (approval-only profiles).

- Device: a sandboxed Linux command with the open network reaches any public name or address
  literal on any port through its operation's proxy. The proxy dials only resolved addresses the
  SDK's address-class table calls public (its Python copy is kept equal by a test), that Python
  also calls global, and that are not this host's own, so private and LAN ranges, CGNAT, ULA,
  link-local and metadata addresses (Azure's `168.63.129.16` too), loopback, NAT64 and the
  reserved ranges stay closed, by name, literal or IPv4-mapped form; a refusal is a 403 before any
  connect, for the allowlist too. The Linux and local-Docker backends report `openPublic: true`.
  An escalated call starts from the owner's environment without `CAPYBARA_*` variables
  (`hostCommandEnv` replaces `hostBaseEnv`). At operation start the worker resolves the protected
  home locations and denies writes at each target a link points to (a dotfile manager's
  `~/.config` or `~/.bashrc`), for commands and native writes.
- SDK (`linux-sandbox.py`): the broker allows a connect to the operation's own loopback
  listeners. It keeps each listener the command creates on loopback, so that address stays this
  operation's while it allows connects to it; another process's loopback port stays refused, and a
  listener the command closed is released within about a second, or at once when its port is bound
  again. It refuses a `symlink` named for a proper prefix of a multi-component write deny (`.config`,
  `.claude`), lists a moved directory's entries from its own descriptor and undoes a move that a
  concurrent write turned into a deny, and takes `writeDenies` (absolute paths denied like the
  system spools).
- Fake-IP resolvers: when the system resolver answers a name with an address in `198.18.0.0/15`
  (a router running a fake-IP proxy such as OpenClash), the Linux forwarder re-resolves it (A and
  AAAA) through DNS-over-HTTPS at IP-literal endpoints with TLS verified against their IP SAN, and
  classifies and dials the real address like any resolved one; if encrypted DNS fails the request
  is refused with a 403 naming the fake-IP resolver, and the fake address is never dialled. The
  same holds for allowlisted names. SDK: `SANDBOX_FAKE_IP_DNS` holds the shared range, endpoints
  (Cloudflare `1.1.1.1`, `1.0.0.1`, then Google `8.8.8.8`), timeout and cache TTL cap.
