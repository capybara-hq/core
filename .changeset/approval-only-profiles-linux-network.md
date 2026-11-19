---
"@capybara-hq/plugin-sdk": patch
"@capybara-hq/device": patch
---

Linux open network (approval-only profiles).

- Device: a sandboxed Linux command with the open network reaches any public name or address
  literal on any port through its operation's proxy. The proxy dials only resolved addresses the
  SDK's address-class table calls public (its Python copy is kept equal by a test), that Python
  also calls global, and that are not this host's own (nor, on a local-Docker device, the host's
  interface addresses, passed into the container). Private and LAN ranges, CGNAT, ULA,
  link-local and metadata addresses (Azure's `168.63.129.16` too), loopback, NAT64 and the
  reserved ranges stay closed, by name, literal or IPv4-mapped form; a refusal is a 403 before any
  connect, for the allowlist too. The proxy serves at most 128 connections at once. The Linux and
  local-Docker backends report `openPublic: true`. An escalated call starts from the owner's
  environment without `CAPYBARA_*` variables (`hostCommandEnv` replaces `hostBaseEnv`).
- Protected home locations: at operation start the worker resolves each protected location under
  the home component by component (`protected-targets.ts`, shared by the platform workers),
  following dangling links, and denies every link on the chain and the final target, anchored.
- Fake-IP resolvers: when the system resolver answers a name with an address in `198.18.0.0/15`
  (a router running a fake-IP proxy such as OpenClash), the forwarder re-resolves it through
  DNS-over-HTTPS and checks and dials the real address; if encrypted DNS fails the request is
  refused with a 403 naming the fake-IP resolver, and the fake address is never dialled. SDK:
  `SANDBOX_FAKE_IP_DNS` (RFC 8484 at `1.1.1.1`, `1.0.0.1`, `8.8.8.8`, `8.8.4.4`; one 5 s
  deadline per name; cache TTL cap 300 s, at most 256 names, complete answers only).
- SDK (`linux-sandbox.py`): no sandboxed connect reaches a loopback listener, the command's own
  included (clients outside the sandbox reach it). `SO_REUSEPORT` and `SO_ATTACH_REUSEPORT_*`
  are refused by seccomp, and the broker never binds or listens a socket with `SO_REUSEPORT` set.
  A `symlink` named for a proper prefix of a multi-component write deny is refused. A directory
  move into a guarded prefix first renames the directory to a reserved staging name beside it,
  which no sandboxed process may write, lists and checks it there and renames it into place with
  NOREPLACE; a refused or failed step moves it back, and when that fails too it goes to a
  quarantine name and the operation ends, reported. The move holds an exclusive lock against the
  operation's other writes, waiting at most 5 s (then EBUSY). New request field `writeDenies`
  (absolute paths denied like the system spools).
- SDK write policy: an ancestor of an anchored deny (a system spool, or a consumer's resolved
  target) never moves away, and `SANDBOX_RESERVED_NAME_PREFIX` (`.capybara-staging-`, the broker's
  staging and quarantine names) is denied to every sandboxed write, folded.
