# Approval-only profiles: implementation plan (R3)

Status: plan for the trimmed R3 scope the maintainer approved on 2026-11-19. It implements the
[approval-only profiles design](../specs/2026-11-19-approval-only-profiles-design.md), which stays
the authority; this file only orders the work. The target is about two days of agent wall time.

**Base:** R2 merged to `main` (#394) and was released by its version PR (#395, `0.1.0-rc.58`), so
`perm/w4-int` is contained in `main`. `perm/r3-int` was cut from `origin/main` at `5f6c3541a`,
which holds the per-call escalation (`approverForProfile`, `isFullExecutionScope`,
`escalationRefusal`, migration `0162`) and the macOS abort fix. R3 integrates on that single
branch. Each task runs in its own worktree from it: `pnpm wt:new <task-branch> --from perm/r3-int`.

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

**Interim names (W0 correction).** The SDK wire shapes cannot change in place before W1: dozens of
kernel, device, testing and web files own them, most in later waves. The stub commit therefore
adds the new shapes next to the old ones, and step W1.M swaps them:

| W0 stub (file) | Final name after W1.M |
|---|---|
| `SandboxPermissionSupportV2` (`sandbox-operation.ts`) | `SandboxPermissionSupport` |
| `DeviceOwnerCeilingV3` (`device-protocol.ts`) | `DeviceOwnerCeiling` |
| `DeviceOwnerCeilingNarrowingV3` (`device-protocol.ts`) | `DeviceOwnerCeilingNarrowing` |
| `PermissionFullAccessGrantDecision` (`sandbox/permission-call-types.ts`) | a member of `PermissionGrantDecision` (T6, with migration `0166`) |
| `parseSandboxPermissionSupportV2` (`device-protocol.ts`, T1) | `parseSandboxPermissionSupport` |
| `parseOwnerCeilingReportV3` (`device-protocol.ts`, T1) | `parseOwnerCeilingReport` (replaces the protocol 3 one) |
| `parseOwnerCeilingNarrowingV3` (`device-protocol.ts`, T1) | `parseOwnerCeilingNarrowing` |

Already final in W0: `{ kind: "open-public" }` in `SandboxNetworkScope` (the parser still refuses
it until T1), `SandboxBoundary`, `DeviceNetworkMode`, `network-classes.ts` (`AddressClass`,
`OPEN_PUBLIC_DENIED_CLASSES`, `classifyAddress`, which throws until T1), the kernel's
`sandbox/device-sandbox.ts` (`DeviceSandbox`, its four layer inputs, `DeviceSandboxSettings`,
`effectiveDeviceSandbox`, which throws until T5), `PermissionCrossingKind`, `approverForCrossing`
(`review/permission-candidate.ts`, throws until T6), `ReviewRecord.crossing`,
`PermissionContextSandboxSchema` (`events.ts`) and the DriftReason `device_sandbox_changed` with
its web labels.

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
- **Migration numbers:** `0165` for T2 (cloud device network columns), `0166` for T6 (the grant
  source) and `0167` for the backfill repeat. W0 planned `0163` and `0164`, but `main` shipped its
  own `0163_read_attachments` and `0164_platform_icons` (rc.60 to rc.62), so the W4 merge of
  `origin/main` renumbered the three R3 migrations after them, in order.

## Wave overview

| Wave | Parallel tasks (disjoint files) | Review | Wall time |
|---|---|---|---|
| W0 | Controller: cut `perm/r3-int`, stub commit, baselines | — | 1 h |
| W1 | T1 SDK contract (TB) · T2 kernel settings and config (MIG) · T3 device policy and CLI (TB) · T4 replay context | T1, T2, T3 solo; T4 alone in its batch | 4–5 h |
| W1.M | Controller: protocol 4 cutover and the facts rename, after the W1 merge | solo | 1–2 h |
| W2 | T5 kernel device sandbox and admission (TB+MR) · T6 review, grants and audit (TB+MR+MIG) · T7 macOS open network (TB) · T8 Linux open network and own loopback (TB) | all four solo | 6–7 h |
| W3 | T9 conformance suite (TB) · T10 device view, cloud network and network asks · T11 web UI · T12 dual-replica matrix (MR) + docs · T13 cloud providers, plugins repo (TB) | T9, T12, T13 solo; T10 and T11 batched | 5–6 h |
| W4 | Controller: integrated verification, two final solo reviews, dogfood | — | 2–3 h |
| W5 | Controller: release R3 in order (SDK/kernel rc, providers, bootstrap pins), cloud smoke | — | 3–4 h |

The total is about 21–26 hours of wall time, roughly two and a half working days, if each wave's
fix rounds stay within one pass. W3 runs five tasks; T13 lives in the plugins repo, so it shares no
files with the core tasks, and four core implementers plus one plugins implementer stay within the
concurrency limit only if T10 and T11 start after T9's first pass (otherwise add half a day). The
release in W5 includes the providers: a released kernel paired with the released providers never
leaves a cloud device `unprobed`.

## W0: controller

1. Cut `perm/r3-int` from `origin/main` (R2 merged, `perm/w4-int` contained) and merge the design
   branch (docs only).
2. Write the stub commit for the frozen interfaces (interim names above).
3. Record the baselines:
   - zero-drift: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
     packages/kernel/test/evals/run-replay.test.ts --maxWorkers=2`;
   - the device suite;
   - the macOS conformance (`packages/testing/test/device-mac-backend.test.ts`);
   - the Linux conformance (`sandbox-linux-runtime.test.ts` with
     `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`).
4. Note whether R2 shipped device protocol 3. Checked: it did (`DEVICE_PROTOCOL_VERSION = 3`,
   released in `0.1.0-rc.58`), so this change is protocol 4, cut over in W1.M.

## W1

### T1: SDK contract (TB)

**Owns:**

- `packages/plugin-sdk/src/{sandbox-operation,device-protocol,sandbox,device-denied-paths,
  sandbox-write-denies}.ts`
- the new `network-classes.ts`
- `index.ts`, `api/plugin-sdk.api.md`
- the SDK tests for these
- a changeset

T1 implements and strictly parses the interim shapes (`SandboxPermissionSupportV2`,
`DeviceOwnerCeilingV3`, `DeviceOwnerCeilingNarrowingV3`) as new exported parsers next to the old
ones. It does not change the old shapes, the hello parser or `DEVICE_PROTOCOL_VERSION`: W1.M does.

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
- `sandbox/platform-full-access.ts` → `sandbox/device-sandbox-settings.ts`, and
  `sandbox/permission-config-publication.ts` (`convertStoredPermissionKeys` and the permission
  config fingerprint live there)
- `identity/settings.ts`
- `orgs/settings.service.ts`, and `orgs/cloud-network-setting.ts` → `orgs/device-network-setting.ts`
- `errors.ts` (the org and deployment codes; `device.full_access_not_allowed` is thrown in
  `devices/devices.service.ts`, so T10 renames it)
- `platform/ops/{admin,org-settings,platform}.ops.ts`
- the permission config fingerprint inputs
- the converter for `apps/capybara` `config migrate-permissions`
  (`apps/capybara/src/commands/config.ts`, `apps/capybara/test/config-migrate.test.ts`)
- migration `0165` (add `devices.network_mode` and `network_hosts`, copy the allowlist outer
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
- the renamed settings reader test (`test/sandbox/platform-full-access.test.ts` →
  `device-sandbox-settings.test.ts`)

### T3: device policy and CLI (TB)

**Owns:**

- `packages/device/src/{state,policy,policy-store,owner-report}.ts`
- `exec/operation-types.ts`
- the `policy` op's owner-ceiling narrowing in `server-ops.ts`
- `commands/{ceiling,policy,login}.ts`, `args.ts`
- their tests (`operation-ceilings`, `owner-ceiling`, `policy`, `state`, `server-ops`, `args`,
  `login`)

T3 moves the device's own ceiling model to `DeviceOwnerCeilingV3`. Until W1.M the wire stays
protocol 3: one temporary mapping in `owner-report.ts` reports the old shape, and W1.M removes it.

**RED first:**

- A non-escalated `full-access` scope gets scoped roots and the denied read roots. This fails on the
  base, which returns `/`.
- An `open-public` scope against an allowlist ceiling narrows to the allowlist.
- `device` + `environment` without `outsideSandbox` is refused.
- The old `policy.json` conversion follows the table and never widens.
- A kernel narrowing op cannot widen.
- The CLI flags work, and the widening prompt shows the new text.

**Gate:** `pnpm exec vitest run packages/device/test --maxWorkers=2`.

**Note for T5 and T10 (from the T3 review, ruling 2).** On a local device the owner's `network:
"allowlist"` is a ceiling: the device keeps a per-call host grant only where the owner's
`allowedDomains` cover it (`effectiveEgress`); under the owner's `open` network grants stay bounded
by the kernel only. The kernel therefore reports a host crossing beyond the owner's list on a local
device as unavailable, naming the fix: "the device owner adds it on the machine: capybara-device
policy add allowedDomains <host>".

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

## W1.M: protocol 4 cutover (controller, after the W1 merge)

One mechanical commit on `perm/r3-int`, behaviour kept wherever a later task owns the semantics:

- Rename the interim SDK shapes to their final names and delete the old ones; switch the hello,
  owner report and narrowing parsers to T1's new parsers; `DEVICE_PROTOCOL_VERSION = 4` and
  `LEGACY_DEVICE_PROTOCOL_VERSION = 3`; `pnpm gen:sdk-api`.
- Update every consumer by a mapping that keeps today's behaviour: kernel `local-devices/*`,
  `sandbox/permission-availability.ts` and the other support readers, the device exec workers'
  support report (`boundary: "operation"`, `outsideSandbox` = the old `fullAccess`), the testing
  conformance and fixtures, the kernel fake machines, and the `apps/web/src/lib/devices.ts` type.
  Remove T3's temporary wire mapping.
- Under protocol 4 the device's `policy` op refuses `add` for local devices ("widening happens only
  on the machine"; T3 keeps it only while the wire is protocol 3, see the comment in
  `packages/device/src/server-ops.ts`), with a RED test that a protocol 4 `add` is refused and
  writes nothing. An approval's "always allow" for a host becomes a per-call grant instead of a
  `policy` op `add`.
- Rename the facts field `fullAccessCeiling` → `outsideSandboxCeiling` (kernel sources, the
  conversation permission view, tests, `apps/web`), so T5 and T6 share it in W2.
- Gate: `CAPYBARA_TEST_WORKERS=4 pnpm verify --full`. Review: solo (protocol, TB).

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

**Checklist (from the T2 review):**

- Narrowing revocation lives here: a platform or org network ceiling narrowed to `allowlist`
  (`network-allowlist`) revokes open-network work. T2's ceiling writers bump the epoch and reset
  Full consent on a widening, but revoke no open-network work (`revoke: false` for network-only
  changes in `identity/settings.ts`, `orgs/settings.service.ts` and the publication).
- When this task stops reading `owner_full_access` / `outer_network`, repeat 0165's backfill in
  the same change (a new migration): every cloud device snapshotted after 0165 whose
  `outer_network` is an allowlist and whose `network_mode` is NULL gets `network_mode: allowlist`
  and its hosts as `network_hosts` when they are an array of strings, else `[]`.
- A device-level host list (a local owner's `allowedDomains`, a cloud device's `network_hosts`)
  intersects the org/platform effective hosts and never adds one; an empty list adds no narrowing.

**Gates:**

- `test/sandbox/{operation-authority,operation-scopes,permission-wiring,modes,
  cloud-permission-snapshot*}`
- `operation-scopes.dual`, `permission-profiles.dual`, `background/permission-lifetime.dual`, run
  sequentially

**Notes from T5 for W2/W3 (security review rulings).**

- T6: grant issuance and the candidate builder use the snapshot's `hostCeiling` / `hostRefusal`
  (`device-sandbox.ts` `hostGrantCeiling`, `hostGrantRefusal`): the org's network ceiling is a hard
  ceiling for per-call hosts under every profile (Full access does not auto-grant beyond it and
  nothing beyond it is proposed), and the reply names who adds the host. Full consent is the view's
  `consentHolds` (a narrowing keeps it), so the auto-grant reads `fullConsent` from the view.
  Host proposals under an open-public sandbox network are already skipped there (m8).
- T10 and T13: the cloud network PATCH revokes with `needsOpenNetwork` and resets consent only on a
  widening; a person who saves an empty allowlist means "follow the org" (`allowlist` with `[]`),
  a closed network is `network_mode: none`; providers report `boundary: "instance"` (m7).

### T6: review, grants and auto-grant audit (TB+MR+MIG)

**Owns:**

- `packages/kernel/src/tools/pipeline.ts`
- `sandbox/review/{review.service,permission-candidate,classifier}.ts`
- `sandbox/{permission-call-grants,permission-call-types}.ts`
- `tools/approvals.service.ts`
- the audit action registration, with its label in `apps/web/src/lib/audit-actions.ts` and the
  `admin.audit.actions` keys in `apps/web/messages/{en,zh}.json` (`audit-actions.test.ts` requires
  every kernel audit literal there)
- migration `0166` (`full-access` added to the grant `source` check), and `db/kernel-schema.ts`
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
  - `deniedResolvedAddresses` built from the private, CGNAT and ULA classes of `classifyAddress`
    (`OPEN_PUBLIC_DENIED_CIDRS` is the whole closed set as CIDRs, embedded forms expanded);
  - `deniedDomains` CIDR rules for IP literals.
- **Execution paths:**
  - The unwrapped full branch runs only for the escalated pair.
  - An escalated call's environment drops `CAPYBARA_*`. The device credential file stays readable
    to it (it runs as the owner outside the sandbox; inherent, see the spec).
  - The restricted environment is used for every profile.
- **Protected locations:** at operation start the worker resolves the protected home locations
  (`~/Library`, `~/.config`, `~/.local/share` and the secret paths) and adds each resolved target
  that differs (a dotfile manager's symbolic link) as an absolute deny, and the write rules gain
  `SANDBOX_SYSTEM_WRITE_DENIES` (SDK `sandbox-write-denies.ts`).

**RED first:**

- A Full-profile scope that reads `~/.ssh` is denied.
- Open mode reaches a public fixture.
- Open mode refuses `10.0.0.1`, `169.254.169.254`, another loopback port, an IP literal and a
  rebinding name.
- The sentinel `AWS_SECRET_ACCESS_KEY` is absent.
- Any listen is refused under every profile (`allowLocalBinding: false` stays: Seatbelt cannot
  limit a bind to loopback, verified on 0.0.81). No own-listener case on macOS; a dev server uses the
  per-call escalation (spec "Known limitations").

**Gates:** the device suite on macOS, then the macOS conformance run.

### T8: Linux open network and own loopback (TB)

**Owns:**

- `packages/device/src/exec/{linux-agent,linux-operation-worker,linux-operation-backend,
  docker-operations}.ts`
- `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts` (no loopback connect beyond the
  granted endpoints, `SO_REUSEPORT` refused; ruling 2026-11-19 after the security review)
- their tests
- a changeset (sdk, device)

T1 does not touch this SDK file.

**Interfaces:**

- **Forwarder `open` mode:**
  - no host match, and any TCP port;
  - the existing resolved-IP `is_global` check stays;
  - the class table is mirrored from the SDK, with a hash test against it.
- **Protected locations:** at operation start the worker resolves the protected home locations and
  adds each resolved target that differs (a symbolic link) as an absolute deny, as in T7. The
  broker passes the moved directory's entries, listed from the source descriptor, as
  `move_denied(…, entries)` instead of letting the policy list the source path, re-checks the
  destination after a directory rename, and refuses a `symlink` whose new name ends in a proper
  prefix of a multi-component deny (`move_denied` already refuses renaming a link there).
- **Execution:** `hostBaseEnv(full)` is removed, and escalated calls get the environment described
  in T7.
- **Support report:** the v2 report.

**RED first:**

- The network matrix from T7, run in the hardened Docker harness.
- A connect to any loopback listener fails, the command's own included (ruling 2026-11-19: no
  own-listener connect on either platform); a client outside the sandbox reaches the command's
  listener; the review's probes (`shutdown` + foreign `SO_REUSEADDR` + re-listen, and
  `SO_REUSEPORT`) reach no foreign listener.
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
- An own-loopback case, Linux fixtures only; the macOS fixture keeps `restrictedLoopbackListen:
  "refused"`.
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

### T13: cloud providers (plugins repo, TB)

**Repo:** `/Users/grant/Capybara/plugins`, its own worktree and branch. It develops against the W1
SDK and testing changes (T1, T9's instance-boundary fixture) through a local pack for iteration
only; the PR that merges installs the published R3 rc (no file, link or workspace substitution).
The single plugin-sdk instance rule applies (pnpm override).

**Owns:** `plugins/sandbox-docker/src/**`, `plugins/sandbox-e2b/src/**`, their tests and changesets.

**Interfaces:**

- `permissionSupport` v2: `{ version: 2, boundary: "instance", restricted: null, network: {
  openPublic: true, allowlist: true, perOperationHosts: false }, outsideSandbox: false, background:
  true }`.
- `operation()` over the existing exec and file methods, with the durable `(instanceGeneration,
  operationId)` consume record, `revokeOperation`, and `background` per the operation contract.
- No `mode` in the lifecycle limits; the outer network is the sandbox network (Docker egress proxy
  with the closed ranges, E2B `denyOut` plus the recorded metadata caveat).

**RED first:** the testing conformance's instance-boundary profile fails on the current providers
(no factory); a duplicate operation ID never repeats effects; a revoked operation never starts; one
background task stops while its sibling survives.

**Gates:** the conformance on Docker (sequential), and on a live E2B template with the credential
file loaded only inside the test command, never printed; the VM is recorded and deleted.

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
5. Run a cloud device on the T13 provider branches (Docker locally, E2B live) with each profile.
6. Dogfood on the maintainer's Mac:
   - each profile;
   - `pnpm install` over the open network;
   - a LAN request refused with the escalation hint;
   - an escalation under Full access visible in the audit.
   - a dev server on macOS started through an escalation.

## W5: release (controller)

R3 is done only after all of these, in order:

1. Merge `perm/r3-int` to `main` and publish the rc of `@capybara-hq/plugin-sdk`,
   `@capybara-hq/testing`, `@capybara-hq/kernel` and `@capybara-hq/device` (the version PR).
2. In the plugins repo, bump `sandbox-docker` and `sandbox-e2b` to the published SDK and testing rc,
   rerun their conformance (Docker, live E2B) against the published packages, merge T13 and release
   the providers (and the Docker image).
3. In core, pin the released providers in `packages/kernel/bootstrap.json` and the compose files
   (`check:bootstrap`), then release the kernel rc and the images that carry the pins.
4. Smoke: a fresh deployment from the released images creates a Docker cloud device that reads
   `supported` and runs one call under each profile.

Between steps 1 and 3 no image is announced: the kernel rc from step 1 is not deployed on its own
with cloud devices, because its pins still name the old providers.
