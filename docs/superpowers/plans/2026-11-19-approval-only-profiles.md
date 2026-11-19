# Approval-only profiles: implementation plan (R3)

Status: plan for the trimmed R3 scope the maintainer approved on 2026-11-19. It implements the
[approval-only profiles design](../specs/2026-11-19-approval-only-profiles-design.md), which stays
the authority; this file only orders the work. The target is about two days of agent wall time.

**Base:** R3 starts from `perm/w4-int` after R2 merges to `main`. That base already holds the
per-call escalation (`approverForProfile`, `isFullExecutionScope`, `escalationRefusal`, migration
`0162`) and the macOS abort fix. R3 integrates on a single branch, `perm/r3-int`, cut from that
base. Each task runs in its own worktree from it: `pnpm wt:new <task-branch> --from perm/r3-int`.

**Execution:** the `wave-planned-subagent-development` skill.

- Run four implementers at once, on disjoint files.
- Tasks marked **TB** (trust boundary), **MIG** (migration or stored-key conversion) or **MR**
  (multi-replica race) get a solo review by opus. The other tasks in a wave are reviewed together
  in one batch. Fix rounds continue until APPROVE.

**Test rules:**

- Write the RED test first and confirm it fails for the intended reason.
- Run tests with `--maxWorkers=2`, and run the Docker suites one at a time.
- A task ends green on its own suites, with `pnpm typecheck` and `pnpm check`.

**Wave merge:** the controller merges the wave's tasks into `perm/r3-int` and runs one full verify:
`CAPYBARA_TEST_WORKERS=4 pnpm verify --full`. The whole branch gets a single integrated verification
at the end (W4).

## Interfaces frozen before W1

The tasks in a wave code against these names, so they can run in parallel. The controller commits
them as a stub commit in W0 (types and empty functions only, behind no flag). Each implementer then
fills in only its own part.

- **SDK:**
  - `SandboxNetworkScope` adds `{ kind: "open-public" }`.
  - `SandboxPermissionSupport` becomes v2: `{ version: 2, boundary, restricted, network: {
    openPublic, allowlist, perOperationHosts }, outsideSandbox, background, unavailableReason? }`.
  - `DeviceOwnerCeiling` becomes `{ version, sequence, revision, outsideSandbox, network: "open" |
    "allowlist", allowedDomains, restrictedProjectReach }`.
  - `classifyAddress(ip: string): AddressClass`.
  - `SandboxLimits` loses `mode`.
- **Kernel:**
  - `DeviceSandbox = { boundary, networkMode, networkCeiling, hosts, outsideSandbox,
    restrictedProjectReach, layer: { network, outsideSandbox } }`.
  - `effectiveDeviceSandbox(platform, org, device, provider): DeviceSandbox`.
  - The facts field `outsideSandboxCeiling` replaces `fullAccessCeiling` in
    `PermissionReviewSnapshot`.
  - `PermissionGrantDecision` adds `{ source: "full-access", reviewEventSeq: number, decidedBy:
    null }`.
  - `ReviewRecord.crossing`.
  - `PermissionContext` v2 `sandbox` block.
  - DriftReason `device_sandbox_changed`.
  - The settings reader `readDeviceSandboxSettings(): { outsideSandbox, network: { default,
    ceiling } }`.
- **Migration numbers:** `0163` for T2 (cloud device network columns) and `0164` for T6 (the
  grant source). The controller renumbers both at merge if `main` has already taken these numbers.

## Wave overview

| Wave | Parallel tasks (disjoint files) | Review | Wall time |
|---|---|---|---|
| W0 | Controller: cut `perm/r3-int`, stub commit, baselines | — | 1 h |
| W1 | T1 SDK contract (TB) · T2 kernel settings and config (MIG) · T3 device policy and CLI (TB) · T4 replay context | T1, T2, T3 solo; T4 alone in its batch | 4–5 h |
| W2 | T5 kernel device sandbox and admission (TB+MR) · T6 review, grants and audit (TB+MR+MIG) · T7 macOS open network (TB) · T8 Linux open network and own loopback (TB) | all four solo | 6–7 h |
| W3 | T9 conformance suite (TB) · T10 device view, cloud network and network asks · T11 web UI · T12 dual-replica matrix (MR) + docs | T9, T12 solo; T10 and T11 batched | 4–5 h |
| W4 | Controller: integrated verification, two final solo reviews, dogfood | — | 2–3 h |

The total is about 17–21 hours of wall time, roughly two working days, if each wave's fix rounds
stay within one pass. The cloud providers (plugins repo) follow the R3 SDK release and are outside
this window. Until a provider declares support v2, its cloud devices read `unprobed`, never a
fallback.

## W0: controller

1. Cut `perm/r3-int` from `perm/w4-int` after the R2 merge.
2. Write the stub commit for the frozen interfaces.
3. Record the baselines:
   - zero-drift: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
     packages/kernel/test/evals/run-replay.test.ts --maxWorkers=2`;
   - the device suite;
   - the macOS conformance (`packages/testing/test/device-mac-backend.test.ts`);
   - the Linux conformance (`sandbox-linux-runtime.test.ts` with
     `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`).
4. Note whether R2 shipped device protocol 3. If it did, T1 makes this change protocol 4.

## W1

### T1: SDK contract (TB)

**Owns:**

- `packages/plugin-sdk/src/{sandbox-operation,device-protocol,sandbox,device-denied-paths,
  sandbox-write-denies}.ts`
- the new `network-classes.ts`
- `index.ts`, `api/plugin-sdk.api.md`
- the SDK tests for these
- a changeset

**RED first:**

- The parser rejects `environment` without `device`, and rejects unknown network kinds.
- Each narrowing field can only narrow.
- A `classifyAddress` table test covers v4, v6, v4-mapped, NAT64, CGNAT, ULA, `fd00:ec2::254` and
  the host's own interface placeholder.
- The new write-deny paths (LaunchAgents, LaunchDaemons, systemd user units, autostart, the crontab
  spool) match in every spelling, including the macOS case-fold and `/private` forms.

**Gates:** `pnpm gen:sdk-api && pnpm check:sdk-api && pnpm check:sdk-api-changeset`, then the SDK
tests.

### T2: kernel settings and config (MIG)

**Owns:**

- `packages/kernel/src/config/{schema,load}.ts`
- `sandbox/platform-full-access.ts` → `sandbox/device-sandbox-settings.ts`
- `identity/settings.ts`
- `orgs/settings.service.ts`, and `orgs/cloud-network-setting.ts` → `orgs/device-network-setting.ts`
- `errors.ts`
- `platform/ops/{admin,org-settings,platform}.ops.ts`
- the permission config fingerprint inputs
- the converter for `apps/capybara` `config migrate-permissions`
- migration `0163` (add `devices.network_mode` and `network_hosts`, copy the allowlist outer
  networks) and `db/kernel-schema.ts` (those columns only)
- `docs/config.md` (regenerated)
- the error keys only in `apps/web/messages/{en,zh}.json`
- the tests for all of these

**RED first:**

- The old env, file and Nacos keys are refused with the conversion message.
- A `default` above the `ceiling` is refused.
- The stored-key conversions follow the spec's Migration table and never widen.
- An org PATCH above the platform ceiling returns 400 `org.network_not_allowed`.
- Through the Platform tool or an API token, a PATCH may only narrow.
- Changing a new key changes the fingerprint.
- The migration is idempotent (`IF NOT EXISTS`).

**Gates:**

- `check:config-docs`, `check:platform-ops`, `platform-parity.test.ts`, `check:i18n`
- `test/config/permission-config-*`, `test/orgs/settings`, `test/identity/settings`
- the renamed settings reader test

### T3: device policy and CLI (TB)

**Owns:**

- `packages/device/src/{state,policy,policy-store}.ts`
- `exec/operation-types.ts`
- `commands/{ceiling,policy,login}.ts`, `args.ts`
- their tests

**RED first:**

- A non-escalated `full-access` scope gets scoped roots and the denied read roots. This fails on the
  base, which returns `/`.
- An `open-public` scope against an allowlist ceiling narrows to the allowlist.
- `device` + `environment` without `outsideSandbox` is refused.
- The old `policy.json` conversion follows the table and never widens.
- A kernel narrowing op cannot widen.
- The CLI flags work, and the widening prompt shows the new text.

**Gate:** `pnpm exec vitest run packages/device/test --maxWorkers=2`.

### T4: replay context

**Owns:**

- `packages/kernel/src/conversations/events.ts` (`PermissionContext` v2 and `ReviewRecord.crossing`
  only)
- `runtime/context/permission-profile.ts`
- `runtime/permission-context.service.ts`
- `evals/reconstruct.ts`
- the zero-drift fixtures
- `test/runtime/permission-context*`, `test/evals/{reconstruct,run-replay}`

The producer, `readContextLocked`, belongs to T5. T4 builds and tests the v2 schema, the model text
and the drift rule against fixture contexts.

**RED first:**

- A Full access context with a scoped sandbox parses. This fails on the base refine.
- A change to the sandbox block between runs logs `device_sandbox_changed`.
- A snapshot test covers the model text for each profile, with and without escalation available.

**Gate:** the zero-drift group passes before and after the change.

## W2

### T5: kernel device sandbox and admission (TB+MR)

**Owns:**

- the new `packages/kernel/src/sandbox/device-sandbox.ts`
- `sandbox/{modes,permission-facts,operation-authority,operation-authority-types,
  permission-ceiling-writes,permission-availability,held-operations}.ts`
- `conversations/permission-profiles.service.ts`
- the tests for these under `test/sandbox`, plus `test/conversations/permission-profiles.http.test.ts`

**RED first:**

- A table test of profile × local/cloud × network mode → scope. The Full access row must be scoped,
  which fails on the base.
- The escalated pair appears only with a grant and the ceiling.
- `open → allowlist` revokes open-network work and keeps allowlist siblings.
- Widening `outsideSandbox` or the network ceiling resets Full consent with a
  `permission_profile_changed` event.
- An instance-boundary provider gives a whole-instance scope with no outside and no per-call hosts.
- The context (`readContextLocked`, producing T4's v2) and admission agree on every row of the table.

**Gates:**

- `test/sandbox/{operation-authority,operation-scopes,permission-wiring,modes,
  cloud-permission-snapshot*}`
- `operation-scopes.dual`, `permission-profiles.dual`, `background/permission-lifetime.dual`, run
  sequentially

### T6: review, grants and auto-grant audit (TB+MR+MIG)

**Owns:**

- `packages/kernel/src/tools/pipeline.ts`
- `sandbox/review/{review.service,permission-candidate,classifier}.ts`
- `sandbox/{permission-call-grants,permission-call-types}.ts`
- `tools/approvals.service.ts`
- the audit action registration
- migration `0164` (`full-access` added to the grant `source` check), and `db/kernel-schema.ts`
  (that check only; the T2 columns are already merged)
- `tools/builtins/sandbox/bash.ts` (the description: proxy-aware traffic, the escalation wording)
- the tests: `test/tools/{pipeline,call-policy,permission-policy,permission-escalation,
  permission-approvals.dual}`, `test/sandbox/{review-*,permission-call-grants}`

**RED first:**

- A Full access outside directory produces a grant row, a `permission_reviewed` event and an audit
  row, and admission then includes it. This fails on the base's in-scope skip.
- Under Full access, an escalation produces an auto-grant and its audit row. This replaces the
  merged test "Full access asks nobody: the call already runs outside the sandbox".
- With an always-allow classifier fake, each fixed-deny class still denies.
- A protected-path proposal is `unsupported` before review.
- A sub-agent's escalation under Full access goes to the review model.
- An unattended run is unchanged.
- An escalation without `outsideSandboxCeiling` is refused both at issue and at admission.
- An exact retry returns the same grant.

**Gates:** the files above, then `review.dual` and `permission-approvals.dual`, run sequentially.

### T7: macOS open network (TB)

**Owns:**

- `packages/device/src/exec/{operation-worker,mac-operation-backend,mac-read-policy}.ts`
- `packages/device/test/mac-*.test.ts`
- the fixture knobs only in `packages/testing/test/device-mac-backend.test.ts`

**Interfaces:**

- **SRT configuration for `open-public`:**
  - an allow-all ask callback, so decisions go through the resolved-address guard;
  - `deniedResolvedAddresses` built from the private, CGNAT and ULA classes of `classifyAddress`;
  - `deniedDomains` CIDR rules for IP literals.
- **Execution paths:**
  - The unwrapped full branch runs only for the escalated pair.
  - An escalated call's environment drops `CAPYBARA_*` and the device credential.
  - The restricted environment is used for every profile.

**RED first:**

- A Full-profile scope that reads `~/.ssh` is denied.
- Open mode reaches a public fixture.
- Open mode refuses `10.0.0.1`, `169.254.169.254`, another loopback port, an IP literal and a
  rebinding name.
- The sentinel `AWS_SECRET_ACCESS_KEY` is absent.
- The command reaches its own TCP loopback listener. This needs the separate macOS
  loopback-listening fix. If that fix has not merged yet, the case is `it.fails` naming the
  dependency, and W4 gates on it.

**Gates:** the device suite on macOS, then the macOS conformance run.

### T8: Linux open network and own loopback (TB)

**Owns:**

- `packages/device/src/exec/{linux-agent,linux-operation-worker,linux-operation-backend,
  docker-operations}.ts`
- `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts` (loopback connect only to ports the
  operation itself bound)
- their tests
- a changeset (sdk, device)

T1 does not touch this SDK file.

**Interfaces:**

- **Forwarder `open` mode:**
  - no host match, and any TCP port;
  - the existing resolved-IP `is_global` check stays;
  - the class table is mirrored from the SDK, with a hash test against it.
- **Execution:** `hostBaseEnv(full)` is removed, and escalated calls get the environment described
  in T7.
- **Support report:** the v2 report.

**RED first:**

- The network matrix from T7, run in the hardened Docker harness.
- A connect to the command's own listener passes; a connect to another process's listener fails.
- `docker.sock` is refused.

**Gates:** the Linux conformance with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1` (sequential), then
the device suite.

## W3

### T9: conformance suite (TB)

**Owns:**

- `packages/testing/src/sandbox-permission-conformance.ts`
- `packages/testing/test/{sandbox-linux-runtime,device-mac-backend,device-linux-backend}.test.ts`
- a changeset (testing)

**Changes:**

- The cases "Full access controls … no restricted filters apply" and the UNIX-socket Full control
  become escalated-pair controls.
- A new block, "every profile is sandboxed".
- A new open-network block, with a fixture knob for the public target.
- An environment sentinel case.
- An own-loopback case.
- An instance-boundary fixture profile.

**Gate:** the macOS and Linux conformance both pass against T7 and T8.

### T10: device view, cloud network and network asks

**Owns:**

- `packages/kernel/src/devices/devices.service.ts`, plus the devices schemas and DTO
- `local-devices/{owner-report,policy-summary,device-policy.service,network-grants}.ts`
- `tools/network-asks.ts`
- `platform/ops/devices.ops.ts`
- their tests

**Interfaces:**

- The device view gains `sandbox { network, allowedDomains, outsideSandbox, layer }`.
- **Cloud PATCH** `{ network: { mode, hosts } }`:
  - allowed for the owner or an org admin, within the ceilings;
  - the Platform tool may only narrow.
- **Local narrowing** goes only through the v3 `policy` op.
- **Network asks:** a private-address block under open mode replies with the escalation hint. It
  does not create a network ask.

**RED first:**

- The web or API cannot widen a local ceiling.
- A cloud mode above the org ceiling returns 400 `device.network_not_allowed`.
- Recent changes show a row for each setting change.

**Gates:** `test/devices`, `test/local-devices`, `test/tools/network-ask*`, `check:platform-ops`,
then parity.

### T11: web UI

**Owns:**

- `apps/web/src/components/conversation/PermissionPicker.tsx`
- `components/DeviceModeSection.tsx`, `lib/devices.ts`
- `app/(app)/settings/sandbox/view.tsx`, `lib/org-settings.ts`
- `app/(app)/admin/settings/view.tsx`
- the timeline auto-granted line component
- `messages/{en,zh}.json` (the non-error keys)
- `apps/web/test/**` for these
- `e2e/permission-profiles.spec.ts`

**RED first:**

- The picker and dialog copy match the spec's tables, including both dialog variants.
- The device section shows the network and outside-sandbox groups, and a disabled option names its
  layer (平台 / 超级管理员).
- Project reach is unchanged.
- The auto-granted line renders.

**Gates:** `pnpm check:web-ui`, `check:i18n`, the web unit tests. Visual baselines are rendered only
by the `visual-update` workflow.

### T12: dual-replica matrix and docs (MR)

**Owns:**

- the new `packages/kernel/test/sandbox/approval-only-profiles.dual.test.ts`, added to
  `container-tests.json`
- `AGENTS.md` (the Sandboxes line, with the spec's text)
- `.agents/skills/{writing-sandbox-providers,writing-tools,writing-web-ui,writing-kernel-api,
  replay-evals}/SKILL.md`
- `docs/deploy/upgrade.md`

**Dual cases:**

- A concurrent Full access auto-grant produces one grant and one audit row.
- A ceiling narrowing races an auto-grant.
- `open → allowlist` revokes open-network work while a sibling survives.
- Approve for me → Full access while a card waits: the card is superseded, auto-granted and executed
  once.
- `outsideSandbox` off revokes an escalated background task exactly.

**Gates:** the new dual file, then `pnpm check` (synced skills, terms, agent-docs).

## W4: integrated verification (controller)

1. Extend `test/runtime/permission-activation.test.ts` to cover a local staged device and a fake
   instance-boundary cloud device, with each profile and one crossing each.
2. Run the suites sequentially:
   - the zero-drift group, permission-context and the dual suites;
   - local-devices, background, tools and sandbox;
   - device, SDK and the testing conformance (macOS and Linux);
   - web and Playwright.
3. Hold two solo opus reviews of the final revision:
   - (a) the trust boundary: fixed denies, open network, environment, escalation;
   - (b) lifecycle, revocation and replay.
4. Run the single integrated `CAPYBARA_TEST_WORKERS=4 pnpm verify --full`.
5. Dogfood on the maintainer's Mac:
   - each profile;
   - `pnpm install` over the open network;
   - a LAN request refused with the escalation hint;
   - an escalation under Full access visible in the audit.
