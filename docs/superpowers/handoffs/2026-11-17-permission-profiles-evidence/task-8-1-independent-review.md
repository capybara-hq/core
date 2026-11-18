# Task 8.1 independent source review: managed-output transport and dormant adapters

Reviewer: independent source reviewer (read-only). Date: 2026-11-16.
Checkout: `/Users/grant/Capybara/core/.claude/worktrees/codex-permission-output-transport`, branch
`codex/permission-output-transport`, HEAD `3001ad382`. Scope: the new-code delta
(`task-8-1-new-code.patch.gz`, 28 files; all 28 sha256 values in `task-8-1-new-code-manifest.json`
match HEAD bytes), plus its integration with the accepted 8a retained-output component.
The author's report was not used as evidence.

## Verdict: CHANGES_REQUIRED

The core of the task is correct: the strict `backgroundReadOutput` codec, the B5 capacity
negotiation (min(device, deployment), ready before data, 69632 -> 3072), the read-only provider
path with no exec/provision/readFile fallback, the B3 provenance join, and migration 0142. Two
Important issues in the staged relay (both in files this task owns, both cheap to fix) must be
resolved before the dormant adapter is called complete: they change typed error semantics
(R27) and turn completed or briefly interrupted executions into outcome-unknown once 8.6 turns the
path on.

## Findings

### Critical

None.

### Important

**I1. A staged connection fence discards authentic results and kills executions across a socket blip;
the read-specific error text is applied to every op.**
- `packages/kernel/src/local-devices/relay.ts:324-332` (re-check after the result arrived),
  `:270-283` (poll tick), `:212-218`, `:476`; `packages/device/src/staged-session.ts:92-95`.
- Scenario: a staged `exec` (or `backgroundStart`, `writeFile`) finishes and its `res`, tagged with
  the matching `connectionId`/`maxFrameBytes`, is stored. Before the relay's post-result
  `targets.transport()` re-check runs, the device reconnects (Wi-Fi blip, takeover). The relay
  throws `DeviceProtocolError("Connection capacity changed; retry from the same offset")` and drops a
  result already proven authentic by the tag check in `parseRes`. The held-operation path
  (`sandbox.service.ts` ~1363) records the intent as unknown and raises
  `SandboxOperationOutcomeUnknownError` for a command that actually completed. For a command still
  running, the tick settles the error at once, and the device session aborts every running
  controller on `close` (`staged-session.ts:92-95`), killing the user's command. Protocol 2 keeps
  such commands alive and delivers results after a reconnect within grace (`client.ts` handleReq /
  pending; the relay comment "a reconnect within that grace restores the full wait" still claims
  this). The model is also told to "retry from the same offset" for ops that have no offset.
- The spec (B5) does require requests to be fenced to the connection, so refusing to send an old
  request on a new socket is correct. Re-checking after an authentic result arrived adds no safety,
  and the effect on non-read operations was never decided or tested.
- Fix: (a) drop the post-result `transport()` re-check (the `parseRes` tag equality already proves
  the answering connection and capacity), or limit it to `backgroundReadOutput`; (b) make the
  message op-specific (offset wording only for `backgroundReadOutput`); (c) record an explicit
  decision for exec/backgroundStart across a reconnect (keep the v2 grace semantics or accept
  abort-on-close), and add a test that pins the chosen behavior.

**I2. Staged relay/provider check transport before liveness, so deleted or revoked devices lose
their typed errors.**
- `packages/kernel/src/local-devices/relay.ts:212` (before the `holderLive`/`goneError` check at
  :219), `packages/kernel/src/local-devices/targets.ts:38-52`,
  `packages/kernel/src/local-devices/local-device-provider.ts:259`.
- Scenario: a device is deleted or its machine revoked, so there is no lease holder.
  `targets.transport()` throws a plain `Error("Device transport is offline; reconnect and retry the
  same offset")` before `callWithCodec` reaches `goneError(targetState)`. Every staged op (exec,
  backgroundStart/Status/Stop, readOutput) returns that generic error instead of `device.not_found`
  or `device.forbidden` (ruling R27, documented on `relay.call`). A reader such as TaskOutput is
  told to reconnect and retry, and keeps retrying a device that will never come back.
- Fix: run the `holderLive` / `goneError(targetState)` / `deviceOffline()` check first and resolve
  transport only after a holder exists. Alternatively, have `transport()` return null when there is
  no holder and let the relay map it. In the provider's `readOutput`, map "no holder" through the
  same path. Add a test where a deleted device yields `device.not_found` from `readOutput`.

### Minor

**M1. The kernel-side abort test proves nothing.**
`packages/kernel/test/local-devices/managed-output-transport.test.ts:316-325` aborts the signal
*before* the call, so `readOutput` throws at `throwIfAborted()` and no request, cancel frame or give-up
is ever exercised. The `cancelled` and `launched` spies in that fixture are never wired to anything,
so `expect(f.cancelled).not.toHaveBeenCalled()` holds trivially (lines 285, 326, 334, 348). The
device-side test covers in-flight cancel and deadline properly. Fix: use `holdReplies()` to abort
mid-flight, then assert that a connection-tagged cancel frame reached the fake device and that the
task stays running.

**M2. The device oversize test does not tell capacity apart from JSON parsing.**
`packages/device/test/staged-session.test.ts:268` sends `" ".repeat(69633)`, which is also invalid
JSON, so close code 4400 happens even with no size check. Fix: send a *valid* JSON frame of 69633
bytes (for example a `cancel` with a padded id) and also show that a 69632-byte valid frame passes.

**M3. The generation-mismatch test accepts any error.**
`managed-output-transport.test.ts:295-302` uses a bare `.rejects.toThrow()`. Assert
`SandboxScopeDeniedError` (`isSandboxScopeDeniedError`) so denied stays distinct from lost, expired
and unknown at the kernel boundary, as the brief requires.

**M4. Kernel gateway has no test for data before ready.**
No test covers a device `res` before `ready` (`local-device-gateway.ts` onFrame `!this.ready` close),
or `drainOnce` holding queued requests until ready. Add one case for each.

**M5. `ready` is sent before capacity is published.**
`local-device-gateway.ts:397-399` sends `ready` and only then writes the transport key, so a
concurrent provider read sees a spurious "not ready" error. Publish first, then send `ready`.
Separately, a transient Redis failure in the ping-time `publishCapacity` closes the connection
(`:536`); a warning plus a retry on the next ping would be gentler (the key TTL is three pings).

**M6. The lease token doubles as `connectionId` and is sent to the device.**
`local-device-gateway.ts:391` (and `:306`, `:318`) makes the `LockService` holder value visible to the
device. The device has no Redis access, so this is low risk, but a separate random `connectionId`
stored next to the cap would keep the lease fencing value internal.

**M7. The device session tears down the whole socket for per-request problems.**
`staged-session.ts:54-56` closes with 4400 for a request on an unbound instance, or a duplicate id.
The kernel's pending requests then fail by reconnect or fence instead of getting a typed answer.
Fix: answer `res ok:false` with kind `unsupported` (unbound) or `error` (duplicate id), and keep the
socket open.

**M8. Lifecycle frames from protocol 2 are refused by a staged connection (8.6 activation hazard).**
`relay.send("stop", …)` (revocation) and `killAll`/`killTagged` (`local-device-provider.ts:418-423`)
still push untagged protocol-2 frames. A staged gateway's `drainOnce` refuses those as a "capacity
change". This is harmless while dormant, but it should be listed as an explicit 8.6 gate so revocation
`stop` does not silently stop reaching v3 devices.

**M9. Housekeeping.**
`SandboxOperationAuthority.grantedHosts` (`operation-authority.ts:144`) is now dead code. Biome reports
a forbidden non-null assertion in the new test (`staged-session.test.ts:201`). Also, when a per-call
expansion and a run/task envelope combine, all hosts are labeled with the `run` source (this was the
behavior before the change too; it affects only the device audit line).

## What I verified (no finding)

- **SDK codec** (`device-protocol-v3.ts`):
  - The request takes exactly `ref`, `offset` and `maxBytes`. Unknown keys (`path`, `scope`, `grants`,
    `actor`) are rejected; `offset` must be a safe integer of 0 or more, and `maxBytes` an integer in
    0..65536.
  - The result is `dataB64`/`offset`/`nextOffset`/`totalBytes` or exactly `{unavailable:lost|expired}`.
    The base64 length cap (87384) runs before the regex, and canonical padding is enforced by the
    regex plus the `btoa(atob())` round trip.
  - The decoded length must equal `min(sent maxBytes, max(total-offset, 0))`, with offset equality,
    `nextOffset == offset + len`, and safe-integer overflow guarded. Past-end reads are empty with the
    offset unchanged.
  - Validation uses the *sent* (clamped) budget on the provider, relay and device sides.
- **Capacity**:
  - `maxReadBytes(69632) = 3072`, `66560 -> 768`, `65536 -> 0`.
  - The effective cap is `min(hello.transport, deployment)`. The hello, ready and request sizes are
    checked on both ends, and inbound frames are parsed against the cap.
  - The device refuses requests before `ready`, a second `ready`, and a `ready` above its own
    advertisement.
  - The gateway refuses a `res` before ready and does not drain until ready.
  - A runtime decrease of the deployment cap closes the transport on the next frame, drain or ping.
  - The transport key has a TTL, is scoped to the lease token, and is read with a double holder
    check, so it is fenced across replicas. No in-process state outlives a connection.
- **Read path**:
  - The provider sends no caller path, actor, scope or grant.
  - It makes no call to `orgOf`, `devicePolicy`, `forExec`, exec, provision or readFile; the kernel
    test's `forbidden` spies and the device test's `operation/prepare/browse` spies confirm this.
  - A zero-capacity probe stays a zero probe, and data that cannot fit with zero capacity fails with
    an actionable error rather than a false EOF.
  - A device-side cancel or deadline aborts only the read, and the task keeps running (device test).
- **Activation stays off**:
  - `DEVICE_PROTOCOL_VERSION` is still 2.
  - `acceptStaged` and `serveStagedSession` have no production callers; `serveStagedSession` is only
    re-exported from `client.ts`, which is not the package entry.
  - There is no v3 advertisement in `connect()`, no fallback and no new flag.
- **B3**:
  - Admission records `execution_grants` (version 1, parsed and bounded) inside the admit lock and
    folds it into `admission_hash`.
  - The pending→admitted re-resolve compares it.
  - `forExecution` requires the exact method, scope hash, input digest, admission hash and
    granted_hosts, plus the per-call grant source, and returns the *recorded* grants on consumed
    retries.
  - A null legacy provenance fails closed: `forbidden` when admitted, `OutcomeUnknown` once
    dispatched.
  - Current org limits are still applied live (`grantsWithin` refuses a narrowed host).
  - The exec input digest joins end to end through the real held path
    (`permission-policy.test.ts`, "explicit operation hosts …").
  - Revocation writers (`settings.service`, `permission-config-publication`, `policy-summary`) now
    treat `backgroundStart` like `exec`.
- **Migration 0142**:
  - It is additive (`ADD COLUMN IF NOT EXISTS`) and widens the method check via
    `DROP CONSTRAINT IF EXISTS` + `ADD`. The auto-generated name
    `sandbox_operation_intents_method_check` matches the inline check in 0140.
  - It is idempotent and not destructive under the skill's rules.
  - The new check restricts `execution_grants` to exec/backgroundStart objects; the test exercises it.

## Commands run (from the 8.1 checkout root, `CAPYBARA_TEST_WORKERS=2`)

| Command | Result |
|---|---|
| `pnpm exec vitest run packages/plugin-sdk/test/device-protocol-v3.test.ts packages/device/test/staged-session.test.ts packages/device/test/background-output.test.ts packages/device/test/output-spool.test.ts` | 4 files, 128 tests passed |
| `pnpm exec vitest run packages/kernel/test/local-devices/managed-output-transport.test.ts packages/kernel/test/local-devices/local-device-provider.test.ts packages/kernel/test/sandbox/permission-call-grants.test.ts packages/kernel/test/config/permission-config-activation.test.ts packages/kernel/test/tools/permission-policy.test.ts` | 5 files, 97 tests passed |
| `pnpm exec tsc -b packages/kernel packages/device packages/plugin-sdk` | exit 0 |
| `pnpm check:sdk-api` | passed |
| `pnpm check:sdk-api-changeset --base 3b27b4637` | passed |
| `pnpm check:applied-migrations --base 3b27b4637` | passed |
| `pnpm check:migrations`, `check:deps`, `check:kernel-conventions`, `check:test-portfolio`, `check:extension-state` | all passed |
| `pnpm exec biome check <28 changed ts/json files>` | 0 errors, 4 warnings, 1 info (one warning is in a new test, M9) |
| Manifest sha256 check of the 28 new-code files against HEAD | 28/28 match |

Not run, by instruction: the full suite, the dev stack, credentials, and Linux confinement proof.
