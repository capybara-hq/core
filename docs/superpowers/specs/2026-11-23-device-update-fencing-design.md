# Fencing token for device provider lifecycle calls

Issue: #748. Status: draft for review. Written against core `main` at `d0860858c` and plugins
`main` at `cdc91b8` (`device-docker` with the in-place allowlist of plugins#186).

Related: Docker in-place network update design (`2026-11-23-docker-in-place-network-update-design.md`,
§3.6 and §6, merged in #705); device provider spec (`2026-11-21-device-provider-design.md`, §6.1,
§6.3); the writing-device-providers skill ("SandboxService lifecycle", "Limits and the device sandbox
network").

## 1. Problem

The kernel calls `DeviceProvider.update` under the device's exclusive lease, and every state write
that follows is fenced by `device_instances.generation`. That protects the kernel's **record**, not
the provider's **resources**. A replica can lose its lease without noticing (a long GC or VM pause,
a stalled event loop, a request that sits in a socket buffer) and still deliver a provider call
after another replica took the lease and changed the device:

1. Replica A holds the exclusive lease and computes the desired limits: allowlist `W` (wide).
2. A stalls. Its lease expires; its watchdog has not fired yet, or fired after the request left.
3. The admin removes a host. Replica B takes the exclusive lease and applies `N` (narrow) through
   `update`; the proxy closes connections to the removed host; B records `N`.
4. A's `update(W)` reaches the provider. device-docker's in-place apply reads the proxy's digest
   (now `N`'s), sends `apply W ifDigest=N`, and the proxy accepts: the compare-and-swap of plugins#186
   only refuses an apply whose read came **before** B's change.
5. A's fenced record write fails (generation mismatch), so the kernel's record says `N` while the
   proxy enforces `W`. Nothing reapplies `N` until the record and the desired limits differ again.

The egress proxy comment and `applyInPlace` already name the gap: "only a kernel fencing token would
close it; `update` carries none". Step 4 widens the network of a running sandbox behind the
kernel's back, which breaks the Sandboxes rule "every provider enforces allowlists" in the one
direction that matters.

A second case needs no newer write at all. The record says `[a]`; the org adds `b`; A calls
`update([a, b])` and stalls as above; the org removes `b` again. B now finds record `[a]` = desired
`[a]`, so `mustApply` is false and B never calls the provider. A's late call lands and nothing ever
narrows it: the kernel recorded only what it knew had succeeded, not what might be in flight. A
token alone cannot catch this (no newer token ever reaches the proxy); it needs the intent of the
call recorded first (§7.2), which AGENTS.md already asks for: "an external call whose effect must
match a record writes its intent first".

The same shape exists for `create` and `destroy` on the recreate path (§4.3), and for every
provider whose `update` cannot compare anything (E2B, §6.1).

## 2. Decision in one paragraph

The kernel passes a **fence token** to every lifecycle call it makes under the exclusive lease that
can change what an instance enforces: `update`, `create`, `destroy` and `destroyByName`. The token
is the device row's fencing generation (`device_instances.generation`) as the holder last wrote it,
a number that only grows and that a later exclusive holder always sees strictly higher. A provider
that keeps state for an instance stores the highest token it has applied **next to that state**, in
the same atomic step as the state, and refuses a call whose token is lower. device-docker stores it
in the egress proxy's `allow.json` (checked inside the proxy's serialized apply, so the check and the
swap are one step) and stamps it on the containers at `create`. The SDK adds the token as a
parameter the kernel always sends; honoring it is a documented duty for a provider that can, and a
provider that cannot (E2B: no conditional write in its API) states the residual race in its README.
Before the call the kernel records, fenced, that an `update` to the target may be in flight, so the
next exclusive holder applies the desired limits again (with its higher token) even when the record
of what succeeded already matches them. `device-provider@1` stays at version 1.

## 3. The token

### 3.1 What it is

`device_instances.generation` (migration `0023`, `integer NOT NULL DEFAULT 0`) is the fence the
kernel already uses for its own record (`SandboxService.fenced`):

- every exclusive acquisition does a fenced compare-and-increment first (`ensure`,
  `reconcileLimits`, the sweeps, `destroyRow`), so a holder whose lease expired fails its next
  record write;
- every shared acquisition bumps it unconditionally (`enter`), never compares it;
- `commitHandle` (permission-instance-writes) increments it with the handle commit; `filesGone`
  increments it with `fs_status = 'lost'`.

Nothing ever lowers it. The row is deleted only when the device is deleted (`destroyRow` with mode
`device`), and a deleted device never gets a row again (`ensure` inserts only for a live device).

It is **not** the Redis lease token (`SandboxLease.token`, a random UUID with no order) and **not** the
"instance generation" (`String(created_at.getTime())`, which names one incarnation and does not
change on `update`). The issue's "lease generation" means this record fence.

### 3.2 The value passed

The token is `fence.gen` at the moment of the call: the value the holder's own last fenced write
committed. Properties the design relies on:

- **Strictly higher for a later holder.** Holder A's acquisition moved the row from `g` to `g+1`
  with a compare-and-increment; any holder B that acquires afterwards moves it from at least `g+1`
  to at least `g+2` before its first provider call. So every call of B carries a token greater than
  every call of A. Two holders never share a token value: the compare-and-increment makes exactly
  one writer move the row to each value.
- **Non-decreasing within one holder.** A holder's fenced writes raise its own `fence.gen`; a later
  call of the same holder carries an equal or higher token.
- **Committed before the call.** The increment must be visible to every replica before the
  provider sees the token. The lifecycle path is written to run its provider calls outside any
  transaction (the handle commit and the report refresh go through `runOutsideTransaction`, and a
  provider call inside a transaction would already break the outbox rules), so each fenced write
  commits on its own. The implementation adds a test that asserts it for the calls of §4.3 (a fenced
  write still open in a transaction would let a second holder read the old value and pass an equal
  token).
- **Bounded by the row.** An instance's stored token is always one the row has held, so it never
  exceeds the row's current generation. A current holder, whose token equals the row, is therefore
  never refused (no false refusal on a healthy path).

Shared holders never call `update`, `create` or `destroy`, so their unconditional bumps only make
the next exclusive holder's token larger.

### 3.3 Range

`integer` holds 2^31 - 1. A device bumps the generation once per use (shared acquisitions included),
so one use per second for 68 years. No widening to `bigint`; the SDK type is a JavaScript safe
integer, so a later widening needs no contract change.

## 4. The SDK contract (`packages/plugin-sdk/src/device-provider.ts`)

### 4.1 Shape

```ts
/** A lifecycle call's fence (device-provider spec fencing design §3). */
export interface DeviceFence {
  /**
   * The device's fencing generation as the calling holder last wrote it: a non-negative safe
   * integer, strictly higher for every later exclusive holder of the device, never lower for later
   * calls of the same holder.
   */
  readonly token: number;
}

update?(h: SandboxHandle, limits: SandboxLimits, signal: AbortSignal, fence: DeviceFence):
  Promise<"updated" | "recreate">;
create(args: { name; image?; limits; fileSystem; signal; fence: DeviceFence }): Promise<SandboxHandle>;
destroy(h: SandboxHandle, signal: AbortSignal, fence: DeviceFence): Promise<void>;
destroyByName(name: string, signal: AbortSignal, fence: DeviceFence): Promise<void>;

/** Thrown by a lifecycle call whose fence is lower than one the instance already applied. */
export class StaleFenceError extends Error {}
```

An object rather than a bare number leaves room for a later field (a device id check, say) without
another signature change; before 0.1.0 either is cheap.

### 4.2 Required to send, optional to honor

- The **kernel always sends** the token on those four calls. In the type it is required, so a kernel
  call site cannot forget it (typecheck).
- A **provider may ignore it.** A trailing parameter or an extra field in `args` is
  source-compatible for an implementation that does not read it (TypeScript accepts a function with
  fewer parameters), so device-e2b and device-local compile unchanged.
- The doc states the duty: a provider that keeps per-instance state it can update conditionally
  **must** store the highest token next to that state, compare and store in one atomic step, and
  throw `StaleFenceError` for a lower token; an equal token is the same holder and is accepted. A
  provider that cannot (no conditional write in its backend) says so in its README with the residual
  race (§6.1). `update` and `create` carry the duty; for `destroy` / `destroyByName` it is a
  "should" (§4.3).
- **No capability flag.** The kernel behaves the same either way (it always sends; a refusal is an
  ordinary error), so a `fencing: true` declaration would have no reader. Open question 3.

### 4.3 Which calls, and why

A late call matters when it can make an instance enforce more than the newest holder put in force.

| Call | Late arrival can widen? | Fenced |
|---|---|---|
| `update` | Yes: §1. | Must, when the provider can. |
| `create` | Yes: a stale holder on the recreate path makes a new instance with its older, wider limits (device-docker's `create` first `destroyByName`s whatever runs under the name, B's instance included). It also must seed the new instance's stored token, or a stale `update` would pass against a fresh token of 0. | Must seed; should refuse when the existing instance under the name carries a higher token. |
| `destroy`, `destroyByName` | Not by itself: it ends an instance (an availability loss). But on the recreate path a stale `destroy` of B's instance is what lets the stale `create` that follows run unopposed. | Should refuse a higher-token instance. |
| `resume` | No: it restarts what is stored; device-docker rebuilds a lost proxy only from the config volume (the list in force) or, for a pre-control instance, the create labels (its lower bound). | No token. |
| `suspend`, `killAll`, `killTagged`, `revokeOperation` | No: they stop work. | No token. |
| `createFileSystem` | No: it returns the existing file system for a name. E2B fixes the network here, but a late call finds the existing sandbox and changes nothing. | No token. |
| `destroyFileSystem` | No (data loss, not a wider network); out of scope. | No token. |
| `exec`, `operation`, `background.start` | Per-operation network is the operation authority's (grants, revocation by operation id); a stale holder's operations are revoked by the takeover. | Out of scope. |

### 4.4 Versioning

Additive: `device-provider@1` stays. `pnpm gen:sdk-api`, a changeset bumping
`@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:api-changeset`), the `device-provider` agent-docs
topic regenerated (`pnpm gen:agent-docs`). Before 0.1.0, so no shim for a provider built against the
old type: the parameter is simply new.

A **new provider on an old kernel** (no token arrives) must never be weaker than today: device-docker
treats a missing token as "cannot prove freshness" and answers `"recreate"` to an in-place `update`
(today's behavior for a narrowing on a pre-control instance), seeds 0 at `create`, and destroys
without a check. That is a fail-closed default, not a compatibility layer; the core bootstrap pin of
the new plugin version only lands after the kernel sends the token (§10).

## 5. device-docker

### 5.1 Egress proxy (`egress-proxy/proxy.mjs`)

- **Stored token.** `allow.json` becomes `{ mode, hosts, deniedCidrs, digest, fence }`. The policy
  object gains `fence` (number). At start the proxy takes `fence` from a valid `allow.json`, else from
  the new env `FENCE` (set by `createEgress`), else 0. An `allow.json` without a valid `fence` is
  invalid (the proxy refuses to start, as for any unreadable file today): this version writes it on
  every apply, and an old file only exists on instances of the previous plugin version, whose proxies
  run without the token until their next recreate (§10).
- **Apply.** The control request becomes `{ op: "apply", config, fence }`; `ifDigest` is removed (the
  token supersedes the compare-and-swap; open question 2). Inside the serialized `chain`, before
  anything else:
  - `fence` missing or not a non-negative safe integer: refuse ("The apply carries no valid fence").
  - `fence < policy.fence`: refuse with a distinct error code
    (`{ ok: false, error, code: "stale-fence", fence: policy.fence }`), nothing written, nothing
    swapped, no connection touched.
  - `fence >= policy.fence` and the digest is the one in force: if `fence > policy.fence`, write
    `allow.json` with the raised fence (so a later stale apply is refused even though the list did not
    change), then reply. Otherwise reply at once (idempotent).
  - otherwise: write `allow.json` with the new list and `fence`, swap, close uncovered connections,
    reply, as today.

  The chain serializes applies, and the check, the file write and the swap run in one turn of it, so
  two applies cannot interleave between the comparison and the store. That atomicity is why the proxy,
  not the provider code in the replica, is the authority.
- **Status** adds `fence` to its reply.

### 5.2 Provider (`src/provider.ts`)

- **`create`** gets `fence`:
  - labels the sandbox container and the proxy with `dev.capybara.sandbox.fence=<token>` and passes
    `FENCE=<token>` to the proxy;
  - before its `destroyByName` of an existing instance under the name, reads that instance's token
    (the higher of the sandbox container's `fence` label and the proxy's `status.fence` when the proxy
    runs) and throws `StaleFenceError` when it is higher than `fence.token`. This is check-then-act
    (Docker has no conditional remove), so it refuses a late `create` that arrives whole after the
    newer holder's change, not one that pauses between the read and the remove; §5.3 covers the rest.
- **`update`** passes `fence.token` to the control apply and maps the `stale-fence` reply to
  `StaleFenceError`. The `"swap"` branch (delete and recreate the proxy) is not fenceable (it
  deletes first): it is kept only where no list changes (open-public to open-public), and for an
  instance without the control label (made by a previous version) an allowlist change answers
  `"recreate"` instead of swapping (open question 4). Without a token (old kernel): `"recreate"` for
  every allowlist change.
- **`destroy` / `destroyByName`** with a token: read the existing sandbox container's `fence` label
  and refuse (`StaleFenceError`) when it is higher. The label is the create-time token, a lower bound
  of the instance's token, which is enough here: the destroy that matters is a stale holder removing
  an instance a newer holder **created** (a newer holder's in-place updates are refused by the proxy
  directly).
- `ensureEgressRunning` (resume, auto-start) rebuilds a lost proxy from the config volume, which
  keeps the stored `fence`; the env `FENCE` on a rebuilt proxy is the create label's value, only used
  when the volume holds no file yet (the instance was never updated in place).

### 5.3 Instance identity (closing the stale `create`)

A late `create` that slips past the check of §5.2 (a pause between the read and the remove) replaces
B's instance under the same name with one built from A's older limits. A's handle commit then fails
and A destroys what it made (best effort), but until then, or forever if A crashes first, B's handle
(`{ id: name }`) names the replacement: B's next `exec` would run in an instance with A's wider
network.

The fix is that a handle names one incarnation: device-docker's handle carries the token its
instance was created with (`{ id: name, fence: <token> }`), and every call on a handle checks the
sandbox container's `fence` label against it (the exec path already inspects or addresses the
container; the check is a field comparison on a response it has, or addressing the container by its
Docker id kept in the handle). A mismatch is `SandboxGoneError`, so the kernel rebuilds under B's
lease and `create` removes A's leftover. device-local already works this way (its handle's
`generation` must equal the machine's bound generation). This is the same pattern applied to Docker;
open question 1 asks whether it ships with #748 or as a follow-up.

### 5.4 Failure modes (device-docker)

| Situation | Result |
|---|---|
| Stale `update` reaches the proxy after a newer apply | `stale-fence`, nothing changes; A's `update` throws `StaleFenceError`; A's kernel stops (its next fenced write fails anyway). |
| Stale `update` arrives first, newer one second | Both apply in order; the newer list wins. A's record write fails. |
| Stale `update` after B recreated the instance | B's `create` seeded the new proxy with B's token: refused. If the instance is gone (between B's remove and create), `update` answers `"recreate"` as today and A's recreate path meets §5.2's checks. |
| Proxy crashes between the file write and the swap | Restarts from `allow.json`, list and fence together (written in one file, one rename). |
| `allow.json` or the config volume lost | Unchanged from #705: rebuild only from the volume, else `resume` answers `gone` / `update` answers `"recreate"`; the recreate seeds the current token. |
| Proxy holds a token higher than the row (cannot happen; §3.2 bound) | Every `update` refused: the kernel treats a thrown `update` as a recreate (instance-bound provider), which builds a fresh proxy with the current token. Fails closed and heals. |
| Kernel without the token, new plugin | In-place changes answer `"recreate"` (§4.4). |
| Proxy of the previous plugin version, kernel with the token | The provider sees no control label of this version (§10) and answers `"recreate"` for allowlist changes; the recreate builds a fenced instance. |

## 6. Other providers

### 6.1 device-e2b

`update` is `PUT /sandboxes/{id}/network`, which replaces the configuration unconditionally. E2B's
API has no conditional write and sandbox metadata is fixed at creation, so there is nowhere to keep a
token that the write itself checks. device-e2b ignores the token, and its README states the residual:
a replica that lost its lease without noticing can still apply an older network list after a newer
change, until the next lifecycle step applies the desired list again.

A provider-side check-then-act (read the network, compare, then `PUT`) cannot close it either,
and would add a call for nothing. What narrows it is the kernel: the installed evidence it reads under
the lease (`networkFromInfo` from `GET /sandboxes/{id}`) reports the network the VM really has. Open
question 5 proposes treating "evidence wider than the record" as a reason to apply again at the next
exclusive step. E2B's `create` attaches the file system's sandbox and changes nothing about its
network (fixed at `createFileSystem`), so its token needs no handling there either.

### 6.2 device-local

device-local has no `update`: the network travels with each operation (`limitsForCommand` from the
operation's scope), and the operation authority already fences stale operations (holder tokens,
revocation by operation id). Its `create` binds a new generation on the machine and its handle checks
that binding on every call, which is the identity check of §5.3. It ignores the token. Nothing to
change beyond the SDK type.

### 6.3 device-fake (core test fixture)

`packages/kernel/test/fixtures/plugins/device-fake` stores the highest token per instance in its
shared root (next to the limits it records, in one atomic file write) and refuses a lower one in
`update`, seeds it in `create`, checks it in `destroy`. A config switch `fencing: "ignore"` keeps the
current behavior so the dual-replica test can show the race without the fix (§9).

## 7. Kernel (`packages/kernel/src/sandbox/sandbox.service.ts`)

### 7.1 Passing and handling the token

- `applyLimits`: `p.impl.update(handle, providerLimits(want), signal, { token: fence.gen })`;
  `create`: `fence: { token: fence.gen }` in the args; `reconcileLimits`: the same on its `update`;
  `destroy` / `destroyByName` calls made under a fence (`applyLimits`, `destroyInstance`, the
  lost-lease cleanup in `create`) pass it.
- `StaleFenceError` from any of them means this holder is stale: the kernel handles it as
  `SandboxLockLostError` (reason `generation`) without the recreate fallback (a recreate by a stale
  holder is exactly what must not happen), and logs it once at warn with the device id and both
  tokens. It is never surfaced to the model or a person as anything but the lock-lost error the stale
  holder's next record write would raise anyway.
- `applyLimits` today treats a failed `update` of an instance-bound provider as "recreate": it must
  check `StaleFenceError` **before** that branch.
- No migration, no config. The token is read from the row already held.

### 7.2 Intent before `update`

`applyLimits` and `reconcileLimits` write, fenced and before calling `update`, the target as
`instance_limits.pending` next to the recorded `applied` (same JSON column, so no migration;
`readInstanceLimits` / `instanceLimitsJson` gain the field). Meaning: "the instance enforces
`applied`, or `pending` if an update landed that the kernel never heard back from".

- On `"updated"` the fenced write records `applied = target` and clears `pending` (one write, as
  today plus the clear).
- On `"recreate"`, a gone instance or a failed `update`, the recreate's `create` writes a fresh record
  (no `pending`). On quarantine (abort, or a file-system-bound provider) `pending` stays, so the next
  use applies again.
- `mustApply` is true whenever `pending` is present, even when `applied` equals the desired limits:
  the next exclusive holder re-sends the desired list with its own, higher token. For device-docker
  that lands in the proxy before or after A's late call; before, the proxy then refuses A's; after,
  it narrows A's. Either way the proxy ends on the desired list. `limitsState` (the device view)
  reports `pendingNextUse` for a row with `pending`.
- For a file-system-bound provider (E2B) the `unapplied` semantics are unchanged; `pending` only
  says a network write may have landed.

This is the outbox rule's "intent first" for an external call whose effect must match a record.
It costs one extra fenced write per network change (rare) and, after a stale holder, one extra
`update` on the next exclusive use.

## 8. Multi-replica reasoning

- The authority for "which call is newer" is the device row's generation in PG, moved only by
  compare-and-increment for exclusive holders; the authority for "what is in force" is the provider's
  state (the proxy's `allow.json`). The design puts the comparison where the state is, so a call's
  order of arrival no longer matters, only its token.
- No process memory, no timers, no new Redis key: the token is derived from the row a holder already
  read under its lease, and the provider stores it with its own state.
- The lease still serializes healthy holders; the token only decides the unhealthy case (a holder
  whose lease ended while its call was in flight). It does not replace the lease: two healthy
  holders never run lifecycle calls together.
- A refused stale call leaves the newer holder's state untouched, and the stale holder's record write
  would fail anyway, so the record and the resource agree again.
- A stale call that lands **before** any newer holder touched the provider is caught by the intent
  (§7.2): the row still carries `pending`, so the next exclusive holder sends the desired list with
  a higher token, which wins whatever the arrival order. The two pieces are needed together: the
  token orders writes that reach the provider, the intent makes sure a newer write is sent at all.

## 9. Tests

- **SDK unit**: `DeviceFence` in the API report; `StaleFenceError` exported.
- **Proxy unit** (`plugins/device-docker/test/egress-proxy-control.test.ts`): apply without a fence
  refused; lower fence refused with `stale-fence` and no file write, no swap, no connection closed;
  equal fence and same digest idempotent; higher fence and same digest persists the raised fence;
  restart reads the fence from `allow.json`; `FENCE` env used without a file; an `allow.json` without
  `fence` stops the proxy.
- **Docker integration** (`plugins/device-docker/test/network-in-place.test.ts`, real Docker):
  update with token 7 then 6 keeps the list of 7 and throws `StaleFenceError`; a stale wider update
  after a narrowing keeps the connection to the removed host closed; `create` seeds the label and the
  proxy fence; a late `create` and a late `destroy` against a higher-labelled instance are refused;
  no token: allowlist change answers `"recreate"`; with §5.3, a handle whose fence differs from the
  container's label gets `SandboxGoneError`.
- **Kernel integration** (`packages/kernel/test/sandbox/limits.test.ts` or a new file): the token
  passed equals the row's generation at the call; `StaleFenceError` from `update` neither recreates
  nor records; the fenced writes on the lifecycle path are outside a transaction; `pending` is written
  before `update` and cleared on `"updated"`; a row with `pending` and `applied` equal to the desired
  limits calls `update` on the next use and shows `pendingNextUse`.
- **Dual-replica container test** (new `packages/kernel/test/sandbox/update-fencing.dual.test.ts`,
  added to `container-tests.json`): two kernels sharing PG, Redis and the device-fake root, the fake
  in `updateMode: "updated"`.
  1. Org allowlist `[a.example]`; a use on replica A creates the instance.
  2. The org adds `b.example`. A use on replica A enters `applyLimits` with `[a.example, b.example]`;
     the fake's `update` is held (the existing hold seam) **after** it captured its arguments and
     **before** it checks and stores, modelling a request in flight. The org then removes `b.example`
     again.
  3. The test ends A's lease (deletes `capk:sandbox:<deviceId>` and the users set, as an expiry
     would), keeping A's call held.
  4. A use on replica B takes the exclusive lease, applies `[a.example]` with a higher token and
     records it.
  5. The hold is released. Expected: the fake refuses A's call (`StaleFenceError`); the fake's
     applied limits and the PG record both say `[a.example]`; A's use fails with the lock-lost error;
     no recreate happened (instance id unchanged).
  6. The same scenario with `fencing: "ignore"` ends with the fake applying the wide list while PG says
     narrow: the red proof that the test measures the race (run once when writing it; kept as a test
     that asserts the mismatch, so a fake that silently stops modelling the race fails).
  7. The no-newer-write case of §1: as above, but the org list returns to the recorded `[a.example]`
     before B's use and A's held call is released **first**. Expected: B's use still calls `update`
     (the row carries `pending`), with a higher token, and the fake ends on `[a.example]`.
  The test waits on observable state (the fake's call log, the Redis key), no fixed sleeps.

## 10. Rollout

1. **Core, one PR**: SDK (`DeviceFence`, `StaleFenceError`, docs on the four calls), `gen:sdk-api`,
   changeset (`@capybara-hq/plugin-sdk`, `@capybara-hq/kernel`), agent-docs topic, kernel call sites
   and `StaleFenceError` handling, the `pending` intent (§7.2), device-fake, the tests of §9, and the
   writing-device-providers skill (a "Fencing token" paragraph in the lifecycle section; the stale
   line in the network section). Release (rc).
2. **Plugins, one PR**: bump `@capybara-hq/plugin-sdk` (one SDK instance across the repo, pnpm
   override as usual), device-docker (§5.1, §5.2, and §5.3 if open question 1 is answered yes), the
   proxy image, README rows for `update` / `create` / `destroy` and the fencing note, device-e2b
   README residual note, changesets. Release; the proxy image carries the plugin version tag.
3. **Core, pin bump**: `packages/kernel/bootstrap.json` to the new device-docker (and device-e2b for
   its README-only release if it is pinned). Release, upgrade prod.
4. **Existing instances**: proxies of the previous version have `allow.json` without `fence` (if
   ever applied in place) and containers without the `fence` label. The control label of this
   version changes (`dev.capybara.sandbox.egress-control: 2`), so `updateDecision` treats them like
   pre-control instances: an allowlist change answers `"recreate"`, which rebuilds them fenced. Each
   existing instance pays at most one recreate, at its first network change, never at upgrade. No
   migration.

## 11. Open questions for the maintainer

1. **Ship the instance identity check (§5.3) with #748, or as a follow-up?** Recommended: with it, in
   the same plugins PR. Without it a stale `create` that pauses inside the provider can still leave B
   running commands in a wider instance; with it, the stale `create` can at worst cost one rebuild.
   It is local to device-docker (handle shape and one comparison per call).
2. **Drop `ifDigest` once the token exists?** Recommended: yes. The token is strictly stronger (it
   orders holders, the digest only detects a change), and keeping both makes a newer holder's retry
   fail when its own earlier attempt already landed. `status` keeps the digest for the
   acknowledgement check.
3. **A `fencing: true` declaration on the provider?** Recommended: no. The kernel has no different
   behavior to choose; the README states which providers honor it. Revisit if the device page should
   show it.
4. **Previous-version instances: recreate on their first allowlist change (recommended), or keep the
   unfenced swap for widening?** The swap deletes the proxy before creating the new one, so it cannot
   be fenced; keeping it keeps the race open for those instances until they are recreated anyway.
5. **E2B residual: reapply when the installed evidence is wider than the record?** Recommended: yes,
   as a separate kernel issue. The evidence is already read under the exclusive lease on resume and
   create; comparing its network with the record and treating "wider" like `mustApply` closes the
   window at the next lifecycle step for every provider whose `update` cannot be fenced, without a
   provider change.
6. **Fence `destroyFileSystem` too?** Recommended: no for #748 (a stale call there loses files, it
   does not widen anything); file a separate issue if the data-loss case should be fenced as well.

## AGENTS.md rules touched

None changed. Rules this design relies on and how it satisfies them:

- **Multi-replica discipline**: no in-process state, timers or new Redis keys; the token is the PG
  row fence a holder already reads under its exclusive lease, and the provider stores it with its own
  state (the proxy's `allow.json`). "An external call whose effect must match a record writes its
  intent first": `update` now does (`instance_limits.pending`, §7.2). Distributed locks stay
  `LockService` leases; the token covers only a call that outlives its lease (§8).
- **Sandboxes**: "every provider enforces allowlists" now holds against a stale holder for providers
  that can fence (device-docker), and the residual for one that cannot (device-e2b) is documented;
  locking and destruction remain the kernel's (the token is derived and checked, never decided, by the
  provider).
- **Extensions**: extensions see only the SDK; the change is an additive SDK parameter and error
  class, `device-provider@1` unchanged.
- **Public API reports**: `pnpm gen:sdk-api` plus a changeset bumping `@capybara-hq/plugin-sdk`
  (§4.4, §10).
- **Tests**: the dual-replica test lives in the `container` project and joins
  `container-tests.json` in the same change; no fixed sleeps (§9).
- **Before 0.1.0**: no compatibility layer; a provider without a token from the kernel fails closed
  (recreate), and previous-version instances are rebuilt once at their first network change (§10).
