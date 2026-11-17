# Permission operation contract

Status: independently reviewed production implementation contract (2026-11-16). Implements the approved
[conversation permission profiles](2026-11-16-conversation-approval-profiles-design.md); it does
not change their product boundaries. The maintainer authorized routine implementation decisions
and continuous delivery. Runtime proof is evidence for a mechanism, not shipped provider support.

The builder review and both correction reviews are recorded in the completion workspace. The final
review approved the root-state/API implementation and additive SDK shapes; runtime support and
protocol activation retain their separate validation gates.

## Boundaries and evidence

One device still has one shared filesystem, installed environment and instance. No per-profile
containers/VMs, instance-wide permission toggles, Docker capability additions or seccomp relaxation.
Full access uses the independently granted owner/admin ceiling; shared writable files do not become
a confidentiality boundary between conversations. Mandatory external-tool consent and explicit
policy denies remain authoritative.

The completion evidence lives under `.superpowers/sdd/2026-11-16-permission-profile-completion/`:

- `task-1-report.md`: macOS immutable SRT workers, native descriptor operations, non-borrowable
  proxy endpoints and exact registered background ownership. Arbitrary detached-process discovery
  is not proved and must not be inferred.
- `task-3-report.md`: one existing E2B template demonstrates unprivileged namespaces, shared mounts,
  a private operation broker, descriptor closure and namespace/pidfd cancellation.
- `task-2-report.md`, authoritative Linux V3 section: original socket ownership in the broker,
  alias/nonblocking/socket-option compatibility, real curl/Node traffic, and pinned-object stat/chmod
  mediation survive the demonstrated races under unchanged Docker hardening. Production inventory
  remains required for chown, timestamps, xattrs, access, readlink, statfs, ioctl, watch APIs, ABI
  layouts and resource bounds. Passing stat/chmod is not proof for those other syscall families.

Linux same-pinned-root correction remains validation-pending: its follow-up was platform-blocked,
with no changed files or new resources. Do not retry that blocked security task or credit it as fixed.
Ordinary SDK, API and UI work may continue independently.

The existing Docker provider, every supported local Linux runtime and E2B template must pass the
actual-provider conformance gate before advertising support. Missing mechanisms mean unavailable,
never an implicit Full access fallback. The already recorded zero-drift baseline is 62/62 passing.

## Public SDK: one optional operation factory

Keep `sandbox@2`, instance/file-system lifecycle and existing provider method signatures. Add the
following declarations in `packages/plugin-sdk/src/sandbox-operation.ts`, re-exported from `index.ts`.
These are structural TypeScript types; implementations must copy and freeze input, not rely on
`readonly` to prevent caller mutation.

```ts
export type PermissionProfile =
  | "request-approval" | "approve-for-me" | "full-access";

export type SandboxFileScope =
  | { readonly kind: "scoped";
      readonly readRoots: readonly string[]; readonly writeRoots: readonly string[] }
  | { readonly kind: "device" };
export type SandboxNetworkScope =
  | { readonly kind: "none" }
  | { readonly kind: "allowlist"; readonly hosts: readonly string[] }
  | { readonly kind: "environment" };

export interface SandboxOperationRef {
  readonly operationId: string;
  readonly admitBeforeMs: number;
}
export interface SandboxOperationScope extends SandboxOperationRef {
  readonly deviceId: string;
  readonly rootConversationId: string;
  readonly profileRevision: number;
  readonly ceilingRevision: string;
  readonly profile: PermissionProfile;
  readonly actor: Readonly<SandboxActor>;
  readonly tag: string;
  readonly filesystem: SandboxFileScope;
  readonly network: SandboxNetworkScope;
}
export interface SandboxPermissionSupport {
  readonly version: 1;
  readonly restricted: {
    readonly filesystem: true; readonly network: true;
    readonly native: true; readonly concurrentScopes: true;
  } | null;
  readonly fullAccess: boolean;
  readonly background: boolean;
  readonly unavailableReason?: string;
}
export type SandboxExecOptions =
  Omit<Parameters<SandboxProvider["exec"]>[1], "tag" | "actor">;
export interface SandboxOperation {
  exec(args: SandboxExecOptions): Promise<ExecResult>;
  readFile(path: string, opts: { maxBytes: number; signal: AbortSignal }):
    Promise<{ data: Uint8Array; truncated: boolean } | null>;
  writeFile(path: string, data: Uint8Array, signal: AbortSignal): Promise<void>;
  stat(path: string, signal: AbortSignal): Promise<{ size: number; isDir: boolean } | null>;
  list?(path: string, opts: { limit: number; signal: AbortSignal }):
    Promise<{ entries: { name: string; isDir: boolean }[]; truncated: boolean } | null>;
  scan?(base: string, opts: { signal: AbortSignal }):
    Promise<{ path: string; suggestedName: string }[]>;
}
export interface SandboxPreparationScope {
  readonly operationId: string;
  readonly deviceId: string;
  readonly purpose: "skills" | "attachments";
  readonly writeRoots: readonly string[];
  readonly tag: string;
}
export type SandboxPreparation =
  Pick<SandboxOperation, "readFile" | "writeFile" | "stat">;
export interface SandboxBrowseScope extends SandboxOperationRef {
  readonly deviceId: string;
  readonly accountId: string;
  readonly ceilingRevision: string;
  readonly readRoots: readonly string[];
  readonly tag: string;
}
export type SandboxBrowse = Pick<SandboxOperation, "stat"> &
  Required<Pick<SandboxOperation, "list" | "scan">>;
export function parseSandboxOperationScope(value: unknown): SandboxOperationScope;
export function parseSandboxBrowseScope(value: unknown): SandboxBrowseScope;
export function parseSandboxPreparationScope(value: unknown): SandboxPreparationScope;
export function parseSandboxOperationRef(value: unknown): SandboxOperationRef;
export function parseSandboxExecutionRef(value: unknown): SandboxExecutionRef;
```

Add these optional methods to `SandboxProvider`:

```ts
permissionSupport?(h: SandboxHandle, signal: AbortSignal):
  Promise<SandboxPermissionSupport>;
operation?(h: SandboxHandle, scope: SandboxOperationScope, signal: AbortSignal):
  Promise<SandboxOperation>;
prepare?(h: SandboxHandle, scope: SandboxPreparationScope, signal: AbortSignal):
  Promise<SandboxPreparation>;
browse?(h: SandboxHandle, scope: SandboxBrowseScope, signal: AbortSignal): Promise<SandboxBrowse>;
revokeOperation?(h: SandboxHandle, ref: SandboxOperationRef, signal: AbortSignal): Promise<void>;
background?: SandboxBackground;
```

Scope parsers return deeply frozen copies, reject unknown fields, and throw
`SandboxScopeValidationError`. IDs are nonempty strings up to 128 characters; tags use
`SANDBOX_TAG_RE`; profile revisions are nonnegative safe integers, ceiling revisions are bounded
nonempty strings, and deadlines are positive safe integers.
Each root list has at most 64 absolute paths passing the existing path-shape guard (including `/`
when explicitly authorized); host lists have at most 100 entries passing `validateAllowHost`.
Preparation purpose and profile/network/filesystem kinds are strict enums. Empty lists grant nothing.
Execution references use the same ID bounds. Error classes/predicates are duck-typed like existing
gone errors; the SDK validators perform no I/O or authority lookup.

Optional capability is deliberate: a provider may still load to expose its devices/lifecycle, but
all three profiles are unavailable without the factory and runtime report. There is no adapter
from a missing factory to raw methods. Restricted support requires all four claims together;
`concurrentExec`/`sessionIsolation` are not substitutes. `fullAccess` describes provider ability,
not user consent. The kernel intersects it with live ceilings. Both list and scan remain optional
together; absence means projects unavailable. A recreated instance re-probes capabilities.

Permissions GET and selected-device/project preview never create, resume or update an instance.
Their availability value is `{state:"supported", report:SandboxPermissionSupport}`,
`{state:"unsupported", reason:string}` or `{state:"unprobed", reason:string}`. Persist reports with
provider version, runtime/helper hash, image/template fingerprint and instance generation; a changed
fingerprint invalidates the report. Use a valid persisted report or provider's documented static
support facts; otherwise return unprobed. Probing runs only against an already-running instance
without starting it, or during explicit execution/provisioning. Unprobed profiles can be selected
with “Checked when this device starts”; execution probes before any user operation and fails closed
if unsupported. Full still requires the independently known ceiling and displayed scope consent.
No SDK preflight method is needed: kernel read-model availability is separate from runtime enforcement.

Each factory is lightweight and opens no worker until a method is called. The kernel obtains a
new factory for each actual method invocation; providers may not cache grants on the device handle.
The combined factory/method signals end the operation. No close method is necessary: native work
owns its resources until return, exec until its supervised tree ends, background until final exit.
`operationId` and `tag` are audit/ownership keys, never credentials or permission selectors.

An `environment` network grant removes only the agent-specific filter. It does not change the
instance's network, grant access excluded by the owner/org, or bypass the provider's address rules.
An empty allowlist is deny-all. `device` filesystem means the provisioned device's existing OS
authority, never its cloud host. A scoped grant's writable roots are also readable; executable
runtime/library read exceptions are private provider policy, not additional native-data roots.
Approved one-operation escalation can expand roots/hosts within ceilings without changing profile.

Full access uses `filesystem.kind: "device"` and `network.kind: "environment"`. It runs as the
existing device OS user inside the existing outer device ceiling, without the restricted worker's
syscall, socket or daemonization filters. It still uses fresh authority, recorded identity and managed
execution lifetimes. Running a Full control through restrictive prototype filters is not production
Full access and is not an accepted compatibility compromise. Restricted helper mediation applies
only to restricted operations; owner/org restrictions and the cloud container/VM boundary still apply
to Full access.

Restricted operations never write the shared mandatory-deny policy
(`packages/plugin-sdk/src/sandbox-write-denies.ts`; one source for the Linux broker, the native
helper, the device agent and the macOS runtime's patterns): shell startup, git-global, direnv,
npm, editor and agent configuration files; inside any `.git` (including submodule and worktree
gitdirs) everything except git's ordinary internals; a `HEAD` file outside `.git` (a bare
repository lookalike); and moves out of protected names. Known limitations: a restricted command
cannot `git init`, add a submodule or worktree, or create a bare repository; it can forge a
rebase or cherry-pick in progress (git's `rebase-merge/`, `rebase-apply/` and `sequencer/` state is
writable for git's own use), and continuing it (`git rebase --continue`) runs the `exec` lines of
the todo list it wrote, as the owner; on macOS and Linux alike it can leave, inside git's own
internals, a directory shaped like a repository without a configuration of its own (a kept `HEAD`
with git's ordinary entries), which only matters to an owner who runs git from inside `.git`; `git worktree prune` cannot remove
worktree gitdirs and `git branch -D` warns that it cannot remove the branch's config section (both
write what the policy keeps); on macOS a multi-commit cherry-pick or revert reports that it cannot
remove `.git/sequencer` (its commits land; the device removes the empty directory after the
command); files tools execute by convention without
configuration, such as `package.json` scripts run by `npm test`, are not covered, so the owner
reviews such changes before running them unsandboxed. macOS expresses the same policy as ordered Seatbelt
regex rules (a pnpm patch of the sandbox runtime); Seatbelt sees paths, not contents, so a directory
renamed into git's subtrees keeps what it held; directories that hold a `HEAD` git keeps (`logs`,
`refs/remotes/<r>`, `sequencer`, submodule and worktree gitdirs) cannot be moved or removed by a
restricted command, and every write root is matched in each spelling Seatbelt may see (as given,
real on-disk path, `/private` form). Owners are advised to set
`git config --global safe.bareRepository explicit` as defence in depth.

Provider errors add duck-typed `SandboxPermissionUnsupportedError` and `SandboxScopeDeniedError`
with fixed kernel-facing codes. Neither is `SandboxGoneError`: a denial must not recreate the
instance or retry unrestricted. Existing abort, gone, output byte/UTF-8 and timeout semantics stay.

`admitBeforeMs` is the absolute launch-admission deadline, bounded by the request deadline. It does
not shorten a successfully started task's `timeoutMs`. `revokeOperation` is required for permission
support: idempotently persist a trusted operation-ID tombstone, then cancel any matching owned
execution. A delayed launch checks the tombstone and admission deadline before creating processes.
Retain the tombstone at least through `admitBeforeMs` and the owned execution's lifetime; local/cloud
supervisor records survive a kernel restart. This closes stop-before-start races without making tags
credentials. A lost supervisor must fail closed and clean up its exact owned work, never resume it
under reconstructed permissions. Expired scopes cannot start and are never silently refreshed by
the provider; the kernel must resolve new authority.
Every user, browsing and background-start method atomically consumes `(instanceGeneration, operationId)` into a trusted durable record
containing method and canonical input hash before effects. The input hash includes scope and data
digest, excludes transport signal, and must match on a retry. A duplicate returns its recorded
result/reference or `SandboxOperationOutcomeUnknownError`; it never repeats effects. An operation
already consumed may be looked up after its admission deadline; the deadline forbids only a new
consume. A crash between consume and durable completion is unknown, never proof it did not execute.
Unknown outcomes are distinct from gone and must not trigger an automatic new-ID retry. Retain
consumed IDs through the original deadline and terminal records through their advertised retention.

## Native operations and trusted preparation

All six user methods use the same current scope. Retire the device's last-exec write window.
Restricted project roots may be outside the default workspace; the selected root remains writable
under both restricted profiles. Project browsing is a separate owner-authenticated device action
with an explicitly bounded browsing grant; it must not manufacture a conversation or Full consent.
`SandboxOperationAuthority.resolveBrowse({orgId, deviceId, accountId}, signal)` returns
`SandboxBrowseScope` after live device-owner/org checks. `SandboxService.withBrowse` exposes only
stat/list/scan; no synthetic `PROJECTS_HOLDER` conversation participates in authorization. Permitted
roots come from the current owner browsing ceiling (the existing authorized device filesystem reach;
home is a default browse base, not itself a new grant),
not arbitrary client roots. Native scope/race checks still apply. Browsing cannot execute, write,
prepare files, read file contents or select a conversation profile.

Validate lexical paths and resolve existing symlinks within the granted roots. Pin canonical roots
and traverse descriptor-relative components with no-follow protections; new files use pinned
parent descriptors. Never re-open a previously checked attacker-controlled string. Reject a root
or component swap rather than follow it. In-scope symlinks still work. Native helpers must enforce
data scope even where an interpreter/library exception makes the OS sandbox more permissive.
Use the same trusted pinned root descriptors for OS rules (including Landlock), broker metadata
checks and native traversal; reopening the original root pathname at launch is forbidden. Validate
the pinned root's identity rather than constructing independently checked enforcement views.

Preserve exact existing results: read missing/directory → null, truncation at maxBytes; write creates
parents; stat missing → null. Scope denial is an error, not missing. List is code-unit sorted,
bounded, excludes `.`/`..`, follows an in-scope symlink for `isDir` and reports false for dangling or
out-of-scope targets. A missing permitted directory returns null; unreadable/file/denied is an error.
Scan is breadth-first in code-unit path order, base first, depth 2, 500 visited directories including
failed reads, 50 final sorted candidates. It descends past hits and invalid candidate names, skips
symlinks/hidden directories, `node_modules` everywhere and `Library` immediately under base. Denied
descendants are skipped; missing base is []; unreadable/file/denied base is an error. Use the SDK's
existing constants and name validation, not the proof helper's simplified traversal.

`prepare` is reachable only from trusted kernel attachment/skill staging services. Its roots are
derived by those services, never tool arguments. It permits marker reads and file writes solely
inside those roots; no exec, arbitrary network or broad filesystem access. Providers validate
skills roots against their protected skills location and attachments against the designated
conversation subtree. User operations never receive a preparation object, select its purpose, or
inherit its grants. A privileged skills writer applies the same descriptor/race discipline.

## Explicit background supervision

Remove `BACKGROUND_LAUNCH_LINE` as an authority decision. Model text cannot request a privileged
launch by adding a comment. Restricted Linux child code cannot `setsid` itself out of supervision.
Only the trusted launcher creates the owned background session/namespace before restrictions.
This restriction applies to restricted execution. Full execution retains the OS user's existing
daemonization behavior. Managed foreground/background cancellation follows the existing device
contract; it does not promise discovery of arbitrary unregistered malicious double-forks or PID
namespace isolation on macOS. Trusted registered execution identities remain the basis of cleanup.

```ts
export interface SandboxExecutionRef {
  readonly executionId: string;
  readonly operationId: string;
  readonly instanceId: string;
  readonly instanceGeneration: string;
}
export type SandboxExecutionStatus =
  | { state: "running" }
  | { state: "exited"; exitCode: number | null; timedOut: boolean }
  | { state: "lost" };
export type SandboxStopResult =
  | { outcome: "already-exited"; exitCode: number | null; timedOut: boolean }
  | { outcome: "stopped" }
  | { outcome: "cancel-pending" }
  | { outcome: "lost" };
export interface SandboxBackground {
  start(h: SandboxHandle, scope: SandboxOperationScope,
    args: SandboxExecOptions & { taskId: string; outputPath: string; retainUntilMs: number }):
    Promise<SandboxExecutionRef>;
  status(h: SandboxHandle, ref: SandboxExecutionRef, signal: AbortSignal):
    Promise<SandboxExecutionStatus>;
  tail(h: SandboxHandle, ref: SandboxExecutionRef,
    opts: { maxBytes: number; signal: AbortSignal }):
    Promise<{ data: Uint8Array; truncated: boolean } | { unavailable: "lost" | "expired" }>;
  readOutput(h: SandboxHandle, ref: SandboxExecutionRef,
    opts: { offset: number; maxBytes: number; signal: AbortSignal }):
    Promise<{ data: Uint8Array; offset: number; nextOffset: number; totalBytes: number } |
      { unavailable: "lost" | "expired" }>;
  stop(h: SandboxHandle, ref: SandboxExecutionRef,
    opts: { graceMs: number; signal: AbortSignal }): Promise<SandboxStopResult>;
}
```

The provider records exact owned execution identity before acknowledging `start`, retains the
starting filesystem/network policy and proxy endpoint for its whole lifetime, and validates
generation before status/stop. References are opaque locators over authenticated provider/device
transport, not transferable authorization. Scope/root and requested output path are checked before
launch. Start is idempotent for `(instanceGeneration, operationId)` so retry after lost acknowledgement
returns the same reference; it must not launch twice. The trusted supervisor owns output descriptors
and bounded status records. Kernel output retention and task APIs remain unchanged.

Retained output also exposes exact-reference positional `readOutput`, with raw byte offsets,
a snapshot total and at most 65,536 returned bytes including overlap. It uses a provider-owned
append-only spool and preserves the separate ordinary `outputPath` artifact. It accepts no caller
path or new execution scope and never provisions or resumes. Full output is independent of the
foreground result cap and terminal summary lines. The exact byte, failure, durability and retention
rules are in [the retained output design](2026-11-16-retained-background-output-design.md).

Tail is execution-reference-bound, capped at 65,536 bytes, and never follows an arbitrary supplied
path. Tail/status/stop never provision or resume. Preserve UTF-8 boundaries and existing final-line
limits. `retainUntilMs` is the absolute retention deadline derived from launch deadline plus current
`tools.outputRetentionDays`; status/output remain queryable until then without extending lifetime.
Stop atomically claims its terminal outcome: a prior exit yields already-exited (keep completed/failed
classification); a successful stop yields stopped; unreachable/paused work with durable cancellation
obligation yields cancel-pending. On subsequent explicit resume, apply pending revocations before
any task can run; preserve kernel `kill_pending` until acknowledged. Retry returns the same outcome.
Before protocol activation, retire active pre-upgrade SID-only rows: under the existing exclusive
device maintenance lease drain their old tracked work with the old lifecycle, or record a mandatory
instance stop-before-reuse when offline/suspended, then mark rows lost with reason `protocol_upgrade`.
Never convert stored SIDs into new trusted execution references or kill a reused PID by that number.

Background tags are task-owned, distinct from the foreground lease token. Finishing a launch RPC
does not kill a task or release its broker; explicit stop, deadline, actual ceiling revocation and
instance destruction do. Poll/status and stop use the recorded reference under existing task access
checks, not a new profile execution or `pgrep`/`pkill` command. Poll never starts a stopped instance.
On kernel restart another replica can recover the reference. On provider supervision loss it returns
lost, never binds the reference to a reused PID. Profile narrowing alone leaves existing work's
starting grant intact; owner/org ceiling revocation enqueues exact task/foreground cancellations.
Cancel one task while a sibling remains alive is mandatory conformance. Do not use all-user scans
or untrusted stdout PIDs as ownership evidence.

## Device protocol 3 and local authority

Prepare v3 codecs/adapters in Task 6, but activate `DEVICE_PROTOCOL_VERSION = 3` only after Task 8's
background caller cutover and SID retirement/stop-before-reuse tests pass in the coordinated
kernel/device change. Until that gate, the publicly announced wire and active dispatcher remain v2;
staged v3 code cannot receive real traffic. Never publish an intermediate v3 kernel/device pair
with legacy background callers. The first
additive SDK/helper/testing release leaves v2 declarations, parsers and constant unchanged.
On activation v2 connections are refused with an upgrade instruction, with no
compatibility fallback. Keep request/response transport and cancellation IDs. Every exec/readFile/
writeFile/stat/list/scan request gains required `scope: SandboxOperationScope`; obsolete per-call
mode selection disappears. Exec data excludes actor/tag because scope carries them. Local exec and
background-start transport retain a device-private, request-bound `LocalExecAuthority` envelope
with the current org network ceiling and approved `DeviceExecGrants` provenance. The local provider
reads those existing server-owned grant records for each actual call, binds the envelope to the
admitted input hash and sends it over the authenticated device connection. It is not a model input
or a new public SDK method argument. The device intersects its fresh owner baseline plus validated
approved additions with the immutable scope; flattened scope hosts alone cannot identify additions
or revive a removed baseline. Native, browsing and preparation calls grant no network access. All
arguments are bounded/validated before side effects, including canonical path shapes, host syntax,
revision integers and known enum values. TypeScript readonly is not wire validation.

Add `prepareReadFile`, `prepareWriteFile`, `prepareStat` requests with a required preparation scope;
add `browseStat`, `browseList`, `browseScan` with required `SandboxBrowseScope`;
add `backgroundStart`, `backgroundStatus`, `backgroundTail`, `backgroundStop` with the signatures above minus handle
and AbortSignal, plus `revokeOperation` with its operation reference (deadline/cancel remain transport
fields). Hello includes the runtime capability
report, and the machine's independent ceiling:

```ts
export interface DeviceOwnerCeiling {
  readonly revision: string;
  readonly fullAccess: boolean;
  readonly restrictedAllowedDomains: readonly string[];
}
```

The local program intersects every request with its current on-disk owner ceiling, even if the
server's scope is stale. The web can narrow the ceiling and manage already-authorized network
allowances through existing policy operations; it cannot set `fullAccess: true`. Only local owner
configuration grants that. Existing auto → fullAccess true, sandbox → false; unreadable/missing
policy fails closed. Replace public mode choices directly, retaining OS-vs-Docker execution backend
selection as an implementation/deployment detail. No old format aliases before 0.1.0.

`restrictedAllowedDomains` is a restricted-profile allowance, never an unconditional Full egress
limit. Keep separately recorded immutable owner/org/provider environment ceilings authoritative.
Retain `SandboxLimits.mode` only as the internal device-ceiling encoding (`auto` = Full may be
available, `sandbox` = restricted-only); it no longer selects conversation execution behavior.
Lifecycle create/update receives that independent ceiling and the outer `network`, identically
for all profiles. Public configuration replaces mode with explicit Full permission. No per-profile
lifecycle update is permitted. First additive SDK release documents this as the operation-capable
provider contract; legacy behavior changes only during coordinated activation.

| Existing effective authority | Migrated Full permission | Restricted network | Full/outer network |
|---|---|---|---|
| Local owner auto, org/platform permit auto | owner true, effective true | old owner list intersect current org restricted list, plus explicitly granted bounded hosts | existing OS network; old sandbox-only lists do not become new Full limits |
| Local owner sandbox, any org | owner false, effective false | same old intersection, including deny-all when empty | Full unavailable |
| Local owner auto, org/platform forbid auto | owner true, effective false | same old intersection | Full unavailable until independent org permission changes and new consent |
| Cloud effective auto | effective true | approved restricted host allowance intersect outer network | existing open-public outer boundary (or deny-all under existing kill switch); never cloud host/private reach |
| Cloud effective sandbox | effective false | old effective allowlist/open-public intersect approved restricted allowance | preserve old effective outer network, including empty allowlist; Full unavailable |

Migration snapshots the old **effective** cloud policy after platform/org/device intersection,
not merely a stored mode bit. A local auto policy's old sandbox-only allowlist remains restricted-only.
New explicit absolute environment restrictions tighten all profiles; where the local backend cannot
enforce such a ceiling without restricted child filters, Full is unavailable, not mislabeled as Full.
No migration widens a prior restricted ceiling or gives local auto/cloud auto more network reach.
Changes to owner or org ceilings use the admission fencing transaction below, and require fresh
Full consent after widening.

Restricted macOS execution uses one immutable SRT worker per operation, initialized once with only its own proxy endpoint
reachable. Local Linux uses the validated OS runtime where available; if its filesystem/network
requirements fail it reports restricted unavailable. Cloud Docker uses Landlock plus the seccomp
notification broker on unchanged hardening; E2B uses existing namespace primitives when detected.
All implementations provide the same native helper semantics. They never mutate shared proxy policy
to serve a conversation. Runtime capability validation includes architecture/kernel, required syscall
mediation, trusted staging and network ownership, not merely binary presence.

## One shared source bundle

Put the common native filesystem helper and Linux launcher/broker source in
`packages/plugin-sdk/src/sandbox-runtime-source.ts` as immutable source strings plus version and
SHA-256 metadata. Export `SANDBOX_RUNTIME_SOURCE` with `{ version, files: readonly { name, source,
sha256 }[] }`. The SDK performs no filesystem/process/network work and imports no Node runtime;
consumers stage/build/launch it. Device imports only SDK; official plugins consume published SDK.

Delivery is additive: the first bundle contains only the implemented portable native-file helper.
Linux launcher/broker bytes and full permission-conformance exports remain withheld while their
validation gate is held. Passing source packaging and ordinary native API compatibility tests does
not establish restricted execution support for any provider.

Consumer staging verifies version/hash and refuses replacement through a symlink or a writable
ancestor. Cloud images provide root-owned runtime installation, built with their existing Python/GCC
tooling; operation code runs without root. On an owner's laptop, app-private owner-controlled runtime
files are the trust boundary; no new root privilege grant is implied. Providers do not fetch arbitrary
helper code at execution time. Build and distribution tests compare shipped source hashes. A new
shared runtime package would violate current dependency edges, while duplicating the helper would
create diverging enforcement; pure static SDK data is the smaller coherent solution. Provider-specific
SRT/native transport and namespace setup remain outside SDK.

## Kernel facade and admission

Add `PermissionProfilesService` for persisted root state and `SandboxOperationAuthority` for current
grant resolution. `HeldProvider` retains existing exec/read/write/stat/list/scan callback signatures;
its implementation calls the authority service then the factory before **every** method. No memoized
grant per `withSandbox`, holder, run or handle. A stat/read pair may see narrowing between calls.
Fresh resolution also applies after lease waits, approved resume and a gone-instance retry.
Define HeldProvider by an explicit Pick of readFile/writeFile/stat/list/scan plus its existing exec
signature, never `Omit<SandboxProvider,"exec">` or prototype inheritance. Tool callbacks receive no
raw factory, prepare, browse, background or lifecycle mutation methods. Trusted lifecycle/background
code uses dedicated service paths. `guardProviderConnection` wraps returned operation/preparation/
browse methods and nested background methods too; relay preserves denied/unsupported/unknown-outcome
codes, distinct from gone. Entire staging marker read/recheck/write sequences use preparation.

`SandboxOperationAuthority.resolve(ctx, operation, signal): Promise<SandboxOperationScope>` consumes
`SandboxUseContext` and `operation: "exec" | "readFile" | "writeFile" | "stat" | "list" | "scan" |
"backgroundStart"`. It checks root profile/consent, project/device identity, current org/tool/access
ceilings, scheduled trigger and explicit bounded operation grants. Only it creates user scopes.
Provider lifecycle updates continue to apply device resource and outer-network ceilings, never conversation profiles.
`SandboxService.withPreparation(ctx, purpose, roots, fn, signal)` is a distinct internal entry point
for staging; tool context exposes neither it nor the underlying provider.

Task 3 introduces the `permission_authority_epochs` table and the shared foundation in
`sandbox/permission-authority-lock.ts` and `sandbox/permission-authority-epochs.ts`, before profile
updates or first-send use them. Its transaction-only APIs are:

```ts
type AuthoritySubject = { orgId?: string; deviceId?: string; rootConversationId?: string };
type AuthorityEpochVector = { platform: number; org: number|null; device: number|null; root: number|null };
type AuthorityLockIntent = { kind: "admit" } |
  { kind: "write"; level: "platform"|"org"|"device"|"root" };
PermissionAuthorityLock.acquire(subject: AuthoritySubject, intent: AuthorityLockIntent): Promise<void>;
PermissionAuthorityEpochStore.readLocked(subject: AuthoritySubject): Promise<AuthorityEpochVector>;
PermissionAuthorityEpochStore.bumpLocked(kind: "platform"|"org"|"device"|"root",
  id: string, expected: number): Promise<number>;
```

Call these inside the caller's `@Transactional()` method; `acquire` uses the existing XactLock
pattern, `readLocked` creates missing epoch rows idempotently, and `bumpLocked` CAS-fails on stale
revision. Platform's ID is the singleton `platform`. Omitted device/root has no lock/epoch entry.
Only a platform-write may omit orgId; all other intents require a real org, and device/root fields
must match that org. A platform writer takes no fabricated org identity or descendant locks.
An admit/read intent acquires SHARED locks at every present level in platform → org → device → root
order. A write intent takes SHARED ancestors, EXCLUSIVE at its changed level, and no descendants;
thus a root profile change does not globally serialize unrelated reads. `.set` and first-send root
creation use a root-write intent. Org/device/platform ceiling changes name their actual changed
level. Choose intent before acquiring locks: no shared-to-exclusive upgrades. A transaction changing
multiple levels takes exclusive at the highest changed level from the outset; all keys within a
level are sorted. Epoch CAS still requires the matching exclusive writer lock. Shared readers do
not take `FOR UPDATE` on epoch rows; missing-row initialization is an idempotent insert only.
Task 3 uses the real foundation for `.set` and atomic first-send, never a temporary weaker lock.
Task 6 integrates all ceiling writers and operation fencing before product exposure; Task 3 is
independently reviewable but is not an unfenced feature release.

`SandboxOperationIntents` in `sandbox/operation-intents.ts` then owns `sandbox_operation_intents`,
consuming that existing epoch foundation. Each intent persists operationId, subject/account/org/device/root,
method/input hash, scope, provider/version/instance generation, deadline, result/reference or unknown
outcome, and revocation state. States are pending → admitted → dispatching → started-or-unknown →
completed; revoked is terminal for admission and retains any owned cleanup obligation. Pending has
no external effect. Store a bounded payload or a digest-bound existing object-store reference for
write bytes; never put an unbounded file into a queue payload.

`PermissionAuthorityLock` uses those explicit shared/exclusive intents and fixed order (omit root
for browsing). Admission, profile changes and every owner/org/platform ceiling writer use this
same protocol. They re-read authority under those locks and CAS
the recorded epoch vector. Ceiling updates increment their epoch and write revoke outbox rows for
all admitted/dispatching/started-or-unknown affected intents in the same transaction. Thus a racing
admission is either included by revocation or sees the new ceiling. Hot config changes must publish
their authority epoch before the new ceiling is usable; no uncoordinated live-config bypass.

Admission commits the starting grant and a `sandbox-operation-reconcile-<operationId>` outbox
obligation before external effects; that commit is the disclosed operation start point. The existing
run/tool worker then CAS-claims dispatch and calls the provider **inline**, while retaining its own
`SandboxService` shared lease, holder registration, instance generation and combined abort signal.
It checks revocation/deadline, passes the stable operation ID, persists the bounded result, and
returns it directly to its caller. No queue worker inherits or borrows the caller's lease/token;
native file calls are not dispatched through BullMQ. No transaction spans the provider call.

The reconciliation worker handles owed recovery/continuation after a crash, never directly executes
a user method under a stale lease. It uses the existing run/tool execution-claim recovery path:
the recovering run/tool worker must reacquire its own sandbox lease, verify provider/instance
generation and revocation, then reconcile the same ID/hash through the provider's durable record.
A completed result is reused; an unknown result stays unknown, with no new-ID repeat. Pending
continuations are enqueued transactionally. Revoke jobs `sandbox-operation-revoke-<operationId>` persist until
acknowledged, including disconnected providers and cancellation before launch acknowledgement.
Unknown outcomes are reported as unknown and reconciled by recorded identity; the operation is
not repeated automatically. Profile changes invalidate pending
admission but preserve admitted starting grants; actual ceiling revocation covers both admitted
and started work. Foreground/native durable outcomes have bounded storage and expiry at least through
the operation's admission deadline; background records use the longer task retention deadline.

## Root state, API, decisions and replay

Add root conversation profile/revision and Full consent `{deviceId, scopeRevision}`; default to
Approve for me. `scopeRevision` fingerprints stable device identity, approved project/root binding
and owner/org scope, excluding harmless name changes and instance restart. A device switch or scope
widening clears consent and resets to Approve for me; narrowing never widens authority. Children
resolve the root live. Scheduled triggers use existing unattended/task grants, never chat Full access.

`GET /api/v1/orgs/:orgId/conversations/:id/permissions` returns current profile/revision, consent
scope, effective availability/reasons and starting-work notice. Owner-only, `@SessionOnly()`
`PATCH` on that path accepts `{profile, expectedRevision, consentScopeRevision?}`. Full requires the
currently displayed scope revision; stale selection returns conflict. Use exported Zod schemas,
`createZodDto`, owner validation in the service and a human-only Platform exclusion. External-app
tokens, shared viewers, sub-agents and Platform cannot escalate by calling this route.

New-chat consent uses a side-effect-free owner/session GET
`/api/v1/orgs/:orgId/conversation-permission-preview?deviceId=...&project=...` returning
`{deviceId, project: string|null, scopeRevision, availability, fullAccessCeiling}`. `project` uses
the existing device project name rule; no new project-ID public format. No conversation or instance
is created. Add a separate SessionOnly `POST /api/v1/orgs/:orgId/conversations/first-message` with
the existing create body with required `message` (whose `clientMessageId` is already required), plus
`permission: {profile, consentScopeRevision?}`. The UI displays the preview before selection;
Full requires an explicitly selected real `deviceId` and submits that displayed revision; no silent
default substitution. Request approval and Approve for me keep optional `deviceId`: omission uses
existing `ConversationDevices.forNew/defaultFor` resolution, including a null binding when no cloud
provider/local selection exists. Null binding still persists the chosen profile before enqueue;
it does not fall back to the old create endpoint. No-device UI skips preview and disables Full;
the endpoint rejects Full without an explicit real device/consent. A later device binding uses the
ordinary current-authority and consent-reset rules. In one transaction under authority locks, validate current
device/project and consent, create the root with its initial profile, append the message/context and
enqueue the run only after those checks. Stale scope returns conflict without creating or enqueueing.
Reuse the existing `conversations.create_request_id` idempotency owner, add its canonical request
hash, and enforce uniqueness on `(orgId, accountId, clientMessageId)` with resulting root/run;
same-body retries return the same result after a lost reply, different-body reuse conflicts.
All three initial choices govern the first actual operation. Existing Platform/PAT create paths keep
their old schema and default profile, explicitly reject profile/consent fields, and cannot invoke
this SessionOnly endpoint. The existing root PATCH remains the owner path for later changes.

All writes are transactional. Profile changes append old/new profile, actor, device and scope to
event/audit; supersede obsolete pending cards with a conditional update and enqueue re-evaluation
through outbox in the same transaction. Never mark them approved. Late clicks use the same versioned
claim and cannot execute twice; resume rechecks current authority. Queue IDs contain no colon.

The policy order is explicit denies/mandatory asks first, profile execution/review next. Ordinary
in-scope operations bypass discretionary review. Request approval asks for a concrete bounded
extension; Approve for me uses the independent review model, asks if unavailable/uncertain/error,
and never treats a denial as approval. Full bypasses discretionary sensitive-command review,
including credentials/sudo/persistent changes, while keeping OS authorization and explicit denies.
The package.json-reading Python regression belongs in classifier acceptance, not a regex allowlist.

Log effective permission context before model use and render only the recorded event in request
building. Add `permission_profile_changed` to `DriftReason` for the new model-visible dimension;
preserve append-only history and existing zero-drift fixtures. Review records include profile,
revision and decision source (`scope`, `human`, `review-model`, `full-access`, `task-grant`); replay
uses those recorded outcomes and never reads today's permission DB state or calls the reviewer.

## Presentation and release

Use the approved three neutral options in desktop/mobile composers, new/existing chats, with
device → permission → model → effort ordering and equal checkmark treatment. Generic design support
is complete and reviewed in commit `09272da87`, with optional `ComposerBoxProps.pickers.permission?: PickerProps` and
`ComposerOptionsProps.permission?: PickerProps`; application integration consumes it. Remove daily
mode selectors; retain explicit owner ceiling and provider limitations in device connection/details.
All text is bilingual, reads use defineQuery, writes use useAppMutation, and apps/web adds no styles.

The first independently passing core release is additive: operation/browse/background types,
verified helper data and testing exports only; it leaves current wire v2 and consumers intact.
Protocol v3 replacement/activation lands with current kernel/device adapters and verified Task 8
background cutover/upgrade retirement later; preparation alone does not authorize announcement.
Verify npm SDK/testing tarballs and testing's actual published kernel/SDK dependency closure.
Core contract/helper/conformance SDK and testing changes land and publish first. Plugins must then
install the published versions from npm; local file/link/workspace substitutions are forbidden.
Core work can be fully reviewed and downstream changes prepared before requesting concrete
merge/release authorization. Do not call the product complete until local/Docker/E2B actual-provider
conformance, cross-replica races, background lifetime, UI and replay verification all pass.
