# Close a deleted conversation's browser tabs right away

Status: design, 2026-11-27 (core#876). Amends the browser tab ownership design
([2026-11-25-browser-tab-ownership-design.md](2026-11-25-browser-tab-ownership-design.md)) §6
"Deleted conversations" and its ruling 5, and the device service protocol
(`packages/plugin-sdk/src/device-service.ts`).

## 1. Why

Today a deleted conversation's tabs close only through the daemon's idle close (15 minutes) or the
cap eviction. Until then they hold memory in the device, count against the 10-tab device cap, keep
the pages' sessions open (a page keeps polling, a signed-in app keeps a socket), and show up in
other conversations' `tabs list` under "Tabs of other conversations on this device", where an agent
could adopt a page the person meant to throw away. Nothing can reach the device for a deleted
conversation: no hook tells an extension about the deletion, and `ctx.deviceAccess` refuses a
deleted conversation.

## 2. Goals and non-goals

Goals:

1. When a person deletes a conversation, every device service running in that conversation's
   device learns it once, soon after the commit, and the browser daemon closes the tabs of the
   conversation and of its sub-agent conversations.
2. The notice is owed in the deleting transaction: a replica that dies after the commit, a provider
   that is not loaded, or a device that is offline delays it, never loses it. An offline device
   gets it when it is back.
3. No new way to reach a device for a deleted conversation: the notice is written by the kernel,
   its content is fixed, and nothing an agent, a tool call, a panel or an extension supplies can
   start or shape it.
4. Exactly-once is not needed; at-least-once with an idempotent service is. Replicas never deliver
   one notice concurrently.
5. The browser profile (cookies, storage, logins) is never touched. The idle close stays the
   backstop.

Non-goals: a kernel record of tabs (the daemon stays the one place that knows them); starting or
resuming a device to deliver the notice (a stopped service holds no tabs); org deletion and member
offboarding (their devices are destroyed or deleted, §8); a general `conversation.deleted`
extension hook (ruling 1).

## 3. Overview

```
DELETE /conversations/:id
  markDeleted (one transaction)
    ├─ conversations.deleted_at = now()
    ├─ INSERT device_conversation_notices (org, device, conversation)   ← owed, ON CONFLICT DO NOTHING
    └─ outbox: cap-kernel-maintenance / device-conversation-notice, jobId dcn-<row id>
after commit
  worker (any replica): claim the row → device running? → each running extension service:
      request body {"capybara":"conversation-deleted","conversationId":"<id>"}
    → delivered: delete the row        unreachable: keep it owed (sweep retries)
  @LockedInterval sweep (every 30 s): owed rows whose turn came → same attempt
browser daemon (on that request)
  close tabs owned by <id> or rooted at <id>; drop their per-conversation state; save the session file
```

## 4. The kernel notice (core)

### 4.1 Owing it in the deleting transaction

`ConversationsService.markDeleted` already resolves the deletion subject: the tree's root and the
root's device (`deletionSubject`, locked by the prelude and re-checked inside the transaction).
When the subject has a device, the same transaction:

- inserts one row into the new kernel table `device_conversation_notices`
  (`id`, `org_id`, `device_id` (FK `devices` ON DELETE CASCADE), `conversation_id` (the deleted
  conversation), `kind` (`'conversation_deleted'`, a CHECK; the only kind), `created_at`,
  `attempts`, `next_attempt_at`, `claimed_until`, `acked_services` (the service ids that answered),
  `last_failure`), unique on
  `(device_id, conversation_id, kind)`, `ON CONFLICT DO NOTHING`;
- adds an outbox job on the kernel maintenance queue (`MAINTENANCE_QUEUE_NAME`), name
  `device-conversation-notice`, job id `dcn-<row id>` (no `:`), registered in
  `infra/outbox/registry.ts` with its idempotency sentence ("the attempt claims the row and the
  service's handling is idempotent; a delivered notice deleted its row, so a repeat finds none").

The row is the owed work (intent first); the outbox job is only the prompt first attempt, so the
notice does not wait for the next sweep tick. A rollback owes nothing. The migration ships the
table's RLS policy (`org_scope` through `rls_admits(org_id)`, `check:org-filter`).

Only the deleted conversation is named. A person deletes only a chat conversation (a sub-agent's is
read-only), and its sub-agent conversations are not marked deleted themselves; the service learns
the tree through the root id its tabs already record (`{ owner, root }`, tab ownership §4).

### 4.2 The message (SDK device service protocol)

A second kernel request body beside the roll check (`DEVICE_SERVICE_ROLL_CHECK`), on a request
connection:

```json
{"capybara":"conversation-deleted","conversationId":"<id>"}
```

The SDK exports `DEVICE_SERVICE_RESTORE_MAX_AGE_MS` (ruling 4), `encodeConversationDeleted(conversationId)` and
`parseConversationDeleted(body): { conversationId } | null` (never throws; null for any other
body), and documents in the module header: the kernel sends it to every running service of an
extension on the conversation's device after the conversation was deleted, at least once; a service
forgets everything it keeps for that conversation and for conversations whose tree root it is, and
answers with any message (the answer is not read beyond "it answered"); a service that does not
know it ignores it, as it ignores every unknown body. SDK public API change: `pnpm gen:sdk-api` and a
changeset on `@capybara-hq/plugin-sdk`. Providers and the device program pass it through unchanged
(it is an ordinary request body), so device-docker, device-e2b and device-local need no change.

### 4.3 Delivering it

`DeviceConversationNotices` (kernel `device-access/`, worker role for the processor and the sweep;
the owing helper on every role):

1. **Claim.** `UPDATE … SET claimed_until = now() + 60 s, attempts = attempts + 1 WHERE id = $1
   AND org_id = $2 AND (claimed_until IS NULL OR claimed_until < now()) RETURNING *`, in the
   notice's org scope: the job carries `orgId` (so `runJob` scopes it), and the sweep lists due
   rows under `asPlatform` (an `org-filter: deployment-wide` marker) and attempts each inside
   `withOrgScope(row.org_id)`. No row → done
   (another replica holds it, or it was delivered). The claim is a row lease, not a lock held in a
   transaction; the attempt's own deadline (20 s) is under the lease, so two replicas never deliver
   one row at once. A replica that dies mid-attempt leaves a claim that expires; the sweep takes
   the row again.
2. **Device.** The device row must exist and not be deleted (else delete the notice: a deleted
   device holds no services). Its provider must be loaded on the replica
   (`SandboxService.providerLoaded`, as lifecycle cleanup does, whatever the org says now: a
   provider the org switched off since may still run the service); else the row stays owed for
   the next turn.
3. **Running?** Through `SandboxService.ifRunning` on the device's current instance only (never
   create, resume or start). The declared services are the service ids the deployment's approved
   extensions declare (`permissions.deviceAccess.services` of the approved permission snapshots of
   the installed or served versions, as `queryLifecycleSubscribers` reads deployment state;
   `deviceServiceId`). For each declared service not yet in `acked_services`, the provider's
   `serviceStatus`: a running one gets the body through `serviceRequest` (timeout 10 s) and joins
   `acked_services` when it answers; a stopped one stays pending. Org enablement does not count:
   a running service of an extension switched off since still holds the tabs.
4. **Outcome** (ruling 4). Delivered (the row is deleted) when every declared service acked, or
   when the restore window `DEVICE_SERVICE_RESTORE_MAX_AGE_MS` (SDK, 10 minutes; the daemon's
   session file uses the same constant) has passed since the deletion and the attempt reached the
   device (every service it found running acked, or none ran, or there is no running instance).
   Before the window ends, a stopped service or a device with no running instance (suspended,
   destroyed) keeps the row owed: a service started or resumed within the window may restore its
   saved state, and then gets the notice on the next tick. The device did not answer or the
   request was not sent (`isUnreachable` of `background/stop.ts`: offline, dial-in reconnect,
   program restarted, answer timeout) → the row stays owed whatever the window (a machine that
   comes back may still run its daemon), `next_attempt_at = now() + backoff` (30 s doubling,
   capped at 2 minutes), `last_failure = 'unreachable'`. Any other error (a provider failure, a
   service that answered an error frame) → the same, `last_failure` its clipped message, logged
   at warn. A service that acked is never asked again for this row.
5. **Sweep.** `@LockedInterval("device-conversation-notice-sweep", 30 s)` under `WorkerModule`:
   up to 16 owed rows whose `next_attempt_at` came and that are not claimed, oldest
   `next_attempt_at` first, devices side by side and one device's rows one after another (one
   silent machine costs one attempt per tick). Rows older than 7 days are deleted with an info log:
   a device away that long has run its own idle close long before it could matter (§6).

"Delivered on reconnect" is therefore "within one sweep tick plus the backoff after the device is
back", at most about 2.5 minutes. A device that was deleted, or whose org was deleted, drops its
rows by the FK cascade or by step 2.

### 4.4 Who can make it happen

Only `markDeleted`. There is no `ctx` method, tool, route or Platform operation that writes a
notice or names a conversation for it; the body is built by the kernel from the deleted row's id;
the device is the one the deleted conversation's root was bound to. `ctx.deviceAccess` keeps
refusing deleted conversations unchanged. An extension can already send its own services any body
through `ctx.deviceAccess.request` for a live conversation (full trust, browser use spec §7); that
stays as it is and gains nothing here (ruling 3).

## 5. The browser daemon (plugins)

- The daemon's request handler recognizes the body with `parseConversationDeleted` before it parses
  a `ToolRequest`, and handles it outside the per-conversation queues and outside the takeover gate
  (it is not an agent action, and the person controlling the browser from another conversation's
  panel is not interrupted beyond the deleted conversation's tabs disappearing from the strip).
- It closes every tab whose `owner` is the id or whose `root` is the id (the conversation and its
  sub-agents), including a tab a viewer currently shows and a tab with a held decision dialog or a
  parked wait, and deletes the per-conversation state of each such conversation exactly as the idle
  close does (active entry, queue, `unreported`, handoff, parks, hand back flag, counters). A
  request of that conversation in flight finishes against a closed page and fails (its run was
  already stopped by the deletion). Viewers of another tree that listed those tabs under
  `otherTabs` get a fresh state.
- It saves the session file right away, so a restart within `RESTORE_MAX_AGE_MS` does not restore
  the closed tabs.
- It answers `{"ok":true,"closed":<n>}`; a second delivery closes nothing and answers the same with
  0. If the browser is not launched, there are no tabs: it drops matching per-conversation state and
  answers.
- It never touches the profile (no cookie, storage or cache clearing): only `page.close()`.
- If closing leaves the daemon with no conversation and no viewer, the daemon's own idle stop runs
  as usual.

The plugin raises its manifest's `sdk` range to the SDK release with `parseConversationDeleted`.
device-local, device-docker and device-e2b need no change (§4.2); the plan confirms device-local's
request path passes a request body of this shape untouched.

## 6. Backstops and gaps

- **Idle close stays** (tab ownership §6): tabs of a conversation that stopped using the browser
  still close after 15 minutes; the notice only makes deletion immediate.
- **Service stopped at delivery, restarted soon after.** The row stays owed for the restore window,
  so a service restarted (or a device resumed) within it gets the notice right after it starts. A
  service that restores state saved less than `DEVICE_SERVICE_RESTORE_MAX_AGE_MS` ago is the SDK
  contract; one that keeps saved state longer is on its own (the browser daemon does not).
- **Device away for more than 7 days.** The row expires; when the machine wakes, the daemon's idle
  close runs on its own timers.
- **Org deletion and member offboarding** do not owe notices: offboarding soft-deletes the member's
  personal devices and owes their destroy; org deletion purges devices. The idle close covers a
  daemon that outlives either.

## 7. Multi-replica and trust

- Owed in the transaction (row + outbox job); queue name and job id without `:`; the sweep is a
  `@LockedInterval`, it and the processor only under `WorkerModule`; no process memory; no lock
  inside a transaction (the claim is a row lease).
- Concurrency across replicas: the claim makes one attempt per row at a time; a repeat after a lost
  claim is harmless (idempotent service). A second delete of the same conversation finds it deleted
  and owes nothing; the unique key and `ON CONFLICT DO NOTHING` are the backstop, and a replayed
  outbox job finds the row claimed or gone.
- Cross-tenant: the row carries the conversation's org; the device is read with that org
  (`devices.org_id = row.org_id`), so a notice can only reach the device the deleted conversation
  was bound to in its own org. The table's RLS policy ships in the migration.
- Device access rule: the notice goes only to the device the conversation's owner used for it, and
  only says "forget this conversation"; no agent, panel or extension input reaches it.

## 8. Tests

- SDK unit: `encodeConversationDeleted` / `parseConversationDeleted` round trip; other bodies,
  malformed JSON and a roll check parse as null.
- Kernel integration (one app): deleting a conversation bound to a device-fake device owes one row
  and the outbox job in the same transaction (a rolled-back delete owes nothing); delivery sends the
  exact body to each running declared service and skips stopped ones; no running instance settles
  without starting one; deleting a conversation without a device owes nothing; the row of another
  org's device is never reached (org check).
- Kernel dual-replica (`container` project): two kernels with the worker role on one database
  and one device-fake root attempt the same owed notice: overlapping attempts deliver it once (the
  other skips), and a held lease (an attempt stalled inside the device call) keeps the other
  replica out until it runs out, as a dead replica's does; then the other replica delivers.
- Plugins (browser daemon): the notice closes the owner's and the tree's tabs and only those, drops
  their state, saves the session file, answers 0 on repeat, works with the browser not launched,
  works during a takeover, and leaves the profile directory untouched (a cookie set before survives).

## 9. Rulings

1. **A kernel-written device service notice, not a `conversation.deleted` extension hook plus a
   `ctx.deviceAccess` cleanup method** (deviates from the issue's proposal). The owed delivery must
   live in the kernel anyway (an offline device outlasts the lifecycle hook's retries, and an
   extension holds no timers); with the hook, the kernel would store an extension-chosen body for a
   deleted conversation behind a new `ctx` method that accepts deleted conversations, a wider device
   access surface and a two-hop durability chain (lifecycle job, then owed row). The kernel already
   writes its own request bodies to every service (the roll check), so a fixed kernel body is the
   narrowest path: nothing outside `markDeleted` can trigger or shape it. Cost if wrong: a plugin
   that needs server-side cleanup on deletion (data it keeps in PG) gets a `conversation.deleted`
   lifecycle hook later, a small addition on `LifecycleHooks` (same outbox pattern).
2. **Sent to every running service of an approved extension on the device, not only the browser's.**
   Same as the roll check; services ignore unknown bodies (SDK contract). Avoids a new opt-in
   field in the permission manifest. Cost if wrong: a few extra request round trips per deletion
   on devices running other services.
3. **No filter on extension request bodies.** `ctx.deviceAccess.request` does not refuse a body
   shaped like a kernel message: the extension is fully trusted and can already close its own tabs;
   an agent never supplies a request body (the browser server builds bodies from typed fields).
   Cost if wrong: a buggy extension could make its own service drop a live conversation's tabs.
4. **"No service running" keeps the notice owed until the restore window has passed** (changed in
   review, 2026-11-27). A stopped service or a suspended device holds no tabs now, but a restart or
   resume within the window restores the session file. The window is one SDK constant,
   `DEVICE_SERVICE_RESTORE_MAX_AGE_MS` (10 minutes), which the browser daemon's session file uses
   as its restore limit, so kernel and service agree. Cost if wrong: a row lives up to 10 minutes
   per deletion and the sweep checks the device's services every tick meanwhile (only
   `serviceStatus` calls; never a start or resume).
5. **Polling with backoff (30 s sweep, ≤ 2 min backoff), not a dial-in reconnect trigger.** Same
   shape as owed background stops, and it covers every provider (docker and e2b have no "reconnect"
   event). Cost if wrong: up to ~2.5 minutes after a laptop wakes before its tabs close.
6. **Owed for 7 days at most.** Bounds the table for devices that never return. Cost if wrong: a
   machine back after a week keeps the tabs until its idle close.
7. **The notice names only the deleted conversation; the daemon closes by owner or root.** Sub-agent
   conversations are not marked deleted, and the daemon already knows each tab's root. Cost if
   wrong: none known; a non-root deletion (not possible from the UI today) closes only that
   conversation's own tabs and its descendants rooted there.

## AGENTS.md rules touched

- **Device access (`ctx.deviceAccess`)**: unchanged for extensions (deleted conversations stay
  refused); one clause added: "a deleted conversation is refused, and only the kernel's
  conversation-deleted notice (owed in the deleting transaction, kept owed until the device's
  services ack it or the restore window passes) reaches its device."
- **Multi-replica discipline**: followed as written (owed row and outbox job in the deleting
  transaction, `@LockedInterval` sweep and processor under `WorkerModule`, job id without `:`, row
  lease instead of a lock in a transaction).
- **Migrations**: new kernel table with `org_id` ships its RLS policy in the same migration.
- **Public API reports**: SDK device service protocol helpers, `pnpm gen:sdk-api` and a changeset on
  `@capybara-hq/plugin-sdk`.
- **Extensions / Sandboxes**: no contract change; providers pass the body through.
