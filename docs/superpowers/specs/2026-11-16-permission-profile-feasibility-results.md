# Permission profile feasibility results

Historical snapshot of the bounded feasibility phase. Subsequent independent SDK/native API work
is described in the [operation contract](2026-11-16-permission-operation-contract.md); it does not
close the provider/runtime acceptance gate recorded here.

Status: bounded investigation complete on 2026-11-16; feasibility gate **open**. The complete
permission-profile contract is **unverified for local, Docker and E2B**. Product implementation
has not started. No architecture impossibility was demonstrated and no architecture change was
selected. The approved shared-device direction, Approve for me default and neutral profile
styling remain unchanged.

This report records the evidence for the [approved design](2026-11-16-conversation-approval-profiles-design.md)
and [feasibility plan](../plans/2026-11-16-permission-profile-feasibility.md).
A passing primitive or collector test does not establish complete provider integration.

## Scope and provenance

Core source: `b3e5d76f202d52f141c0157cb2f0ac45fa7d1009`.
Plugins source: `85aaf6598bee6f27ed9da9836084e2295eb29e03`.
All Full operations used synthetic fixtures and controlled endpoints. Production source, SDK,
protocol, database, local policy and running development services were unchanged; no packages
were installed or images built. No shared policy was temporarily widened for another operation.

The exact scratch root, also reachable under `/private/var`, is:

```text
/var/folders/wf/81pnttjn3cg19x5yl4kh11kr0000gn/T/capybara-permission-spike-6kyrictt
```

Authoritative runs (all evidence paths are relative to the scratch root):

| Provider | Result directory under `results/` | Complete gate |
|---|---|---|
| Local macOS | `local-1794772322359-619addbf` | Unverified; 7/8 experimental scenarios pass |
| Docker | `docker-1794772803823-7fb316a3` | Unverified; partial runtime primitives only |
| E2B | `e2b-1794771865655-01e540d9` | Unverified; no remote runtime exercised |

Each directory contains `evidence.json` and referenced observations. Local observations include
actual commands, output, overlap handshakes and endpoint receipts. Docker additionally retains
`commands.jsonl`, `resource-ledger.json` and `review-fix-verification.json`; runtime details
are in observations and earlier `runtime-version.json`. E2B retains `availability.json`, `commands.txt`,
`source-context.txt` and `cleanup-verification.json`.

## Local: current integration versus primitive experiment

The actual current `OsExecutor`, `HostExecutor` and `SwitchingExecutor` were imported read-only.
Restricted outside-workspace cwd and native read/write/stat/list/scan were rejected. A native
write following an Auto command inherited the latest Auto decision and wrote a synthetic sibling.
This reproduces the shared last-decision limitation; it is neither a TTL-expiry test nor a
verified cross-conversation attack. Source anchors: `packages/device/src/exec/os.ts:293,572`,
`exec/switch.ts:113,127,153`, `exec/groups.ts:54,91`, `exec/procs.ts:9`.

The actual macOS runtime was Node 24.15.0 and `@anthropic-ai/sandbox-runtime` 0.0.81, pnpm patch
`dd5677831ef583606748a7cade5d9d839335e2e7d2ac5aaf8d04a07ca09ef095`.
Platform/dependency checks succeeded. `wrapWithSandbox` with per-call `customConfig` enforced
filesystem roots without `updateConfig`. The installed declarations and `sandbox-manager.js`
(`:526,545,1851,1924`) distinguish shared network policy from per-command lists.

| Experimental scenario | Observed result |
|---|---|
| Outside-project usability | Package read, inline Python/Node and project edit passed |
| Filesystem boundaries | Sibling write and synthetic-secret read denied; Full controls succeeded |
| Symlink/native boundaries | Command symlink accesses denied; native operation-local integration missing |
| Controlled network | Deny-default route passed endpoint receipt and direct-socket checks |
| Concurrent isolation | Both launch orders used readiness/release barriers; restricted denials held while Full lived |
| Targeted cancellation | Registered foreground, descendant and detached groups ended; other tag/service survived |
| Shared-device continuity | Same worker, shared edit, executable and fixture service survived profile changes |
| Grant lifetime | Skills preparation succeeded; next restricted skills/file/network attempts remained denied |

Python produced expected output despite an xcrun cache-write denial outside approved roots.
The customConfig-only network route failed: a denied request reached the controlled endpoint.
A separately initialized fixed deny-default proxy plus `registerCommandNetworkLists` worked in
these cases; grants were unregistered after commands and Full did not widen that proxy. Runtime
resets separated experiments; no active operation crossed a reset.

Command network IDs are documented as **attribution, not an isolation boundary**: presenting
another live ID obtains its allowance. Adversarial discovery/replay was not tested. This route
therefore needs an authority proof before it can support independent operation permissions.
Known-group cancellation is proven only for the explicitly registered fixture groups. Production
`findMarked`/`killMarked` rediscovery was not run because its broad `ps -E` scan reads unrelated
process environments. Arbitrary detached rediscovery and Linux enforcement remain unverified.

The local independent review approved the bounded report with one deferred minor harness issue:
network noninheritance is recorded (next command got 403, no receipt), but omitted from the
`grant-lifetime` pass predicate. The frozen observation supports this report; add that assertion
before reusing the harness. Missing native scope is not proof that a native helper is impossible.

## Docker: unchanged hardening, limited Landlock result

Docker 29.9.3 ran Linux 7.0.14-linuxkit/aarch64 with runc 1.5.2 and libseccomp 2.5.4.
The existing image `capybara-sandbox:test-82c864d46308` had content ID
`sha256:925a4344806e07e7d39f39abc6976f40da4cbc8760e6950d4fdfd9322ca68e4d`;
its registry digest list was empty. The exact current test-context image
`capybara-sandbox:test-4525da5bc912` was absent. Importing the current provider separately failed
because installed SDK 0.1.0-rc.19 lacked `DEVICE_SCAN_SKIPPED_BASE_DIRS`.

The adapter consequently used Docker CLI to reproduce security-relevant provider configuration,
with matching executable Dockerfile instructions, not exact build-context identity. This is
real Linux enforcement evidence, **not loaded-provider, socket-proxy governance or stream/tag
protocol proof**. Source anchors in plugins: `sandbox-docker/src/provider.ts:1135,1197,1289,1319`,
`src/listing.ts:1`, `test/docker-env.ts:49`, `image/Dockerfile:35`.

One unchanged execution container used read-only rootfs, cap-drop ALL, no-new-privileges,
Docker's default seccomp, UID 1000 commands, fixed `NetworkMode=none`, two named volumes and
a bounded writable `/tmp`. No extra execution container, restart or proxy replacement occurred.
The final ID was `e59ff806d00e95725cdc891e5beea930c219f88faf2717c77af37d1e23922865`;
before/after start timestamps both read `2026-11-15T20:00:04.065203922Z`.

The same-UID baseline allowed forbidden synthetic sibling/secret accesses. Nested user/mount/
network namespace attempts returned `EPERM`, including the diagnostic zero-capability root
attempt. That namespace route is unsupported under the unchanged outer boundary.
Landlock nevertheless allowed project work while denying tested sibling writes, secret reads
and symlink escapes; a fork inherited restrictions. File `stat` metadata remained visible.
This is a limited positive filesystem primitive, not a complete native-file contract.

Landlock's tested TCP rule restricted ports. A connection to a second address at the permitted
port succeeded; a domain/address allowlist is not established. Healthy loopback listeners and
Full controls supplied receipts. `NetworkMode=none` remained fixed and no external reachability
claim follows. Proxy authorization, DNS rebinding, UDP, inherited sockets and a trusted
operation-specific network broker remain unverified.

Only outside-project usability passed as a complete collector scenario; filesystem failure
records the baseline. Native provider paths, both overlap orders, tagged/detached cancellation,
whole-profile continuity and grant lifetime remain unverified. The Landlock observations do not
upgrade these missing scenarios. The earlier namespace-only `unsupported` aggregate is superseded
by the final `unverified` result, not interpreted as universal shared-container impossibility.

## E2B: availability result only

The process environment had neither test variable. The documented test-only env file had a
nonempty test API key and no configured existing test template; only presence booleans were
retained. Key validity was not checked. No API request, template build, VM creation or VM-wide
network change occurred. All eight runtime scenarios remain unverified. An existing template may
still exist in the account; the missing configuration does not establish otherwise.

Source inspection found whole-VM `updateNetwork`, shared `SANDBOX_USER` execution/file paths
and workspace-based list/scan (`sandbox-e2b/src/provider.ts:909,969,1081–1202`,
`src/e2b-api.ts:98,107` in plugins). The documented MMDS residual at `169.254.169.254` is
recorded from `sandbox-e2b/README.md:167`, not retested or claimed blocked. The existing live suite
can auto-build a template, create another VM and change global egress; it was not run.
The scratch adapter records availability only, even if configuration later becomes available.

## Verification, cleanup and evidence integrity

Fresh synthesis verification: `node --test` in the scratch root passed **31 tests**, zero failed
or skipped (22 collector tests, 9 Docker failure-accounting tests). These test evidence handling,
not provider enforcement. All 14 retained provider evidence files were structurally revalidated
and referenced files checked without rerunning providers. All three authoritative results had
zero validation errors, complete cleanup and no cleanup failures.

One historical local result (`local-1794771942324-1545cc00`) still correctly fails validation
because its duplicate proxy-port ledger entry stayed pending. The later exact-resource audit
found all 178 recorded observations across seven local runs absent/terminated, including that
port and an intentional endpoint-ready abort. The final local worker, command groups, listeners,
proxy ports and exact fixture/temp directories were removed. Abort coverage is bounded, not
proof against every possible interruption point.

Docker cleanup now persists ownership intent before create and reconciles lost replies by exact
name and label. Fault tests cover abort/log failures, ownership mismatch and uncertain creation;
uncertain absence is never reported as complete. The final container and both named volumes have
exact-ID/name absence receipts; contained processes/listeners disappeared with their container.
E2B created zero remote resources; only its exact host fixture was created and verified removed.
No remote deletion proof is claimed; earlier negative evidence remains intact.

`results/SHA256SUMS` records 84 scratch source/evidence files. Its SHA-256 is
`39f353b07cec8cd42d08836149e90493fdcd1db4a509a21dbf25efd8a70e2c8e`.
Authoritative `evidence.json` SHA-256 values, in table order above:

```text
local   fef5f3270bf158cecc64cd81f16f6a8b06425d706b7dc5f1d173c51a6d65a34e
docker  3578d8b577ac3ac1c36a9efc0c5dabd03d7d972b07631a28998d84ef6b980d2a
e2b     863b911fb45fbbcdbc29adf3bd48e1224e782875a3f58faf66fb807d0616c5c4
```

Minimal reproduction, using the scratch root above as `SPIKE_ROOT`:

```sh
(cd "$SPIKE_ROOT" && node --test && shasum -a 256 -c results/SHA256SUMS)
node "$SPIKE_ROOT/probe.mjs" local
node "$SPIKE_ROOT/probe.mjs" docker
node "$SPIKE_ROOT/probe.mjs" e2b
```

The provider commands create fresh disposable fixtures; synthesis ran only tests/validation.
Raw commands and responses stay in scratch. This retained summary contains no credentials,
bearer tokens, user file contents or raw service configuration. Scratch executables are not
committed; if temporary evidence disappears, missing proof must be rerun rather than inferred.
Parallel provider workers wrote disjoint evidence files followed by a single synthesis; an
incorrect reconciliation would require evidence review/rework, not a product policy change.

## Remaining decision gates

Preserve the approved shared-device direction and obtain these bounded proofs before a full
product implementation plan: native per-operation scope and trusted-grant separation; enforceable
network authority beyond attribution IDs; safe arbitrary-detached cancellation; Docker operation
network/native/concurrency integration under unchanged hardening and the actual provider; Linux
runtime coverage; and E2B execution in one existing configured test template with full cleanup.
Then revise and review the operation-context/capability design without assuming an SDK signature.

If a remaining required boundary proves infeasible, return concrete options to the maintainer:
explicitly change the single-instance architecture, restrict supported profiles/devices, or defer
the feature. Separate Docker containers imply lifecycle/shared-service tradeoffs; copied-file E2B
VMs do not preserve this shared-device contract. None is selected by this investigation. Both
cloud providers must pass before feature completion; missing E2B access keeps that gate open.
