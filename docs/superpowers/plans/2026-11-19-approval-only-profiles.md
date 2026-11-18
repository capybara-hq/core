# Approval-only profiles: implementation plan

Status: plan, not yet reviewed. Implements
[approval-only profiles](../specs/2026-11-19-approval-only-profiles-design.md) (the spec). The spec is
the authority; this file orders the work. Binding: `perm/w4-int` at `0ce1ab054`. Execution follows
the `wave-planned-subagent-development` skill: waves of tasks with disjoint files, at most three
implementers at once, batched review per wave. Tasks marked **TB** (trust boundary), **MIG**
(migration or stored-key conversion) or **MR** (multi-replica race) are reviewed alone on the most
capable model; fix rounds continue until APPROVE.

Standing rules: each task runs in its own worktree from the integration branch
(`pnpm wt:new <branch> --from perm/w4-int`); write the RED test first and confirm it fails for the
intended reason; run with `CAPYBARA_TEST_WORKERS=2` and `--maxWorkers=2`, Docker suites one at a time;
the controller merges, runs `pnpm typecheck`, `pnpm check`, `pnpm test:unit` and the task's suites,
and records the result in the ledger. Questions 1–3 of the spec must be answered before W2 starts
(question 1 shapes T4, T12; question 2 shapes T11; question 3 shapes T5, T6, T7).

## Dependencies on in-flight branches

| Branch | What it brings | Needed by |
|---|---|---|
| `perm/call-escalation` (uncommitted in `.claude/worktrees/perm-escalate`) | Bash `sandbox: "escalated"` + `justification`, scope kind `sandbox-escalation`, migration `0162`, `approverForProfile`, `escalationRefusal` for unattended runs | W0 merge; T7 builds on it (renames its `fullAccessCeiling` checks to `outsideSandboxCeiling`, extends `approverForProfile` to every crossing kind) |
| macOS abort fix (on `perm/w4-int`, HEAD `0ce1ab054`) | Aborted restricted command ends with escaped descendants | Already in the base; T5 keeps its tests green |
| macOS restricted loopback listening (in progress separately) | `allowLocalBinding` for restricted macOS operations | T5's own-listener case; if not merged by W2, T5 records the macOS case as `it.fails` with the dependency and T15 gates on it |
| Phase 8.6 activation (W4 task O on `perm/w4-int`) | Protocol 3 live, gate on | T1 decides "edit protocol 3 in place" vs "protocol 4" from whether a release published protocol 3 |

## Wave overview

| Wave | Tasks (parallel, disjoint files) | Gate to close |
|---|---|---|
| W0 | controller: merge dependencies, baselines | zero-drift + unit green |
| W1 | T1 SDK contract (TB); T2 kernel settings and config rename (MIG) | SDK API report, config docs, parity |
| W2 | T3 device policy (TB); T4 kernel device sandbox and admission (TB+MR); T5 macOS open network (TB); T6 Linux open network and own loopback (TB) | four solo reviews |
| W3 | T7 review, grants, auto-grant audit (TB+MR+MIG); T8 replay context; T9 conformance suite (TB); T10 network asks and device view/policy wiring | T7 solo; T8–T10 batched |
| W4 | T11 web UI; T12 cloud providers (plugins repo, TB); T13 docs, skills, AGENTS.md | web checks, plugin conformance |
| W5 | T14 dual-replica matrix (MR); T15 integrated verification and e2e | two final solo reviews |

## W0 — controller

1. Commit and merge `perm/call-escalation` into `perm/w4-int` once its own review passes; merge the
   macOS loopback fix if ready.
2. Record baselines: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts
   packages/kernel/test/evals/run-replay.test.ts --maxWorkers=2`, the device suite and the macOS and
   Linux conformance runs (`packages/testing/test/device-mac-backend.test.ts`,
   `sandbox-linux-runtime.test.ts` with `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1`).
3. Reserve the migration number after `0162` for T7 and the one after it for T2.

## W1

### T1 — SDK contract (TB)

- Files: `packages/plugin-sdk/src/{sandbox-operation,device-protocol,sandbox,device-denied-paths,
  sandbox-write-denies}.ts`, new `network-classes.ts`, `index.ts`, `api/plugin-sdk.api.md`,
  `packages/plugin-sdk/test/**` for these, changeset.
- Interfaces: `SandboxNetworkScope` with `open-public` and `privateEndpoints`; `SandboxOperationScope
  .escalated`; parser rule "`environment` only with `device` and `escalated: true`";
  `SandboxPermissionSupport` v2 (`boundary`, `network`, `outsideSandbox`); `SandboxLimits.mode`
  removed; `DeviceOwnerCeiling { revision, sequence, outsideSandbox, network, privateNetwork,
  allowedDomains, projectReach }` and its narrowing; `classifyAddress(ip): "public" | "private" |
  "loopback" | "link-local" | "metadata" | "multicast" | "reserved"` with the CIDR table; write denies
  add LaunchAgents/LaunchDaemons, systemd user units, autostart, crontab spool.
- RED first: parser rejects `environment` without escalation and `open-public` with hosts; each
  narrowing field can only narrow; `classifyAddress` table (v4, v6, mapped v4, NAT64, `fd00:ec2::254`);
  new write-deny paths matched in every spelling.
- Gates: `pnpm gen:sdk-api && pnpm check:sdk-api && pnpm check:sdk-api-changeset`; SDK tests.

### T2 — kernel settings and config rename (MIG)

- Files: `packages/kernel/src/config/{schema,load}.ts`, `sandbox/platform-full-access.ts` →
  `sandbox/device-sandbox-settings.ts`, `identity/settings.ts`, `orgs/settings.service.ts`,
  `orgs/cloud-network-setting.ts` → `orgs/device-network-setting.ts`, `errors.ts` (renamed and new
  codes), `platform/ops/{admin,org-settings,platform}.ops.ts`, the permission config fingerprint
  inputs, `apps/capybara` `config migrate-permissions` converter, `docs/config.md` (regenerated),
  `apps/web/messages/{en,zh}.json` error keys only, their tests.
- Interfaces: `devices.outsideSandbox`, `devices.network.{default,ceiling}`, `devices.privateNetwork`
  (hot, published under the permission authority); org `outsideSandbox`, `deviceNetwork`,
  `privateNetwork`; `readDeviceSandboxSettings()`; `convertStoredPermissionKeys` gains the spec's
  conversions; errors `*.outside_sandbox_not_allowed`, `*.network_not_allowed`.
- RED first: old env/file/Nacos keys refused with the conversion message; `default` above `ceiling`
  refused; stored `devicesFullAccess`, org `fullAccess`, `cloudNetwork` convert without widening
  (`cloudNetwork.mode: allowlist` → `ceiling: allowlist`); org PATCH above the platform ceiling →
  400; a Platform-tool/API-token PATCH may only narrow; fingerprint changes when a new key changes.
- Gates: `check:config-docs`, `check:platform-ops`, `platform-parity.test.ts`, `check:i18n`,
  `test/config/permission-config-*`, `test/orgs/settings`, `test/identity/settings`,
  `test/sandbox/platform-full-access` (renamed).

## W2

### T3 — device policy and intersection (TB)

- Files: `packages/device/src/{state,policy,policy-store}.ts`, `exec/operation-types.ts`,
  `commands/{ceiling,policy,login}.ts` (`ceiling` becomes `sandbox`), `args.ts`, their tests.
- Interfaces: `OwnerCeilingPolicy { outsideSandbox, projectReach, network, privateNetwork }`;
  `DEFAULT_POLICY` open defaults; one-time strict conversion of an old `policy.json`;
  `intersectOperation` returns scoped roots minus protected paths for every non-escalated scope,
  `open-public` or allowlist hosts, private endpoints only when `privateNetwork`, and `device` only
  for `escalated` with `outsideSandbox`; `effectiveEgress` replaced by `effectiveSandboxNetwork`.
- RED first: a non-escalated `full-access` scope gets scoped roots and denied paths (fails on base,
  which returns `/`); `open-public` scope on an allowlist ceiling narrows to allowlist; an escalated
  scope without `outsideSandbox` refused; old policy conversion table (spec "Migration"); widening
  through a kernel narrowing op refused; the CLI widening prompt text.
- Gates: `pnpm exec vitest run packages/device/test --maxWorkers=2`.

### T4 — kernel device sandbox and admission (TB+MR)

- Files: new `packages/kernel/src/sandbox/device-sandbox.ts`, `sandbox/{modes,permission-facts,
  operation-authority,operation-authority-types,permission-ceiling-writes,permission-availability}.ts`,
  `conversations/permission-profiles.service.ts` (consent check rename), tests under `test/sandbox`
  for these and `test/conversations/permission-profiles.http.test.ts`.
- Interfaces: `effectiveDeviceSandbox(platform, org, device, provider): DeviceSandbox`;
  facts `outsideSandboxCeiling`, `projectReach`, `sandbox`; `intersectPermissionScope(snapshot,
  grant)` with no profile branch; `scopeRevision` over crossing ceilings; ceiling narrowing kinds and
  their revoke predicates; Full consent reset on any widening; support v2 in `withheldScope`.
- RED first: table test profile × local/cloud × network mode → scope (Full profile is scoped: fails
  on base); escalated scope only with grant and ceiling; network `open → allowlist` revokes open
  work and keeps allowlist siblings; widening `outsideSandbox` resets Full consent with a
  `permission_profile_changed` event; an instance-boundary provider yields whole-instance scope and
  no outside; admission and context agree (extend the B-16 table).
- Gates: `test/sandbox/{operation-authority,operation-scopes,permission-wiring,modes,
  cloud-permission-snapshot*}`, `operation-scopes.dual`, `permission-profiles.dual`,
  `background/permission-lifetime.dual` (sequential).

### T5 — macOS open network (TB)

- Files: `packages/device/src/exec/{operation-worker,mac-operation-backend,mac-read-policy}.ts`,
  `packages/device/test/mac-*.test.ts`, `packages/testing/test/device-mac-backend.test.ts` fixture
  knobs only.
- Interfaces: SRT config for `open-public`: allow-all through an ask callback returning true only
  after the resolved-address guard, `deniedResolvedAddresses` from `classifyAddress` private/CGNAT/ULA
  classes, explicit `deniedDomains` CIDR rules for IP literals, private endpoints re-allowed exactly;
  the worker's unwrapped Full branch (`:271-276`) runs only for `escalated`; escalated env strips
  `CAPYBARA_*` and the device credential; restricted env unchanged for every profile.
- RED first: Full-profile scope reads `~/.ssh` → denied (fails on base); open mode reaches a public
  fixture and refuses `10.0.0.1`, `169.254.169.254`, a loopback port, an IP literal and a rebinding
  name; `AWS_SECRET_ACCESS_KEY` absent; own loopback listener (after the loopback fix).
- Gates: device suite on macOS; mac conformance run.

### T6 — Linux open network and own loopback (TB)

- Files: `packages/device/src/exec/{linux-agent,linux-operation-worker,linux-operation-backend,
  docker-operations}.ts`, `packages/plugin-sdk/src/sandbox-linux-runtime-source.ts` (loopback
  connect to the operation's own bound ports only), their tests, changeset (sdk, device).
- Interfaces: Forwarder `open` mode (no host match, any TCP port, existing `is_global` resolved-IP
  check kept, `classifyAddress` table mirrored and hash-checked against the SDK); private endpoints
  admitted exactly; `hostBaseEnv(full)` gone (escalated env as T5); support v2 report.
- RED first: same network matrix as T5 in the hardened Docker harness; connect to the operation's
  own listener passes, to another process's listener fails; `docker.sock` refused.
- Gates: `CAPYBARA_TEST_REQUIRE_LINUX_RESTRICTED=1` Linux conformance (sequential), device suite.

## W3

### T7 — review, grants and auto-grant audit (TB+MR+MIG; solo, strongest model)

- Files: `packages/kernel/src/tools/pipeline.ts` (`reviewPermissionCall`, `networkBlocked`),
  `sandbox/review/{review.service,permission-candidate,classifier}.ts`,
  `sandbox/{permission-call-grants,permission-call-types}.ts`, `tools/approvals.service.ts`,
  `audit` action registration, the migration (grant source `full-access`, `private_endpoints`),
  `db/kernel-schema.ts`, `conversations/events.ts` (`ReviewRecord.crossing` only), tests
  `test/tools/{pipeline,call-policy,permission-policy,permission-escalation,permission-approvals.dual}`,
  `test/sandbox/{review-*,permission-call-grants}`.
- Interfaces: `approverForProfile` for every crossing kind; candidate building for Full access;
  `private-endpoint` proposals; `PermissionGrantDecision` adds `{ source: "full-access",
  reviewEventSeq }`; `issueLocked` re-checks the crossing's ceiling and refuses unattended,
  sub-agent escalation and non-owner calls; audit `permission.crossing_auto_granted { kind }`.
- RED first: Full-profile outside directory → grant row + `permission_reviewed` + audit row, then
  scoped admission including it (fails on base: in-scope skip); always-allow classifier fake cannot
  cross each fixed-deny class; a protected-path proposal is `unsupported` before review; sub-agent
  escalation refused; unattended unchanged; escalation without `outsideSandboxCeiling` refused at
  issue and at admission; exact retry returns the same grant.
- Gates: the files above, `review.dual`, `permission-approvals.dual` (sequential).

### T8 — replay context

- Files: `packages/kernel/src/conversations/events.ts` (`PermissionContext` v2, other event shapes
  untouched), `runtime/permission-context.service.ts`, `runtime/context/permission-profile.ts`,
  `evals/reconstruct.ts` (`device_sandbox_changed`), `sandbox/managed-device-context.ts` reader side,
  fixtures and `test/runtime/permission-context*`, `test/evals/{reconstruct,run-replay}`.
- RED first: Full profile records a scoped sandbox (schema refine fails on base); settings change
  between runs logs `device_sandbox_changed`; model text per profile snapshot.
- Gates: zero-drift group before and after (baseline from W0), `.agents/skills/replay-evals` note
  goes to T13.

### T9 — conformance suite (TB)

- Files: `packages/testing/src/sandbox-permission-conformance.ts`, its callers
  `packages/testing/test/{sandbox-linux-runtime,device-mac-backend,device-linux-backend}.test.ts`,
  changeset (testing).
- Changes: the "Full access controls" cases (`:1020-1060`, `:1003`) become escalated-call controls;
  new block "every profile is sandboxed" (Full-profile scope denied the sibling secret); new open
  network block (spec risk table) with a fixture knob for the public target; env sentinel case;
  own-loopback case.
- Gates: mac and Linux conformance pass against T5/T6 (run after they merge).

### T10 — network asks and device view/policy wiring

- Files: `packages/kernel/src/tools/network-asks.ts`, `local-devices/{network-grants,owner-report,
  policy-summary,device-policy.service}.ts`, `devices/devices.service.ts` (view, cloud network PATCH,
  `MODE_CHANGE_ACTIONS`), devices schemas/DTO, `platform/ops/devices.ops.ts`, their tests.
- Interfaces: post-exec block under open mode plans a `private-endpoint` crossing; device view
  `sandbox { network, allowedDomains, privateNetwork, outsideSandbox, projectReach, layer }`; cloud
  PATCH `{ network: { mode, hosts } }` (owner or org admin, within ceilings; Platform tool narrow-only);
  local narrowing via the v3 `policy` op only.
- RED first: web/API cannot widen a local ceiling; cloud mode above the org ceiling → 400
  `device.network_not_allowed`; recent-changes rows for each setting.
- Gates: `test/devices`, `test/local-devices`, `test/tools/network-ask*`, `check:platform-ops`,
  parity.

## W4

### T11 — web UI

- Files: `apps/web/src/components/conversation/PermissionPicker.tsx`,
  `components/DeviceModeSection.tsx` → `DeviceSandboxSection.tsx`, `app/(app)/devices/[id]/view.tsx`,
  `lib/devices.ts`, `app/(app)/settings/sandbox/view.tsx`, `lib/org-settings.ts`,
  `app/(app)/admin/settings/view.tsx`, `components/{ApprovalCard,PermissionScopeDetail}.tsx`,
  `components/conversation/NetworkFacts.tsx`, `app/(app)/inbox/view.tsx` (scope display),
  `messages/{en,zh}.json`, `apps/web/test/**` for these, `e2e/permission-profiles.spec.ts`.
- RED first: picker copy (spec table) and dialog variants; device section per layer state; disabled
  options name the layer (平台 / 超级管理员); auto-granted timeline line.
- Gates: `pnpm check:web-ui`, `check:i18n`, web unit tests; visual baselines only through the
  `visual-update` workflow.

### T12 — cloud providers (plugins repo, TB; solo)

- Repo `capybara-hq/plugins`, after the SDK/testing release with T1 and T9. `sandbox-docker`,
  `sandbox-e2b`: `permissionSupport` v2 `boundary: "instance"`, `operation()` over the existing
  exec/files with durable `(generation, operationId)` consume, `revokeOperation`, background per the
  operation contract; no `mode` in limits. Single plugin-sdk instance rule (pnpm override).
- Gates: the conformance suite's instance-boundary profile on Docker and on a live E2B template
  (credential file never printed; VM recorded and deleted).

### T13 — docs, skills and AGENTS.md

- Files: `AGENTS.md` (Sandboxes line, spec text), `.agents/skills/{writing-sandbox-providers,
  writing-tools,writing-web-ui,writing-kernel-api,replay-evals}/SKILL.md`, `docs/deploy/upgrade.md`,
  `docs/config.md` (already regenerated by T2; prose links only).
- Gates: `pnpm check` (synced skills, terms, agent-docs).

## W5

### T14 — dual-replica matrix (MR; solo)

- File: new `packages/kernel/test/sandbox/approval-only-profiles.dual.test.ts`, added to
  `container-tests.json`.
- Cases: concurrent Full auto-grant (one grant, one audit row); narrowing racing auto-grant;
  `open → allowlist` revocation with surviving sibling; Approve for me → Full with a waiting card
  (superseded, auto-granted, executed once); `outsideSandbox` off revoking an escalated background
  task exactly.

### T15 — integrated verification

1. `test/runtime/permission-activation.test.ts` extended: local staged device and fake instance-
   boundary cloud device, each profile, one crossing each.
2. Sequential suites: zero-drift group, permission-context, dual, local-devices, background, tools,
   sandbox, device, SDK, testing conformance (mac, Linux), web, Playwright.
3. Two solo reviews: (a) trust boundary (fixed denies, open network, env, escalation); (b) lifecycle,
   revocation and replay.
4. `CAPYBARA_TEST_WORKERS=2 pnpm verify` on the integration branch; dogfood on the maintainer's Mac:
   each profile, a `pnpm install` with the open network, a LAN request asking under Request approval.

## Effort

About 13–16 implementer-days plus review: W1 2 days, W2 4–5 (T5/T6 dominate), W3 4, W4 3 (T12 in
parallel in the plugins repo), W5 1–2. With three implementers in parallel, roughly 6–8 working days
of wall time, assuming the three questions are answered in W0 and the loopback fix lands by W2.
