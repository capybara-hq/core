# Browser access to a local port on the person's own device

Status: design, 2026-11-28. Amends the sandbox network rules ("private ranges, metadata and host
services stay closed") for one case: a device service granted one loopback port for one
conversation. Touches the browser use design
([2026-11-23-browser-use-design.md](2026-11-23-browser-use-design.md)), the device service protocol
and the per-call escalation of the permission profiles.

## 1. Why

"Build a Next.js todo app, start the dev server and test it in the browser" fails on a personal Mac
device today:

- The agent starts the dev server with an outside-sandbox Bash call. It listens on `127.0.0.1:3999`.
- The browser service runs inside the device sandbox. Its proxy refuses every loopback, private
  and metadata address, so `browser_navigate http://127.0.0.1:3999` gets
  "Connection blocked by network allowlist".
- The panel offers nothing, because the "allow this site" button exists only for names on the
  device allowlist. Loopback is a closed class (daemon layer `address`).
- The model is told the address is closed. In the observed run it then installed Playwright and
  downloaded its own Chromium into the project (four minutes), outside the browser tool and its
  panel.

Testing what the agent just built on the person's own machine is a core use of the browser. The
maintainer chose per-port approval (2026-11-28): the browser reaches a loopback port only after an
approval of that port, decided like an outside-sandbox escalation and bounded by the same setting.

## 2. Goals, non-goals, anti-goals

Goals:

1. A device service whose extension declares it may ask for one loopback port
   (`127.0.0.1`, `::1` or `localhost`, plus an exact port). Once the ask is approved, the service
   reaches that port, and only that port, for that conversation.
2. The ask is decided by whoever decides outside-sandbox escalations under the conversation's
   permission profile: the person, the review model, or nobody under Full access. It is refused
   wherever an outside-sandbox escalation would be refused (platform, org, device or provider
   setting off; unattended run).
3. The browser call that hit the closed port runs again after the grant, as a network ask's call
   does today, and the panel offers the owner the same grant directly.
4. Everything is recorded: the approval, the grant and its use show up in the conversation events
   and the audit log.

Non-goals:

- LAN, private, CGNAT, link-local and metadata addresses stay closed. A grant names a loopback
  address only.
- Port ranges, wildcard ports, and grants for the whole device or every conversation.
- Linux and Docker or E2B devices. capybara-device has no Linux service launcher, and inside a
  container or VM "loopback" is the box's own, not the person's machine. The provider reports
  whether it supports grants (§5.4); it is offered only where it is supported.
- Commands. Bash keeps its outside-sandbox escalation. The sandbox for commands is unchanged, and a
  sandboxed command still cannot listen on a port (`allowLocalBinding: false`).

Anti-goals: a grant that outlives its conversation, a grant applied without a record, and any path
where a page, a panel message or an extension can widen the sandbox without the approver.

## 3. Approaches considered

1. **Per-port approval (chosen).** It is a new crossing kind, `loopback-port`, decided by the
   profile's approver and bounded by the outside-sandbox setting. The device proxy allows exactly
   the granted loopback address and port. The blast radius is one port. It reuses the review
   pipeline, the approval UI and the restart path that already applies network changes to a
   service.
2. **Automatically open ports that this conversation's own outside-sandbox processes listen on.**
   There is no prompt, but the device would have to track which escalated process owns which
   listener across restarts and forks. A listener a process opens is not something the approver
   saw. Rejected by the maintainer as the second choice.
3. **Keep loopback closed and only improve the note.** This costs nothing but leaves the use case
   broken.

## 4. The grant

A loopback grant is the tuple `(org, device, service id, conversation root, port)`.

- **Address.** The grant covers `127.0.0.1`, `::1` and `localhost` on that port. All three name the
  same listener for a dev server, and the agent cannot know which one the server binds.
  `localhost` is resolved by the proxy to loopback only, never through DNS.
- **Port.** 1–65535, one per grant. The approver sees the number. Ports used by capybara-device
  itself are never granted, because the device control channel is a unix socket and opens no TCP
  port. Well-known database ports (5432, 3306, 6379, 27017) are allowed but named in the approval
  text ("a local database port"), because the person may not expect a browser there.
- **Scope.** One conversation. Its sub-agent conversations share their root's grants, as they share
  its tabs.
- **Lifetime.** A grant ends when the conversation is deleted, or 24 hours after it was issued,
  whichever comes first (my call: a dev session; the agent asks again later). Revoking is explicit:
  the conversation's side panel lists the active grants with a remove action. A grant also ends
  when the outside-sandbox setting that bounded it is switched off.
- **Where it applies.** The browser daemon serves every conversation on the device from one
  process, so the device proxy enforces the union of the device's live grants for that service.
  The daemon keeps a per-tab check on top: a tab reaches a granted loopback port only when the
  tab's conversation holds the grant. Another conversation's tab gets the same blocked result it
  gets today. The sandbox is the hard boundary at the device level. The per-conversation split
  inside the daemon is extension code, full trust like every extension, and is stated as such.

## 5. Flow

### 5.1 Detection (browser plugin)

- The daemon's blocked report gains the port and the address class:
  `BlockedHost { host, port, layer, class? }`. Today the port is dropped and the kernel assumes 443.
- `reportBlockedHosts` and `ServiceBlockedHost` carry `port` and `class` (SDK change).
- A loopback refusal (`layer: "address"`, `class: "loopback"`) of a service whose extension
  declares `permissions.deviceAccess.loopbackPorts: true` becomes a candidate for a loopback ask.
  Every other address refusal keeps today's note.

### 5.2 The ask (kernel)

- The pipeline plans a `loopback-port` candidate next to the existing network asks
  (`planNetworkAsk`), one per call, under the existing per-run cap.
- The approver is `approverForCrossing` with crossing `loopback-port`, with the same rules as
  `outside-sandbox`: request-approval asks the person, approve-for-me asks the review model,
  full-access grants within the ceiling, and a sub-agent's ask always goes to the review model.
- The ceiling is the outside-sandbox ceiling of the device (`DeviceSandbox.outsideSandbox`), the
  provider's support (§5.4) and the owner's device setting. The ask is never offered where it
  would be refused. The note then says why ("local ports stay closed to the browser because
  running outside the sandbox is off for this device").
- A person's approval is a new approval detail kind, `loopback`
  (`{ service, url, port, attempt, outcome }`). The card says what is reached and from where:
  "允许浏览器访问本机端口 3999？" / "Allow the browser to reach port 3999 on this device?", with
  allow (this conversation) and deny. The device owner decides, as for network asks.
- On approval the kernel writes the grant row, refreshes the service with the new grant set and
  reruns the call as `attempt + 1`, as `serviceRerunAfter` does for network asks. Deny or timeout
  leaves the call failed with a note that says the port was not approved.
- Records: `permission_reviewed` with `scopeKind: "loopback-port"`, `approval_requested` /
  `approval_decided`, the audit entry `device.loopback_granted` / `device.loopback_revoked`.

### 5.3 The panel

When a tab is blocked on a loopback port and a grant is possible, the strip shows
"本机端口 3999 未开放" with the action "允许本会话访问". The owner's click is the person's decision.
It goes to a new plugin route, then a new `ctx.deviceAccess.grantLoopbackPort(scope, port)`
(owner-only, same ceilings, same record with source `owner-panel`), and then the tab reloads.
Under Full access the agent's own call has already obtained the grant, so the strip seldom shows.

### 5.4 Applying it on the device

- **Provider capability.** `SandboxPermissionSupport.network` gains `loopbackPorts: boolean`.
  device-local reports it when the machine advertises the feature `loopbackPorts` in its hello.
  Other providers report false. No protocol bump is needed: the kernel sends the new key only to a
  machine that advertises it. An older capybara-device gets the note "update capybara-device to
  let the browser reach local ports".
- **service.ensure.** `network` gains `loopbackPorts?: number[]`, the sorted set of live grant ports
  for that service. It is parsed strictly on the machine (`services/ops.ts`) and is part of the
  service's `networkKey`, so a change restarts the service through the existing supervisor path.
  The browser restores its tabs after a restart (plugins#307 session persistence), and the rerun
  call reopens the URL.
- **macOS proxy.** The patched sandbox-runtime keeps strict mode and gains one exact carve-out:
  `allowedLoopbackPorts`. A CONNECT or absolute-URL request whose literal is in the loopback class
  (or the name `localhost`), on a listed port, is dialed to that loopback address. Nothing else
  changes: other loopback ports, private ranges, metadata and DNS answers that resolve to loopback
  stay refused. Chromium already sends loopback through the proxy (Playwright proxies loopback, and
  `NO_PROXY` is unset for restricted execs), so Seatbelt needs no outbound change.
- **Expiry and revocation.** The kernel recomputes the set on expiry (a locked periodic kernel job
  over grants past `expires_at`), on revocation, on conversation deletion (in the deleting
  transaction, through the outbox), and when the outside-sandbox setting changes. It then refreshes
  the running service. A device that is offline gets the narrowed set at its next ensure, because
  the set is always sent whole.

### 5.5 Model-facing text

All text is in English and describes the mechanism:

- Ask pending: "[network] 127.0.0.1:3999 is a local port on the device. The browser reaches local
  ports only after the port is approved for this conversation; an approval was requested."
- Granted: the call reruns. Its result says "Port 3999 on the device was approved for this
  conversation."
- Not possible: what is off and who can change it. The note keeps the existing sentence that a
  command run outside the sandbox reaches the port, because that remains true.

## 6. Data

- New kernel table `capybara.device_loopback_grants`. Columns: `id`, `org_id`, `device_id`,
  `service_id`, `conversation_id` (the root), `port`, `source` (human, review-model, full-access,
  owner-panel), `approval_id`, `created_at`, `expires_at`, `revoked_at`. There is a unique live row
  per `(device_id, service_id, conversation_id, port)`, and RLS `org_scope` through
  `rls_admits(org_id)` in the same migration.
- There is no device-side persistence beyond the service's current `networkKey`.

## 7. Multi-replica and failure

- Grant writes happen in `@Transactional()` methods. The service refresh after a grant follows the
  existing network-ask path (an outbox row for the refresh, so a replica dying after the commit
  does not leave the device narrower than the record). A refresh that cannot reach the device only
  delays the widening.
- Narrowing (expiry, revocation, deletion, setting off) is owed work in an outbox row. Until the
  device is reached, its running service keeps the old set. This is bounded: the device sends no
  traffic for a service the kernel does not drive, and the daemon's per-tab check refuses tabs whose
  conversation lost the grant, because the kernel tells the daemon the live set on each request.

## 8. Testing

- SDK: the parsing of `ServiceBlockedHost` with port and class, of `service.ensure.network.loopbackPorts`
  and of the capability.
- Device (macOS): the patched proxy allows exactly `127.0.0.1:<granted>`, `[::1]:<granted>` and
  `localhost:<granted>`. It refuses another port, `10.0.0.1:<granted>`, a name that resolves to
  127.0.0.1, and the metadata address. A `networkKey` change restarts the service.
- Kernel integration (device-fake): the approver per profile, the ceiling refusals, the rerun
  after approval, expiry by the locked job, narrowing on deletion through the outbox, and a
  sub-agent going to the review model. In the dual-replica container suite, one grant leads to one
  refresh.
- Browser plugin: blocked loopback reports the port and class, the per-tab conversation check, and
  the panel strip and route.
- Live acceptance on the Mac: the todo-app prompt, under each profile.

## 9. Rollout

- Kernel and SDK release first. device-local and the browser plugin follow, and the browser starts
  declaring `loopbackPorts`.
- capybara-device ships the proxy carve-out and the feature flag. Machines that are not upgraded
  keep today's behavior, with the update note.

## AGENTS.md rules touched

- **Sandboxes**: "private ranges, metadata and host services stay closed" gains "except a loopback
  port granted to a device service for one conversation (`loopback-port`, decided like an
  outside-sandbox escalation and bounded by the device's outside-sandbox setting)".
- **Device access (`ctx.deviceAccess`)**: add "a loopback grant is per conversation and per port,
  owner-only, and expires with the conversation or after 24 hours".

## 10. Calls left to the builder, and calls made here

Made here (the maintainer can overturn them):

- The 24-hour lifetime.
- The device owner decides a person ask.
- The three loopback names are covered by one grant.
- Database ports are allowed, with a warning in the text.
- No protocol bump: a feature flag instead.

Left to the builder:

- The exact patch shape inside sandbox-runtime.
- The name of the periodic job.
- The panel strip's layout within the existing blocked strip.
