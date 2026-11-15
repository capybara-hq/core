# Permission profile feasibility implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish whether local, Docker and E2B can enforce independent operation permissions
inside one shared device, before committing to the product implementation.

**Architecture:** Run a throwaway probe against disposable fixtures, using actual execution
boundaries rather than mocked policy decisions. Keep all executable spike artifacts outside the
repositories; retain a sanitized evidence report and the resulting design decisions in core.
An unsupported or unverified result is a valid finding, never permission to weaken enforcement.

**Tech stack:** Node.js 24, node:test, the installed sandbox-runtime 0.0.81, Docker and the existing
provider test infrastructure; real E2B only with configured test credentials and an existing template.

**Spec:** `docs/superpowers/specs/2026-11-16-conversation-approval-profiles-design.md`

## Execution status (2026-11-16)

The bounded available investigation is complete; the feature and feasibility gate remain open.
See the [results report](../specs/2026-11-16-permission-profile-feasibility-results.md).
Checked items mean the stated investigation/evidence handling was performed, not that a provider
passed the gate. All aggregate profiles remain unverified. Provider workers wrote disjoint scratch
results, followed by one documentation synthesis; no production implementation was added.

## Global constraints

- The default is Approve for me; all three options use identical neutral text/icon colors.
- The implementation must preserve one shared device environment unless a later design explicitly
  changes that repository-wide architectural rule.
- Do not change shared instance policy to temporarily elevate one conversation, and do not weaken
  an outer container's seccomp/capabilities to make a demonstration pass.
- Use disposable data and an isolated test instance, not the connected user's running project or
  services.
- Record an unavailable environment as unverified, not supported.
- Keep production source, SDK, device protocol, database and the running dev stack unchanged.
- Restrict all Full access probes to explicit synthetic fixtures; do not inspect real credentials.
- This plan establishes feasibility only. It does not implement UI, persistence, reviewer policy,
  consent reset, pending-card resume, migrations or replay changes from the full spec.

## Review focus

- A denied network request with a broken endpoint is inconclusive: require a healthy positive
  control and server-side receipt evidence (Tasks 1–4).
- A project outside the device workspace must remain usable without allowing sibling writes;
  symlinks must not bypass the same grant (Tasks 1–4).
- A Full operation running between restricted checks must not change the restricted operation's
  effective filesystem/network scope (Tasks 1–4).
- Cancelling a command must stop its descendants without killing another command or the shared
  fixture service; detached background work keeps its starting grant (Tasks 1–4).
- Missing capabilities, runtime or credentials must remain unsupported/unverified; a mock, skipped
  test or silently elevated fallback cannot produce a supported result (Tasks 1 and 5).

## File map and execution convention

Create a unique directory with `mkdtemp` under the OS temporary directory, recorded as `SPIKE_ROOT`.
Paths below beginning with `SPIKE_ROOT/` are throwaway files, not repository paths. Reuse installed
dependencies by resolving from the existing checkout; do not install packages or rebuild the active
device/kernel. Record both repository HEADs and dependency versions in the evidence.

- `SPIKE_ROOT/probe.mjs`: fixture lifecycle, scenarios, result validation and cleanup ledger.
- `SPIKE_ROOT/probe.test.mjs`: tests proving the evidence collector rejects invalid results.
- `SPIKE_ROOT/local.mjs`, `docker.mjs`, `e2b.mjs`: runtime-specific execution adapters.
- `SPIKE_ROOT/results/`: sanitized command results, runtime configuration and resource identities.
- Create in core: `docs/superpowers/specs/2026-11-16-permission-profile-feasibility-results.md`.
- Update in core: the linked design and this plan's progress checkboxes.

The adapter is an experimental interface, not a proposed SDK contract:
`probeProvider({ fixtureRoot, resultDir, signal }): Promise<ProviderEvidence>`.
`ProviderEvidence` contains `provider`, `status` (`demonstrated`, `unsupported`, `unverified`),
`runtime`, `mechanism`, `checks`, `reason`, `resources` and `cleanup`.
Each check contains its scenario name, expectation, observation, outcome and evidence filename.
`demonstrated` requires every mandatory scenario to pass on the real runtime and cleanup to finish.
Failure to enforce a required scope is `unsupported`; missing access or an inconclusive control is
`unverified`. Never synthesize a successful check for an unimplemented adapter.

### Task 1: Build a falsifiable probe and disposable fixtures

**Files:** Create `SPIKE_ROOT/probe.mjs` and `SPIKE_ROOT/probe.test.mjs`.

**Interfaces:** Produces the adapter interface above, `validateEvidence(evidence): string[]`,
`createFixture(base): Promise<Fixture>` and `runScenarios(adapter, fixture): Promise<ProviderEvidence>`.
The fixture contains `deviceWorkspace`, a separate `project`, `sibling`, `syntheticSecrets`,
`scratch`, `skills`, and resource cleanup callbacks. It contains no user data.

- [x] Write collector tests: reject a demonstrated result with a skipped check, a missing positive
  network control, missing concurrency handshake, changed device identity or incomplete cleanup.
- [x] Run `node --test "$SPIKE_ROOT/probe.test.mjs"`; verify the tests fail before implementing
  `validateEvidence`, then implement it and require all collector tests to pass.
- [x] Define the same mandatory scenarios for every adapter:
  1. Read a synthetic package.json, run inline Python/Node and edit the selected project outside
     `deviceWorkspace`; verify output and resulting bytes.
  2. Refuse an outside write and a synthetic-secret read; verify that the sibling bytes remain
     unchanged. Full positive controls must succeed within the synthetic ceiling.
  3. Refuse a write through a project symlink into the sibling and a secret read through a symlink;
     repeat via native read/write/stat/list/scan paths, marking unimplemented paths unverified.
  4. Reach an allowed fixture endpoint, refuse a denied one, and reach the denied endpoint with
     Full. Use controlled endpoints and request tokens; transport failure alone proves nothing.
  5. Start restricted A, wait for its ready handshake, run Full B, then release A to repeat denied
     filesystem/network attempts while B is still alive. Repeat with inverse launch order.
  6. Start a tagged foreground command with a descendant and detached background work; cancel
     the targeted execution and verify its required processes end while another tag and the
     fixture service stay alive. A profile change alone must not kill already started work.
  7. Verify shared file changes, an installed fixture executable and a running fixture service
     remain visible before/after profile changes without recreating the device.
  8. Give trusted preparation a skills-write capability; ensure the next user operation cannot
     reuse it. A following restricted file operation cannot inherit the preceding Full grant.
- [x] Use readiness messages/barriers and bounded condition waits, never fixed sleeps to order
  the concurrency assertions. Track every created resource before using it and clean up on error
  and cancellation; do not delete resources by a broad name prefix.

### Task 2: Validate actual local enforcement

**Files:** Create `SPIKE_ROOT/local.mjs`; append evidence to the results document.

**Read-only references in core:** `packages/device/src/exec/os.ts`, `exec/switch.ts`, `exec/host.ts`,
`policy.ts`, `test/exec-os.test.ts` and `test/exec-os-network.test.ts`. The network test mocks the
runtime and cannot establish actual confinement.

**Interfaces:** Implements `probeProvider` for the current macOS runtime. Record Linux as unverified
unless a disposable supported Linux environment is actually exercised.

- [x] Resolve the installed runtime's types/source and platform dependencies. Establish whether
  its per-wrap configuration can express independent roots and egress without `updateConfig`
  affecting other operations. Record the exact API used; do not infer support from its name.
- [x] Run the scenarios against today's executor as a baseline; record the outside-project and
  stale-grant limitations without changing production code.
- [x] If a supported operation-local mechanism exists, implement only the throwaway adapter and
  run `node "$SPIKE_ROOT/probe.mjs" local`. Full operations use the synthetic fixture scope and
  must not change the connected device's policy or the process-wide runtime configuration.
- [x] Require positive controls and all mandatory scenarios for a demonstrated result. On an
  unsupported mechanism, retain a minimal reproducer and stop that adapter rather than building
  a replacement sandbox. Dispose the isolated runtime and verify fixture cleanup.

### Task 3: Validate Docker without changing its outer boundary

Disposition: bounded primitive investigation and cleanup complete. The unchecked compound steps
below were only partially exercised: the provider import/exact context image were unavailable;
CLI reproduced hardening and tested namespace refusal, Landlock filesystem and direct TCP ports.
Proxy-aware operation network enforcement and the full provider scenarios remain unverified.
The namespace route is unsupported; this does not establish whole-architecture impossibility.

**Files:** Create `SPIKE_ROOT/docker.mjs`; append evidence to the results document.

**Read-only references in plugins:** `plugins/sandbox-docker/src/provider.ts`,
`test/docker-env.ts`, `test/concurrent.test.ts`, `test/network.test.ts`, `image/Dockerfile`.

**Interfaces:** Implements `probeProvider` for a uniquely labelled disposable provider device,
retaining the same instance and shared volumes throughout the scenarios.

- [x] Record the actual configured Docker runtime, capabilities, seccomp, user and mounts. Use
  existing test images/helpers where possible, and record image digests. Never select a weaker
  runtime to make the result pass.
- [ ] Reproduce today's device-wide roots/network behavior on disposable data. Investigate a
  trusted per-operation mechanism inside that same container using its existing privileges.
- [ ] Run `node "$SPIKE_ROOT/probe.mjs" docker` if that mechanism can be exercised. Confirm that
  no provider `update` call, proxy replacement, extra execution container or container recreation
  is used to switch a conversation's profile. Test network bypass by direct socket as well as
  proxy-aware clients; environment proxy variables alone are not enforcement.
- [ ] If the mechanism requires new capabilities, user namespaces or relaxed seccomp, record the
  exact refusal and mark this architecture unsupported. Do not make those changes. Remove only
  resources whose exact identities are in this run's ledger; verify removal.

### Task 4: Validate E2B with an existing real test environment

Disposition: prescribed unavailable-environment path complete. No configured existing test
template; all live VM/runtime/network/deletion steps below remain unexecuted and unchecked.
The collector's host fixture was removed; no remote resource existed to delete.

**Files:** Create `SPIKE_ROOT/e2b.mjs`; append evidence to the results document.

**Read-only references in plugins:** `plugins/sandbox-e2b/src/provider.ts`, `src/e2b-api.ts`,
`test/live/sandbox-e2b.live.test.ts` and `README.md`.

**Interfaces:** Implements `probeProvider` for one disposable microVM using configured
`CAPYBARA_TEST_E2B_API_KEY` and an existing `CAPYBARA_TEST_E2B_TEMPLATE`.

- [x] Check only presence of test credentials/template without printing values. If unavailable,
  produce an unverified result and continue to Task 5. Do not substitute the running device,
  build a new template or request a production API key.
- [ ] Create one uniquely identified test VM with bounded lifetime, record its identity before
  further operations, and inspect actual namespace/runtime capabilities in that VM.
- [ ] Exercise a trusted per-operation boundary if available, using
  `node "$SPIKE_ROOT/probe.mjs" e2b`. Keep the same VM, files, services and global network
  configuration; do not copy projects to a second VM. Test direct socket bypass as in Task 3.
  Record the provider's documented metadata endpoint residual separately; do not claim it is
  blocked by the current VM network controls.
- [ ] Require healthy controlled endpoint checks before accepting network results. If the
  runtime/control endpoint is unavailable, record unverified. If enforcement cannot meet the
  same-VM requirements, record unsupported with a reproducer. Destroy only the recorded test VM
  and verify it is gone, including after a cancelled probe.

### Task 5: Review evidence and return the architectural decision

Disposition: results/design synthesis and fresh 31-test scratch verification complete. Historical
negative evidence remains recorded; all three authoritative results validate structurally. The
gate-pass branch is inapplicable and stays unchecked. Final documentation diff review/commit is
reserved for the controller after independent review; this worker made no commit.

**Files:** Complete the results document; update the design and plan status only.

**Interfaces:** Consumes all provider evidence; produces a concise local/Docker/E2B comparison,
minimal reproduction commands, exact limitations and a recommended next design decision.

- [x] Run `node --test "$SPIKE_ROOT/probe.test.mjs"` again and validate every collected result.
  Include negative results and exact cleanup state. Sanitize logs before retaining evidence;
  never commit credentials, bearer tokens, user file contents or raw service configuration.
- [x] Check that baseline limitations are distinguished from experimentally demonstrated
  mechanisms. A demonstrated primitive is not a completed product integration.
- [x] If a provider fails the gate, present the concrete tradeoff to the maintainer: revise the
  single-instance architecture, restrict supported profiles/devices, or defer the feature.
  Do not choose one implicitly. An unverified E2B result keeps the cloud completion gate open.
- [ ] If the gate passes, revise the design around the proven operation context and capability
  model, then request review before writing the full product implementation plan.
- [ ] Run `git diff --check`, review the documentation diff, and commit only approved design,
  evidence and plan progress with a Conventional Commit. Keep throwaway executables outside the
  repositories; no package release or changeset is needed for this documentation-only deliverable.

## Self-review

This plan covers only the spec's feasibility gate. Every required gate behavior is represented in
Task 1; Tasks 2–4 record actual coverage and explicitly unverified paths. Task 5 prevents
unsupported or missing evidence from becoming a support claim. All five Review Focus conditions have explicit checks. Full product behavior and
cross-replica/replay tests deliberately remain for the later reviewed implementation plan.
