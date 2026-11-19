# Conversation permission profiles

> **Amended 2026-11-19:** the profiles are approval policy only and the sandbox is a device setting
> identical under all three; the Codex-style coupling of Full access to unsandboxed execution is
> superseded. See [approval-only profiles](2026-11-19-approval-only-profiles-design.md), section
> "Superseded parts of earlier designs".

Status: product model and technical direction approved by the maintainer on 2026-11-16, including
conversation-independent permissions, device/scope-bound Full access consent, and applying profile
changes to subsequent operations while existing work retains its starting grant. The bounded
feasibility plan was approved for subagent execution on the same date; product implementation
follows the gate and a further reviewed design and plan. The bounded investigation is complete;
its [results](2026-11-16-permission-profile-feasibility-results.md) leave all three aggregate
provider profiles unverified. The feature remains unimplemented.

## Intent and evidence

People choose a device and a permission profile. Local and cloud devices use the same
Request approval / Approve for me / Full access control. They should not have to switch a second
product-level auto/sandbox control while working.

The maintainer requested fewer unnecessary approvals for ordinary reads, repair of four skipped
project skills, and a unified permissions model. Skill metadata and configuring the existing
review classifier are independent immediate fixes. This document covers the larger change.

Official Codex behavior was checked on 2026-11-16:

- https://learn.chatgpt.com/docs/permission-modes
- https://learn.chatgpt.com/docs/sandboxing#configure-defaults
- https://learn.chatgpt.com/docs/sandboxing/auto-review

Codex combines an execution boundary, an approval policy and a reviewer into presets. Request
approval allows ordinary edits and commands inside the workspace. Approve for me retains the
same boundary but delegates eligible requests to a separate reviewer. Full access removes Codex's
own filesystem/network sandbox and uses approval_policy=never. It does not grant OS privileges.

The approved product model follows this distinction. The default is Approve for me; all three
options use identical neutral text/icon colors. Device selection represents execution location and
its independently authorized ceiling, without a daily auto/sandbox picker.

## Approaches

1. Keep device auto/sandbox modes and add three approval options beside them. This preserves the
   confusing second control and does not meet the requested product model.
2. Remove device modes and make every device unrestricted regardless of profile. This loses the
   enforceable workspace boundary that makes low-friction routine work possible.
3. Expose three permission presets over independent execution-boundary and reviewer settings.
   Recommended. Devices describe location and authorized capability ceilings; presets select how
   a conversation uses those capabilities. Low-level sandbox enforcement remains necessary.

The maintainer accepted approach 3. The implementation must preserve one shared device environment
unless a later design explicitly changes that repository-wide architectural rule.

## Proposed behavior

| Profile | Within the approved project/workspace | Crossing the workspace/network boundary |
|---|---|---|
| Request approval | Read, edit and run ordinary commands without a prompt | Ask the person |
| Approve for me (default) | The same workspace permissions | A separate review model decides; ask if it cannot decide |
| Full access | Autonomous commands and file access | No discretionary approval; use the device authority its owner/admin already granted |

Keep explicit platform/org denies, role restrictions, extension policy hooks and external-app
permissions authoritative. Profiles do not authorize new connectors, org administration or other
people's devices. A cloud device's Full access reaches its provisioned environment, never the
cloud host or a laptop implicitly. Physical provider restrictions and OS permissions still apply.

The profile may relax the agent-specific sandbox only up to the independently authorized device
ceiling. A local owner authorizes whether unrestricted machine execution is available when
connecting/configuring the device. The web cannot widen that grant. A cloud administrator
provisions its maximum environment and network reach. Full access is unavailable when that
ceiling forbids it; do not label sandboxed execution as unrestricted host access.

### Full access semantics

Full access follows the approved Codex-style preset: it replaces discretionary sensitive-command
consent too, including the current per-command asks for credential access, sudo and persistent
changes. It does not override explicit platform/org denials, external-app consent, device-owner
grants or OS authorization. Access by the OS user is not root access; sudo may still require an OS
password. These distinctions must be reflected in the picker rather than described as unlimited
privileges.

Bind Full access consent to the selected device and its authorized scope. A device switch or a
wider grant resets the profile to Approve for me and requires a new explicit Full access selection.
Do not carry consent from a cloud device onto a laptop. A restart with unchanged identity/scope
and a harmless device rename do not widen consent.

## Current implementation constraints

The product model does not map safely onto the present device switch:

- The SDK carries mode/network on instance creation/update; exec, read and write calls do not
  carry an independently enforced conversation scope. Actor and command tags are informational
  or lifecycle metadata, not authorization boundaries (`packages/plugin-sdk/src/sandbox.ts`).
- A project currently chooses cwd and relative-path resolution, not access scope
  (`packages/kernel/src/tools/builtins/sandbox/common.ts`). The local sandbox helper additionally
  assumes the fixed device workspace (`packages/device/src/exec/os.ts`).
- Docker changes the one device container/proxy; E2B changes the one microVM's network. All
  conversations share the instance user and workspace. Neither official provider currently
  declares session isolation. A facade alone cannot change those facts (plugins repository,
  `plugins/sandbox-docker/src/provider.ts`, `plugins/sandbox-e2b/src/provider.ts`).
- The environments design of 2026-11-07 section 7 explicitly rejects nested Docker isolation if
  it needs user namespaces and looser seccomp. Its E2B capability table describes an aspiration
  not implemented by the current provider. Do not treat either as proof that a nested helper works.

Shared project files allow conversations to influence each other's inputs. Independent operation
permissions must not be presented as confidentiality or mutual trust isolation between conversations
that deliberately share writable files. This is not isolation from a malicious device owner or
an already authorized Full access operation that tampers with the shared runtime. The concurrency
requirement prevents permission leakage through shared configuration; it does not claim to turn
Full access and restricted work under the same OS owner into mutually untrusted tenants.

## Feasibility gate before the implementation plan

**Author's recommendation:** preserve the current shared device and environment. First verify a
trusted, operation-scoped execution boundary under the actual local/Docker/E2B runtime. Do not
change shared instance policy to temporarily elevate one conversation, and do not weaken an outer
container's seccomp/capabilities to make a demonstration pass.

The approved bounded throwaway feasibility spike has completed its available investigation.
Its artifacts are not production code and require a later reviewed design and plan before product
integration. The gate still requires all of the following demonstrations:

1. A restricted operation can read/edit the selected project and execute ordinary inline code,
   but cannot write outside approved roots or reach an unapproved network destination.
2. A simultaneous Full access operation on the same device does not expand the restricted
   operation's filesystem or network permissions. It may use the same authorized project files.
3. Native file operations receive the same scope, including symlink/realpath checks. They cannot
   borrow a previous command's decision or a trusted internal attachment/skill-write grant.
4. Killing or cancelling one execution stops its processes and leaves another conversation alone.
5. Files, installed environment and existing device services remain shared as the current device
   model promises; switching a profile does not recreate or silently fork the device environment.

Use disposable data and an isolated test instance, not the connected user's running project or
services. Real E2B verification needs a configured test account/runtime; a mocked envd call is not
proof of isolation. Record an unavailable environment as unverified, not supported.

If the gate cannot be met without changing the single-instance device architecture, return to the
maintainer with evidence. Docker execution containers sharing scoped volume mounts are a concrete
alternative, but would require an explicit architectural decision and lifecycle work. Separate E2B
VMs with copied files are not an equivalent shared device. Do not silently adopt either alternative.

Both official cloud providers must have demonstrated behavior before this feature is called
complete. Third-party or unupgraded providers must report unsupported profiles before execution;
never fall back to host/environment execution under a restricted profile. The full implementation
plan follows a revised design incorporating the spike results.

### Evidence status and remaining proofs (2026-11-16)

The [results report](2026-11-16-permission-profile-feasibility-results.md) separates current
integration, runtime primitives and missing product integration. Local macOS passed seven of eight
experimental scenarios; native operation-local scope remains missing. The fixed deny-default
network experiment passed controlled checks, but runtime command IDs are attribution rather than
an authority boundary; discovery/replay resistance remains unverified. Cancellation covered known
registered groups, not arbitrary detached rediscovery. Linux was not exercised.

Under unchanged Docker hardening the tested nested-namespace route returned EPERM. Landlock
provided a limited per-process filesystem boundary, but stat metadata stayed visible and its
port-based TCP rule allowed another address at the permitted port. The actual provider could not
load against the installed SDK, and the exact build-context image was unavailable; Docker CLI
reproduced the relevant hardening, not complete provider integration. E2B had no configured test
template, so no VM/API/runtime experiment occurred. Missing current API scope or environment is
not evidence that the shared-device architecture is impossible.

Preserve the approved architecture while obtaining native grant/skills separation, enforceable
network authority, safe detached cancellation, actual Docker provider/native/network/concurrency
coverage, Linux coverage and E2B runtime proof in one existing test environment. No SDK signatures
or new product decisions are established by this evidence. A full product plan remains premature;
if a remaining required boundary is proven infeasible, the maintainer must explicitly choose an
architecture change, narrower supported profiles/devices or deferral. The existing cloud completion
gate remains unchanged.

## Device and execution model

A device remains a persistent execution location with provider capabilities and an owner/admin
access ceiling. Remove the daily device-mode picker; show granted reach and isolation in details.
The execution layer may retain a low-level sandbox selector, while public configuration and UI
use the approved permission concepts. Before 0.1.0, change public formats directly: do not preserve
old mode/config aliases as a compatibility layer. Migrate stored authority without widening it.

Request approval and Approve for me use an enforced scope derived from the selected project,
its approved source directories and required device scratch/tool directories. The project must
remain readable and writable when a person tightens confirmation: never fall back to the old
fixed device workspace and recreate the project-first-read bug. Supporting the current single
project root is required; adding the separate multi-source project feature is not part of this change.

Derive permissions per operation, not from a previous command. Exec, reads, list/scan and writes
must all use the current grant. In particular retire the current last-exec write window instead
of letting Full access linger after a change to a restricted profile. Pass required operation
ceilings and approved roots through the local protocol; a changed wire contract requires a
protocol bump and synchronized device/kernel upgrade. Do not add an old-client fallback.

Conversation-scoped operation grants cannot live on a shared device handle or in process memory:
concurrent root/sub-agent conversations may use different profiles on one device. Bind a fresh
operation context or provider-issued scoped handle to each call, backed by actual enforcement.
The SDK must declare supported filesystem/network/concurrent-scope capabilities; concurrentExec
or sessionIsolation alone is insufficient. Separate trusted kernel preparation writes from user
operations. Update provider contracts, conformance tests, the API report and changesets together.

Existing connection-time auto/sandbox grants must migrate without widening their maximum reach.
A missing restricted-execution capability makes that profile unavailable; it never selects Full
access automatically, even when Approve for me is the default.
Removing a setup control's underlying authorization is an explicit contract migration, not a
UI rename that silently trusts the server with broader machine access.

## Conversation state, authority and races

- Persist the profile on the root conversation; default existing and new chats to Approve for me.
- Only an authenticated interactive conversation owner may change it. Do not expose escalation
  through the Platform tool; exclude that route as human-only in route parity. Shared viewers and
  sub-agents cannot grant themselves authority. Other tools' mandatory approval policies survive.
- Children use the root profile live. Scheduled runs keep their current unattended policy and
  explicit task grants; they never inherit Full access from a chat.
- Record old/new profile, actor, device and scope revision in the event log and audit. An explicit
  Full access selection confirms its scope. Do not infer consent from an earlier command.
- Recheck the current profile, consent scope and org/tool/device ceilings before each operation
  and approved resume. Explicit denials remain authoritative.
- A profile change re-evaluates pending command cards through transactional outbox/run resume.
  Supersede obsolete cards transactionally; do not mark them approved. Late clicks cannot execute
  twice. A stricter profile applies to following operations. Commands/background tasks already started
  keep their recorded starting grant, which the UI makes clear; the person can stop them. An actual
  owner/org ceiling revocation still cancels affected work, scoped by execution tags.

## Model context and replay

Expose effective profile/scope through logged run context, not ad-hoc DB reads in request building.
Model-visible changes get a DriftReason. Preserve append-only history; recorded tool review
outcomes include profile and decision source. Replay uses recorded decisions, never today's
permission setting. Run zero-drift fixtures before and after changing request construction.

## UI outline

Composer footer: `+  MacBook-Pro.local · core   帮我批准 ▾   DeepSeek… ▾   高 ▾`.

The maintainer explicitly chose identical neutral text/icon colors for all three profiles.
Full access has no orange menu row, composer label or special accent. Selection is indicated
by a checkmark, using the same treatment for every profile.

Three rows with an icon, selected checkmark and explanation:

- 请求批准 — 在项目内直接工作，超出范围时询问你。
- 帮我批准 — 在项目内直接工作，额外授权交给自动审查。
- 完全访问 — 使用此设备已授权的完整访问范围，不再逐次确认。

Use the same menu for cloud/local devices, new and existing chats, and mobile options. Explain
unavailable options using the actual ceiling. For an unconfigured review model, explain that
uncertain requests still ask and link authorized admins to model-purpose settings. Never silently
fall back to Full access. All UI copy is bilingual and uses design-system components/query cache.

## Validation

- Table-test all profiles against ordinary reads/edits, inline code, outside writes, network
  access, credentials, sudo, explicit denies and mandatory tool asks on cloud/local devices.
- Prove sandbox confinement, owner grant ceilings and no host fallback on unsupported devices.
- Prove owner-only profile changes, child inheritance, unattended behavior, changed-device/scope
  consent, pending-card invalidation, live narrowing and exactly-once resume across replicas.
- Preserve project-first-read behavior and fresh ceilings for every file operation.
- Use the reported package.json-reading Python command as a classifier regression; unknown,
  denied and failed reviews retain the selected policy. Do not regex-whitelist arbitrary scripts.
- Add an immutable idempotent migration, API/schema parity, event/replay coverage, i18n, responsive
  UI checks, appropriate package changesets and SDK regeneration when public contracts change.

## Scope boundary

The project-reading and skill metadata fixes were merged in PRs #314 and #315. They are baseline,
not part of this feature. Multi-source projects, external connector permission policy and scheduled
Full access opt-in are separate features. This branch currently contains design documentation only.

## Per-call sandbox escalation (2026-11-19 maintainer decision)

Status: decided by the maintainer on 2026-11-19, implemented on `perm/call-escalation`. It
follows Codex (`sandbox_permissions: "require_escalated"` with a justification) and Claude Code
(`dangerouslyDisableSandbox`). The same day the maintainer fixed the target profile model this
section is written for; the profile-semantics refactor that implements it lands in the same
release (see "Target model" below).

### Target model

The three profiles are **approval policy only**. The sandbox (directories, network) is a device
setting and is the same under every profile; Full access means "no approvals", not "no sandbox".
Commands always run in the device's sandbox, and a boundary crossing (a per-call escalation, a
directory or host proposal) is decided by the profile's **approver**:

| Profile | Approver of a crossing and of a sensitive command |
|---|---|
| Request approval | the person |
| Approve for me | the review model; it asks the person when it cannot decide |
| Full access | none: granted for that call, within the device's ceiling for running outside the sandbox |

The ceiling is today's Full access ceiling: the owner's ceiling, the org's `fullAccess` and the
platform's `devices.fullAccess`. A separate refactor in the same release renames it to "outside
the sandbox" and stops Full access from removing the sandbox. Until it lands, Full access still
runs every call unsandboxed, so an escalation under Full access is a no-op that asks nobody. The
code already expresses the target: `approverForProfile` maps the profile to person / review model
/ none, and "none" grants within the ceiling (the escalation is refused past it).

### Input

`Bash` gains two optional inputs: `sandbox: "escalated"` asks to run this one call outside the OS
sandbox, and `justification` (1–500 characters) says why. Both foreground and background calls
(`run_in_background`) may escalate, under the same review: a dev server is a key use. The file
tools do not take it; a directory proposal covers them. An escalated call without a usable
justification is refused before any review with a text that says what to pass. The `Bash`
description tells the model to try inside the sandbox first and to escalate only the call the
sandbox blocked.

### Review

The order in `CommandReviewService.decidePermission` and `ToolPipeline.reviewPermissionCall`:

1. Fixed denies and the mandatory tool asks come first and stay authoritative for an escalated
   call too (`rm -rf /` stays a deny, a `requiresUserInteraction` tool still asks).
2. The candidate builder (`buildPermissionCandidate`) turns an escalated `Bash` call into one
   `sandbox-escalation` candidate: the exact call binding (run, call, tool spec, raw and resolved
   input hashes, profile and its revision, scope and authority revisions), an empty expansion and
   the justification. It never also proposes directories or hosts for that call.
3. Request approval asks the person once. The ask's detail and `approval_requested.command`
   carry the command, the working directory (`workingRoot`) and `escalation.justification`; the
   reason states the crossing and, when the line is also sensitive (credential reads, sudo,
   persistent changes), that consent as well: one card, both reasons. Only `once` is offered.
4. Approve for me sends the candidate to the review model, with a dedicated block naming the
   escalation and the justification as untrusted data. Unavailable, unmapped, unsure, failing,
   truncated or unparseable means ask; the model's deny stays a deny; its allow issues the grant.
   The verdict is recorded as `permission_reviewed` (`scopeKind: "sandbox-escalation"`,
   `escalation`, outcome, decision source).
5. Full access (approver none) asks nobody (see "Target model").

An approval (the person's or the review model's) issues an immutable `permission_call_grants` row
with `scope_kind = 'sandbox-escalation'` and the justification (migration 0162), bound to exactly
this call by the existing binding hash. It is never a session grant: a replay or another call
with a changed input has another binding and finds nothing. Issuance re-checks the Full access
ceiling and the runtime's Full support; a session grant of a consent class never covers the
escalation itself.

### Ceilings and who may escalate

Escalation is possible only where Full access would be: the owner ceiling, the org `fullAccess`
and the platform `devices.fullAccess` (`fullAccessCeiling`), and a runtime that runs Full access
now (the same `withheldScope` verdict Full access gets). The consent scope is the grant's binding
to the current scope and authority revisions: a ceiling or scope change invalidates it. Admission
checks the same at every operation: `SandboxOperationAuthority.resolveInvocation` refuses an
escalation grant when the snapshot's `escalationRefusal` is set, and `intersectPermissionScope`
refuses `escalated` without the ceiling. Otherwise the model gets an actionable text naming why
(the device or org does not allow it, the runtime cannot, the run is unattended) and what to do
instead (run it in the sandbox, ask the user to run it or to allow Full access on the device).

Unattended runs (scheduled tasks) cannot escalate; a sub-agent can ask, but only the person or
the review model approves (never the agent itself); another account's run never reaches the
owner's device. These are the rules Full access already follows.

### Device and providers

An admitted escalated command gets an operation scope with the conversation's restricted
`profile` and full reach (`filesystem: device`, `network: environment`); its native methods keep
the base scope, and the next call is restricted again. The device decides full execution from the
scope's reach (`intersectOperation`), so local macOS, Linux and Docker-mode devices run it with
their existing `full` grant; the owner's Full ceiling still refuses it. Kernel checks that used the
profile name as "needs Full" now also count a full reach under a restricted profile
(`isFullExecutionScope`: the provider support check, the Full ceiling revocation predicates), so revoking the Full ceiling cancels an
escalated command too. E2B is Full only, so escalation does not apply there. `commands.log` records
`isolation: "full"` and `grantSource: "call approval"` for an escalated operation, never the
command text. No SDK or protocol change.

### Model-facing texts

When a restricted `Bash` call is stopped by the restricted scope (a command's own outside write,
an unbounded `cd`, the device's scope refusal) or fails with a sandbox denial (`Operation not
permitted`, `Read-only file system`, `Permission denied`), the text the model gets says it may
retry the same call with `sandbox: "escalated"` and a justification, only where escalation is
possible on that device and org (`ToolStepContext` carries `sandboxEscalation: available`).

### Replay and log

The new inputs are part of `Bash`'s tool schema: definitions are fetched by spec hash, so no
`DriftReason` (the replay-evals tool-definition rule). The escalation decision is in the log:
`approval_requested.command.escalation`, `approval_decided`, `permission_reviewed`, and
`tool_result.review.sandbox: "escalated"` on a call that ran escalated (display only).

### Web

The approval card shows an escalation request distinctly (`SandboxEscalationDetail`): that only
this call runs outside the sandbox with full access to the device's files and network, the
directory it runs in and the agent's justification, under the command; no empty directory scope.
The inbox shows the same.

### AGENTS.md rules touched

Runtime and replay (no `DriftReason`: tool definitions by spec hash; the decision in the log),
Tools (`Bash` inputs, actionable refusals), Sandboxes (the command review still fails closed; full
execution only within the Full access ceiling) and Migrations (0162, expand-only).
