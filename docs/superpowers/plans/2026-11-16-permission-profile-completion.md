# Permission profile completion plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development with wave-planned-subagent-development. Steps use checkbox syntax for tracking.

**Goal:** Complete the approved three-profile behavior and verification across local, Docker and E2B devices.

**Architecture:** Preserve the approved shared device, independent owner/org ceilings and conversation-specific grants. Complete the missing proof before committing to an enforcement contract, then implement the proven mechanism across SDK, providers, kernel and UI. The maintainer authorized continuous execution and routine technical decisions on 2026-11-16; seek input only for a genuinely missing authorization or a change to the approved product boundaries.

**Tech stack:** Existing TypeScript/pnpm repositories, installed sandbox runtime, native OS enforcement, real provider tests and existing local services.

**Spec:** `docs/superpowers/specs/2026-11-16-conversation-approval-profiles-design.md`; evidence: `docs/superpowers/specs/2026-11-16-permission-profile-feasibility-results.md`.

**Progress (2026-11-16):** Local and E2B primitive reports have independent reviews. The Linux V3
review leaves launch-time pinned-root identity unverified; the follow-up was platform-blocked and
has not been retried. The reviewed [operation contract](../specs/2026-11-16-permission-operation-contract.md)
and [delivery plan](2026-11-16-permission-profile-delivery.md) now govern independent SDK/API/UI
implementation. The generic composer picker is committed as `09272da87`; app integration and
provider acceptance remain pending. These milestones do not mark the full completion goal achieved.

## Global constraints

- One shared device environment; no extra execution containers/VMs to switch a conversation profile.
- No weakening outer Docker capabilities/seccomp or widening another operation's policy.
- Full access never exceeds independently authorized device/org/provider/OS ceilings.
- Default Approve for me; all three options have identical neutral colors.
- Fresh per-operation authority for commands and every file operation; no cached last-exec grants.
- Root-owner human changes, live child inheritance, device/scope-bound consent and recorded replay decisions.
- Future operations narrow immediately; existing work retains starting grants unless actual ceilings are revoked.
- Never call a provider supported from mocked enforcement, attribution IDs or unavailable runtime evidence.
- Keep the active local dev stack available. Use disposable fixtures for isolation tests.
- Never print test credentials or copy production keys/configuration into evidence.
- Production changes follow issue/PR workflow and area skills; SDK changes reach plugins through published packages.

## Review focus

- A command must not borrow another command's network grant through its proxy credentials or endpoint.
- Native read/write/stat/list/scan must enforce their own current scope and resist symlink escapes.
- Restricted and Full commands on one device must retain independent filesystem/network enforcement.
- Abort and detached-process cleanup must affect only owned execution identities.
- Device-owner grants and unsupported runtime capabilities must fail closed through every tool/resume path.

### Task 1: Complete local authority and native-operation proof

**Files:** Scratch-only `local-v2*` under the existing spike directory; report in this plan's SDD workspace.

- [ ] Repair the recorded network-lifetime predicate before reusing the old harness.
- [ ] Exercise an isolated immutable runtime worker per operation, with its own deny-default network policy, rather than treating command IDs as authority. Test cross-worker proxy endpoint/credential borrowing with positive controls and both overlap orders.
- [ ] Exercise native read/write/stat/list/scan under explicit operation scope, including a project outside the fixed device workspace, symlinks, consecutive Full/restricted calls and trusted skill preparation.
- [ ] Reuse safe exact execution/group identities for foreground/descendant/detached cleanup. Retain starting grants for live work and preserve unrelated service/work.
- [ ] Record minimal commands, actual results, cleanup and the smallest proven integration contract. Do not modify product sources in this proof task.

### Task 2: Complete same-container Linux enforcement proof

**Files:** Scratch-only `linux-v2*`; provider source references remain read-only.

- [ ] Test Landlock plus a trusted operation-specific broker under the existing hardened container. Consider a fixed per-operation proxy endpoint with OS-enforced access, not bearer-ID secrecy alone. Do not implement a large replacement sandbox.
- [ ] Explicitly test same-port/different-address, peer proxy borrowing, direct sockets, UDP/inherited FDs and native path/symlink authority. A passing port filter alone is insufficient.
- [ ] Exercise both overlapping profiles, trusted preparation separation and exact tagged cancellation in one unchanged environment.
- [ ] Report a concrete positive mechanism or a bounded failure with remaining alternatives. No outer-policy relaxation or implicit architecture change.

### Task 3: Discover and validate a real E2B test environment

**Files:** Scratch-only `e2b-v2*`; load only documented test credentials in memory.

- [ ] Query the configured test account read-only for existing owned/private compatible templates; retain only nonsecret identifiers and compatibility evidence.
- [ ] Reuse a suitable existing template for one bounded disposable VM. Do not build a new template under the earlier no-template-creation restriction without resolving that authorization.
- [ ] Probe actual kernel/enforcement capabilities and shared-environment scope, network, concurrency and cancellation; no mocked envd proof.
- [ ] Destroy the exact owned VM and verify absence. If the account offers no usable template, continue independent local/Docker work and request only the missing concrete authorization.

### Task 4: Refine the implementation contract and execute delivery waves

**Files:** Approved design plus a detailed implementation plan; then area-owned product files.

- [ ] Independently review Tasks 1–3 and incorporate proven operation authority/capabilities into the design. Preserve maintainer-approved product boundaries; surface only material changes.
- [ ] Write exact interfaces, files, meaningful red/green tests and disjoint execution waves before product edits. Follow contributing, SDK release ordering, migration, replay, tool, sandbox and UI skills.
- [ ] Implement the cross-repository contract, device enforcement, kernel policy/state/replay and neutral UI with fresh independent reviews and fix loops.
- [ ] Run required verification and real provider tests, prepare reviewable PRs and preserve the active dev environment. Report any final merge/release authorization separately from completed reviewable work.

### Task 5: Add the independent composer permission-picker support

**Files:** `packages/design/src/conversation/composer.tsx`, `composer-options.tsx`,
`packages/design/src/i18n.ts`, existing composer menu/phone tests and a design-package changeset.

**Interface:** Add optional `permission?: PickerProps` to `ComposerBoxProps.pickers` and
`ComposerOptionsProps`. Desktop order is device, permission, model, effort. Mobile has the same
permission group and includes the selected permission in its accessible summary. Existing callers
without the optional picker retain their current rendering.

- [ ] Write meaningful interaction tests for desktop and phone selection, disabled capability
  reasons, selected checkmarks and the same neutral presentation for all three supplied profiles.
- [ ] Run the focused tests red, add the minimal optional picker support using existing components,
  then run the focused tests green. No CSS/color additions or special Full access accent.
- [ ] Add bilingual `composer.options.permission` title (权限 / Permissions), update edited comments
  in English and include a changeset for the published design package.
- [ ] Independently review the change before app integration. This task depends only on the
  approved UI outline, not the pending provider contract; do not change app/API files here.

## Execution status

Continuous execution authorized by the maintainer. Tasks 1–3 are independent proof tasks; Task 4 depends on their evidence. This plan is not a support claim or permission to change the shared-device architecture.
