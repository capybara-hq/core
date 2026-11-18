# Task 8.1 scoped re-review of fix commit 31dc64cbf (read-only)

Checkout: .claude/worktrees/codex-permission-output-transport, diff 3001ad382..31dc64cbf.

## Verdict: APPROVE

I1, I2, M1-M7 and M9 are resolved and each new test would fail without its fix. I found no Critical or Important regressions. Three Minor notes, none blocking.

## Per-finding status

| Id | Status | Evidence | Test meaningful? |
|---|---|---|---|
| I1 | Resolved | relay.ts:80 `connectionFenced` limits the fence to `backgroundReadOutput`; the poll-tick re-check is gated on `fenced` (relay.ts:~304). The post-result re-check is removed (relay.ts:356). The message is op-specific (`connectionChangedMessage`). parseRes still checks the result's tag for a read and validates the tag shape for the rest. Device: staged-session.ts:35 aborts only reads on close; other ops keep running and their answers are held (`pending`, :91) and delivered on the next ready socket. | Yes. "non-read result answered after a reconnect within grace" fails on the old code (discarded). The device blip test checks that only the read aborts, and that the held result arrives once on connection 2. A cancel sent on the new socket reaches the old op. |
| I2 | Resolved | relay.connection() (relay.ts:183) checks liveness first; transport() returns null when there is no holder (targets.ts); callV3 and the provider (local-device-provider.ts:257) use it. | Yes. A deleted device gives device.not_found and a revoked one device.forbidden, for reads and status. An active device with no connection gives device.offline. |
| M1 | Resolved | The abort test now aborts in flight (`holdReplies`), then asserts the cancel frame carries exactly that request id and the task keeps running. The `requested` and `cancelled` spies are wired. | Yes. |
| M2 | Resolved | A valid padded cancel frame: 69632 bytes passes, 69633 bytes closes with 4400. | Yes. It isolates capacity from JSON parsing. |
| M3 | Resolved | `SandboxScopeDeniedError` and `isSandboxScopeDeniedError` are asserted. | Yes. |
| M4 | Resolved | Tests: a `res` before ready closes the socket with 4400; queued requests are held until ready (frames == ["ready","req"]). | Yes. |
| M5 | Resolved | Capacity is published before `ready` is sent (gateway:412, state re-checked). Ping failures are tolerated: warn, counter, close at 3 (MAX_PUBLISH_FAILURES, :70/:564-570). | Yes. Tests: transport readable while not ready, and one failure tolerated then close with 1011 after repeated ones. |
| M6 | Resolved | gateway:158 `connectionId = randomUUID()`, separate from the lease token. Test: connectionId != lease holder. | Yes. |
| M7 | Resolved | staged-session.ts:129/137 answer `unsupported` (unbound) and `error` (duplicate id) and keep the socket open. | Yes. The original request still gets its own answer. |
| M8 | Not fixed, as agreed | Still an 8.6 gate. | n/a |
| M9 | Resolved | `grantedHosts` removed (operation-authority.ts). The non-null assertion is replaced. | n/a |

## Regression review

- **Device StagedSessionState (staged-session.ts:14-30).**
  - Default graceMs is 0, so nothing is buffered unless the caller opts in. `serveStagedSession` has no production caller, so this is dormant.
  - Delivered exactly once: an entry is deleted before delivery, expired entries are dropped, and a cancel deletes the pending entry.
  - Entries are bounded by the number of completed ops, each at most the negotiated frame cap, and removed on delivery. Memory is bounded in practice but not capped. See Minor N1.
  - Same machine and credential is a property of the caller sharing one `state` per program. The module is dormant and the type is not exported from the package entry. See Minor N2.
  - Cancel routing: the gateway forwards cancel unfenced, but only from the per-device request list, and ids are random UUIDs. A cancel for an unknown id is a no-op on the device. It cannot reach another org's or device's ops.
  - A read whose result would arrive late is aborted on close. If a stale read answer were somehow held, the kernel fences it by connectionId, so it is refused.
- **Kernel relay.**
  - A non-read result is attributed by the random request id, and the tag only has to be well-formed. It is parsed against the capacity of the connection it arrived on.
  - A forged or stale tag cannot redirect a result, because only the matching request waiter reads that Redis key.
  - There is no new in-process cross-request state. The gateway counter is per-connection, in-process, and bounded: one integer reset on success.
- **Wire and scope.** DEVICE_PROTOCOL_VERSION is still 2, there is no v3 advertisement in connect(), no exec/provision/readFile fallback, and no migration was added (diff touches none). Retained-output component 8a is untouched.
- **operation-scopes.dual.test.ts.** Legitimate. The test builds its schema by hand, so it must apply 0142 and pass `executionGrants: null` to match the production admission signature. It passes (7/7).

## New findings

Minor only.

- **N1.** staged-session.ts:91 and :112. `pending` entries expire only when the next socket becomes ready, with no sweep. A device that never reconnects keeps up to (completed ops × frame cap) in memory until process exit. Fix: sweep on insert, or cap the entry count. Fix before 8.6 activates it.
- **N2.** `StagedSessionState` is exported from the dormant seam with no binding to a credential. At activation, create one per credential or machine identity, and discard it on credential change. Record this as an 8.6 gate with M8.
- **N3.** Three consecutive ping failures can close the connection just as the key (TTL max(lease, 3 pings)) expires. Harmless, since it causes a reconnect.

## Commands

| Command | Result |
|---|---|
| `CAPYBARA_TEST_WORKERS=2 pnpm exec vitest run packages/kernel/test/local-devices packages/device/test` | 45 files, 740 passed, 1 skipped, 0 failed |
| `pnpm exec vitest run packages/kernel/test/sandbox/operation-scopes.dual.test.ts` | 1 file, 7 passed |
| `pnpm typecheck` | exit 0 |
| `biome check` on the touched dirs | 2 warnings (`any` in an existing test helper), 0 errors |
