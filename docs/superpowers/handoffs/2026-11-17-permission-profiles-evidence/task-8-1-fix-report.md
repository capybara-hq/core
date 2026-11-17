# Task 8.1 review fixes: report

Checkout: `/Users/grant/Capybara/core/.claude/worktrees/codex-permission-output-transport`, branch
`codex/permission-output-transport`. Base `3001ad382`, fix commit `31dc64cbf`. No push, no PR.
Status: DONE_WITH_CONCERNS (concerns at the end).

Unchanged on purpose: the active wire stays protocol 2 (`DEVICE_PROTOCOL_VERSION` 2; no v3
advertisement, fallback or flag); no exec/provision/readFile fallback; the accepted retained-output
component (8a) is untouched; no new migration; M8 not touched (it stays an 8.6 activation gate).

## I1 reconnect decision

The spec (B5) requires two things. Requests are fenced to their connection. An in-flight **read**
that meets a reconnect fails, and the reader retries from the same offset. The spec says nothing
about exec, backgroundStart and the other operations, so I chose protocol 2's behavior and wrote
it down in code comments (`connectionFenced` in relay.ts, the `serveStagedSession` doc in
staged-session.ts, and the drain comment in local-device-gateway.ts):

- **Requests:** still fenced. A request queued with the old connection's tag is refused on a new
  socket, and the operation is never run. The error text now depends on the operation.
- **Results:**
  - Only `backgroundReadOutput` is fenced. Its answer must carry its request's connection, and a
    poll tick that sees a changed transport fails the read with "retry the read from the same
    offset".
  - Every other staged operation accepts a result that arrives on a later connection of the same
    machine. The tag must be well formed, and the frame is parsed against the capacity of the
    connection it arrived on (the gateway has already checked it against that capacity).
  - The post-result `transport()` re-check is removed. The tag check in `parseRes` is the proof.
- **Device:** new `StagedSessionState` (`createStagedSessionState({graceMs})`) lasts across sockets,
  like v2's `client.ts` connection.
  - A socket close aborts only in-flight output reads. Everything else keeps running.
  - An answer produced while no socket is ready is held for the grace and flushed after the next
    `ready`.
  - A `cancel` reaches an operation whichever socket it arrives on.
- **Gateway:** a `cancel` frame is forwarded even when its tag is from an older connection. It
  carries no payload sized to the connection's capacity, and the kernel's give-up must reach an
  operation that survived a blip.
- **Effect:** a brief reconnect no longer kills a running user command, and no longer turns a
  completed one into OutcomeUnknown.

## Per finding

| Finding | Change | Test (RED on base, GREEN after) |
|---|---|---|
| I1 kernel | relay.ts: `connectionChangedMessage(op)` and `connectionFenced`; the poll-tick fence applies to reads only; the post-result recheck is removed; `parseRes` checks the tag only for reads | managed-output-transport: "a non-read result answered after a reconnect within grace is delivered, not discarded" (RED: `DeviceProtocolError: Connection capacity changed`); "a reconnect changes the exact capacity and fences requests of the old connection" (op-specific text, read vs status); "a reconnect during a pending range ... same offset" (RED: old text) |
| I1 device | staged-session.ts: session state across sockets, close aborts reads only, held answers, cancel on any socket | staged-session: "a socket blip aborts in-flight reads only; other operations finish and answer after reconnect" (RED: `expected true to be false`, i.e. status was aborted on close) |
| I2 | targets.ts: `transport()` returns null when there is no holder. relay.ts: new `connection(deviceId)` checks holderLive first, then maps through `goneError(targetState)` or `deviceOffline()`. callWithCodec and the provider's `readOutput` use it (`targets.transport` dropped from the provider's deps) | "a deleted device yields device.not_found ..." and "a revoked device yields device.forbidden ..." (read and status; RED: plain `Error: Device transport is ...`); "an active device without a connection yields device.offline" (RED) |
| M1 | Fixture spies are now wired: `requested(op,id)` and `cancelled(id)` are recorded by the fake device | "aborting an in-flight read cancels only that request and the task keeps running": aborts after the request was sent (`holdReplies`), checks that a cancel of exactly that request id reached the device, the task still reports `running`, and no other ops ran. A test fix, so it is green on the base too |
| M2 | Oversize test uses valid JSON: a cancel padded with whitespace | 69632 bytes leaves the socket open, 69633 bytes closes it with 4400. Mutation proof: with the device's cap check removed (`maxFrameBytes` undefined), the test fails (times out with no close); the old `" ".repeat` frame would still have closed |
| M3 | Denial test asserts the type | `toBeInstanceOf(SandboxScopeDeniedError)` plus `isSandboxScopeDeniedError` (green on base) |
| M4 | New gateway cases | "closes a staged connection whose device answers before ready" (4400, deterministic: publication held so ready is not sent); "publishes capacity before ready and holds queued requests until ready" (the request stays on the list and the device sees `[]`, then `["ready","req"]`) |
| M5 | Gateway publishes capacity, then sends `ready`. Ping-time publication failures are counted per connection and close only at 3 in a row (the key TTL is three pings); a success resets the count | "publishes capacity before ready ..." (RED: ready already sent while capacity was held); "tolerates one transient capacity publication failure on ping and closes after repeated ones" (RED: the connection closed after one failure). The counter belongs to the socket object; no cross-request in-process state |
| M6 | `DeviceConnection.connectionId = randomUUID()`, separate from the lease token. The transport key value is `{connectionId,maxFrameBytes}`, still keyed by the lease token. Result tags, request fencing and `ready` all use the random id | Asserts that `ready.connectionId` equals `transport().connectionId` and differs from the lease holder value (RED: equal) |
| M7 | Unbound instance gets `res ok:false kind unsupported`; duplicate id gets `res ok:false kind error`; the socket stays open | "answers an unbound instance and a duplicate request id without closing the socket": the original request still gets its own answer afterwards (RED: socket closed, no answer, test times out) |
| M9 | Removed the unused `SandboxOperationAuthority.grantedHosts` (no callers; `this.grants` is still used); replaced the `!` assertion in staged-session.test.ts; also dropped the unused `KernelCancel` import in relay.ts | Biome 0 warnings on touched files |

Also fixed: `packages/kernel/test/sandbox/operation-scopes.dual.test.ts` was already broken at the
base. Its typecheck failed (the mock had no `executionGrants`), and all 7 tests failed (`column
"execution_grants" does not exist`) because its setup applies only 0140 by hand. The mock now has
the field and the setup applies 0142 too. `pnpm typecheck` needed this.

## Commands (from the checkout root)

RED runs on base code (with `targets.transport` kept in the provider fixture, and a two-line shim in
the device for the new `createStagedSessionState` export, so the failures are behavioral, not import
errors):
- `CAPYBARA_TEST_WORKERS=2 pnpm exec vitest run packages/kernel/test/local-devices/managed-output-transport.test.ts --testTimeout=15000`:
  8 failed, 6 passed (14).
- `CAPYBARA_TEST_WORKERS=2 pnpm exec vitest run packages/device/test/staged-session.test.ts --testTimeout=15000`:
  2 failed, 4 passed (6).

GREEN, `CAPYBARA_TEST_WORKERS=2`:

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/plugin-sdk/test/device-protocol-v3.test.ts packages/device/test/staged-session.test.ts packages/device/test/background-output.test.ts packages/device/test/output-spool.test.ts` | 4 files, 130 passed |
| `pnpm exec vitest run packages/kernel/test/local-devices/managed-output-transport.test.ts packages/kernel/test/local-devices/local-device-provider.test.ts packages/kernel/test/sandbox/permission-call-grants.test.ts packages/kernel/test/config/permission-config-activation.test.ts packages/kernel/test/tools/permission-policy.test.ts packages/kernel/test/sandbox/operation-scopes.dual.test.ts` | 6 files, 113 passed (after the dual fix; review set alone was 5 files) |
| `pnpm exec vitest run packages/kernel/test/local-devices` (gateway, relay, dual gateway, ...) | 12 files, 167 passed |
| `pnpm typecheck` | exit 0 |
| `pnpm exec biome check <12 touched files>` | 0 errors, 0 warnings |
| `pnpm check:sdk-api` | passed (no public SDK change; no gen, no new changeset; the existing `managed-output-transport.md` changeset covers kernel/device) |
| `pnpm check` | All checks passed |

## Concerns

1. **Stale requests are refused.** A non-read request that was still queued under the old
   connection when the device reconnected is refused, with "connection changed before <op> was
   sent; retry the operation". The spec's request fence requires this. It is a definite not-sent
   error, but the held-operation path may still label it as unknown. Worth checking when 8.6
   activates the path.
2. **Untested race.** I removed the post-result recheck, but there is no deterministic test for the
   window between the result being stored and the old recheck. The non-read reconnect test covers
   the tag rule that replaces it.
3. **Device grace setting.** The device-side grace for held answers comes from the caller of
   `createStagedSessionState`. The production wiring at 8.6 should pass
   `credential.reconnectGraceSeconds * 1000`.
4. **Base timeouts.** Two RED cases on the base fail by timing out, not by an assertion: the M7
   socket close leaves the answer promise pending.
