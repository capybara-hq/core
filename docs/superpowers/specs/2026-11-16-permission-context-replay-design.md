# Recorded permission context and replay contract

Status: technically accepted on 2026-11-16 after B1–B5 correction review. Source implementation and paired activation remain separately gated. Accepted Task 7 source is ce94b4d2bd0f0e35e3cb5f413406cab5441ee237; controller combined foundation is55979ebb89fe1a7bd730e5f5c854d0b6e9b1af1f. Task 8 technical contract is accepted; its physical binding producer is not yet implemented.

Task 8 fix-round-1 contract has technical GO: handoff SHA-256 `ed0b8e01f4e28ed9646d7703f8ae63206b44c9a728b25c69529f2fd7359b4c52`, plan SHA-256 `10519e7d7f53395d5ededa42b1220b80ab9a9ad9ec10fb9bc42222379da6a080`. Its B6 shared context writer remains gated on this Task 9 contract's independent acceptance. These are accepted planning dependencies, not implemented Task 8 APIs or support proof.

## Scope and source anchors

This implements the approved profile design's model-context/replay requirement. It introduces no profile selector, permission grant, scheduled Full opt-in, helper protocol, provider proof or external permission policy.

| Existing seam at the inspected source | Consequence |
| --- | --- |
| `runtime/run-context.service.ts:88,102`; `run-worker.ts:804` | Run context is recorded once per run under the conversation row lock. Keep it; it cannot be the sole permission producer. Do not acquire new authority after its row lock. |
| `runtime/model-call.ts:575` (`runStep`), `:1602` (attempt loop), `:1680–1881` | The actual request can retry/fall back or compact within one step. Refresh permission context for each request construction, including wrap-up and a retry, after any compaction that precedes that construction. |
| `runtime/run-steps.ts:52–96`, `runtime/runtime.module.ts` | Inject the live recorder through `RunSteps.deps`, with one Nest provider. |
| `runtime/context/build.ts:811,819,896,901,1011` | Add ordered normal rendering, restoration after a summary, and request metadata. `systemHash` hashes the separate system segment; it does not cover these history messages. |
| `conversations/events.ts:418` | Existing `permission_profile_changed` is already logged by initialization/transitions and was never model-visible. Never start rendering it. |
| `tools/builtins/sandbox/common.ts:recordDevicePaths` (823), `:722` | Current writer emits old mode/network facts. Task 8 must switch the managed route to the exact new payload writer before activation. |
| `evals/recorded-tools.ts:187,293` | Both recording extraction and insertion currently reconstruct paths via `devicePathsLevel`; this would lose a new marker. Preserve the full new payload. |
| `evals/run-replay.ts:513,679,751`; `evals/worker.ts:293` | Run-start copy and per-step absorbable feeding do not replay per-attempt permission context. Add a recorded-only request feeder and explicitly remove the live recorder from copied loop dependencies. |

## Versioned logged values

Choose a small concrete v1 schema, not a deployment manifest/version inference. Kernel-private types/schemas live in `conversations/events.ts`; pure rendering helpers live in `runtime/context/permission-profile.ts`. Reuse SDK `PermissionProfile` and the already accepted bounded path/host validators. The following names are proposed new interfaces, not assertions that they exist today.

```ts
type PermissionContextV1 = {
  version: 1;
  rootConversationId: string;
  profileRevision: number | null;
  selectedProfile: PermissionProfile | null;
  effectiveProfile: PermissionProfile | null;
  execution: "interactive" | "scheduled";
  inherited: boolean;
  deviceId: string | null;
  scopeRevision: string | null;
  authorityRevision: string | null;
  availability:
    | { state: "supported" }
    | { state: "unsupported" | "unprobed"; reason: string }
    | { state: "unavailable"; cause: "no-device" | "actor-device-access"; reason: string };
  scope: null | {
    location: "local" | "cloud";
    workingRoot: string;
    filesystem:
      | { kind: "scoped"; readDirectories: string[]; writeDirectories: string[] }
      | { kind: "device" };
    network:
      | { kind: "none" }
      | { kind: "allowlist"; hosts: string[] }
      | { kind: "environment" };
    outerNetwork:
      | { kind: "host-environment" }
      | { kind: "none" }
      | { kind: "allowlist"; hosts: string[] }
      | { kind: "open-public" };
  };
};
// New event name, written only by the new recorder:
// permission_context { payload: PermissionContextV1 }

type ManagedDevicePathsV1 = {
  permissionContextVersion: 1;
  deviceId: string;
  roots: { workspace: string; skills: string; tmp: string };
  workingRoot: string;
};
// New strict branch of the existing device_paths payload union.
// It has no mode, allowedMode, tier, isolation, network or unattended fields.

type PermissionContextMetaV1 = {
  version: 1;
  contextSeq: number | null;
  hash: string;
};
// Optional model_call.request.permissionContext and ModelCallMeta.permissionContext.
```

IDs: existing UUID/ID validators; revisions: nonnegative safe integers; opaque revision strings: nonempty, at most 256 characters; reasons: English, nonempty, at most 1,000 characters after safe diagnostic sanitization. Paths: absolute, at most 4,096 characters; union of read/write roots: at most 64; hosts: at most 100, with accepted authority normalization. Arrays are normalized/deduplicated/sorted by the authority reader, never truncated into a different grant. Hash is lowercase SHA-256. New branches reject unknown keys. Historical event parsing retains its existing permissiveness and optional fields; absent markers are never defaulted to 1.

`scope` describes the base authority for *new* operations, not an admitted operation or a reusable grant. It excludes call-specific Task 7 expansion grants and operation IDs. Scheduled explicit task network grants may contribute only through the actual scheduled run's existing resolver; their scope cannot be inferred from the root chat or a prior review. Native operations still receive no network capability even when the context describes exec networking.

### Profile-specific availability and field projection (B1)

Resolve authenticated actor, accessible root, actual run and effective profile through the common admission base-facts extraction first. Its accepted extraction point is `SandboxOperationAuthority.snapshot` at ce94b4d2: factor the call-independent actor/root/run/view/working/base-host portion; leave assistant-call/start-event/grant checks in their existing callers. `PermissionFacts.view` selects the consent-valid effective profile; actual unattended root/run classification overrides it to Request approval. Do not invoke the method with fabricated call IDs. Missing/inactive actor, inaccessible conversation/ancestor, run/account mismatch or malformed persisted state is a no-send failure (B2), not an unavailable device notice. A valid run actor who cannot use the owner's selected device receives the explicit access branch below.

Apply this ordered table after base identity checks. The complete report is read by the existing persisted identity verifier; its coarse `supported` (either profile supported) is never copied directly to context:

| Condition | Effective profile and availability | Logged scope |
| --- | --- | --- |
| No selected device | effective null; unavailable/no-device | null |
| Valid actor/run but no device-use authority, including nonowner attempting owner Full | effective null; unavailable/actor-device-access | null; redact owner state as below |
| Provider factory/support/revoke contract absent or current report explicitly unsupported | shared effective profile retained; unsupported | null |
| Missing/stale report identity, uninstalled Task 8 binding, or applied outer boundary unknown | shared effective profile retained; unprobed | null |
| Effective Request approval or Approve for me; current report has all four restricted flags true | supported, subject to known applied facts | base restricted scope |
| Effective Request approval or Approve for me; restricted is null even if fullAccess=true | unsupported; never switch to Full | null |
| Effective Full; current report fullAccess=true, independent Full ceiling and matching consent remain valid | supported, subject to known applied facts | device/environment scope |
| Effective Full; current report fullAccess=false even if restricted exists | unsupported; no automatic alternative | null |

Current report validation rejects malformed flags/version; absence is unprobed, not supported. If `view` already changes stale Full consent to Approve for me, evaluate **that restricted profile** in this table, including the Full-only-runtime unsupported result. A scheduled root/child/wake always evaluates Request approval, even on a Full-only runtime. `background` and optional list/scan support remain in method-specific tool availability/results; this general context proves no optional method. No context read provisions, probes, resumes, prepares or calls a provider. Unknown applied outer facts take precedence over a positive capability report. Missing contract/explicit unsupported report remains unsupported even when outer facts are unknown.

Field rules are exact. For no-device, retain only accessible root `selectedProfile`/`profileRevision`, root ID and execution/inherited flags; effectiveProfile/deviceId/scopeRevision/authorityRevision/scope are null. For actor-device-access, also set selectedProfile/profileRevision to null; root ID and execution/inherited flags remain from the already authorized conversation, every device/scope/revision field is null. For supported/unsupported/unprobed, actor/device access succeeded: selected/effective profiles, numeric revision, deviceId, current semantic scopeRevision and current authorityRevision are required non-null. If these cannot be established due corruption/storage/publication failure, fail no-send instead of a catch-all default. Unsupported/unprobed always have scope null: v1 deliberately omits requested roots/network rather than inventing installed authority. There is no requested-scope rendering branch. No-device reason is exactly `Choose a device to run device operations`; access reason exactly `This run's actor cannot use the selected device`.

| Scope field | Sole source shared with admission |
| --- | --- |
| workingRoot | Validated root project binding (`projectMatches`) and accepted snapshot workingRoot; otherwise actual stored/held instance workspace, never unverified default as installed scope |
| filesystem roots | Accepted snapshot baseReadDirectories/baseWriteDirectories; write roots also readable; no Task 7 call expansion |
| network | Restricted snapshot baseHosts after existing owner/org ceiling intersection and `NetworkGrants.forExec({orgId,deviceId,runId})`; this preserves explicit scheduled task grants using the actual run. Empty → none. Full → environment only after ceiling/consent checks |
| location | Authenticated device row source, local versus cloud |
| outerNetwork | Shared applied-environment projection described next, not desired policy or a newly queried provider |

Add a kernel-private `PermissionFacts.readAppliedEnvironmentLocked({orgId,deviceId}): Promise<null | {location:"local"|"cloud"; instanceId:string; instanceGeneration:string; bindingId:string; roots:SandboxRoots; outerNetwork:NonNullable<PermissionContextV1["scope"]>["outerNetwork"]}>`, consumed by the common admission/context base-facts reader. This is a Task 8 B3/B6 fact adapter owned below runtime, not a new policy algorithm or public API. It verifies the **installed** binding ID, current instance created_at/generation/provider/handle, runtime identity and applied environment against Task 8's accepted bind/attestation records. For local, actual host-environment is the outer boundary (restricted rules are the operation network field); do not turn local Full's restricted-domain/egress:none setting into outer network-off. For cloud, use actual verified provider environment/instance applied limits and the boundary attested for that exact binding. A pending desired change, unapplied record, missing attestation, stale generation or suspended instance without current applied evidence returns null. Do not project future desired policy as installed. Existing `readInstanceLimits`/applied state and the accepted Task 8 binding/attestation adapter supply the evidence; if they cannot prove the installed outer boundary, emit unprobed/null scope. Runtime identity checks use the same accepted `readRuntimeReport` joins and Task 8 installed-binding constraints as admission. Adapter storage names follow Task 8's accepted implementation when bound; it may not add independent grants or change the accepted owner-ceiling API.

The scalar `authorityRevision` is the accepted hash of scope revision and current authority vector, including restricted-only changes. It is not a helper manifest version. Actual helper identity remains in the runtime-report machinery owned by Task 8; a context read neither manufactures it nor advertises Linux support.

## Live facts and writer contract

Add the following shared no-effect projection to the accepted Task 7 authority service:

```ts
type PermissionContextSubject = {
  orgId: string; conversationId: string; runId: string; accountId: string;
};
// SandboxOperationAuthority: mandatory transaction, complete authority subject already held.
readContextLocked(input: PermissionContextSubject,
  signal: AbortSignal): Promise<PermissionContextV1>;

// runtime/permission-context.service.ts, provided in RuntimeModule.
record(input: PermissionContextSubject,
  signal: AbortSignal): Promise<void>;
// private @Transactional method, called by record under the ordered prelude:
appendLocked(input: PermissionContextSubject,
  signal: AbortSignal): Promise<number | null>;

// ModelStepDeps, populated by live RunSteps and replaced explicitly by replay:
permissionContext?: {
  beforeRequest(input: Pick<ModelStepInput,
    "orgId" | "conversationId" | "runId" | "accountId" | "step" | "signal"> &
    { attempt: number }): Promise<void>;
};
```

The shared projection factors `snapshot` as described in B1; it does not invoke `previewCall` with a fabricated call ID, create an operation, look up an expansion without a call binding, or invoke a reviewer. Task 7 acceptance is closed; the new extraction is independently reviewed against ce94b4d2 and the combined baseline so it cannot alter accepted admission semantics. Device/task/network policy projection belongs below runtime and is shared with actual admission.

`record` requires a real `currentExecutionClaim()` matching org/run/conversation/root; missing/mismatched claim refuses, including in unit fixtures that would otherwise hide broken wiring. Initial no-lock discovery finds root and device, then installs `withTransactionFencePrelude(() => locks.acquire(subject, {kind:"admit"}), () => appendLocked(...))`. With no device the complete subject is platform/org/root. The transaction enters authority locks in platform → org → device (if present) → root order, then the inherited `RunExecution.withClaim` fence locks org/root/calling conversation and checks persisted `execution_id` and liveness. The recorder also explicitly compares the current claim's execution ID with the run row, so calling it outside the inherited wrapper cannot become an unfenced write.

Inside that transaction: `publication.assertCurrent()`, re-read root/device/ancestor membership and actual `runs.trigger_account_id`, `scheduled_task_run_id`, conversation and running status; verify the discovered subject still matches; read the shared context projection; take the calling conversation row lock (already held under the real fence); compare latest `permission_context`; append via `EventLog.appendIn` only if different. A changed binding during discovery retries the whole context read once after releasing the transaction; exhausted churn terminates this run with the named actionable no-send error below. It never enters provider fallback or adds another authority subject under existing locks. This is no execution/effect retry. Abort/replaced claim/terminal run writes nothing and follows the explicit error table.

Canonical payload hash plus previous event seq is the idem identity: `permission_context:v1:<sha256>:<previousSeq>`. A→B→A produces three events; two replicas cannot both append from one predecessor under the conversation lock. Notify only after commit, as a lossy hint. No new queue/outbox obligation is needed for this synchronous context append. Do not call `runOutsideTransaction`, replace the inherited fence, change TransactionHost, or hold any transaction across provider/hook/reviewer I/O.

The model-facing snapshot is linearized at this transaction's commit. A profile change after that boundary cannot rewrite the request already being prepared/sent; the next construction sees it. This is informative context, never execution authority: the subsequent tool operation separately resolves current authority. Do not promise that a prompt snapshot authorizes tools until the response ends.

### Request callback control flow (B2)

At the beginning of the existing `fit` closure (`model-call.ts:1720`), **only if permissionContext is present**, await `beforeRequest` with the declared fields and attempt, then assign `evs = await readAllEvents(...)`. Capture that complete ordered list once, then call existing loadMedia/buildRequest/fit. If dependency absent, make neither callback nor reread: keep the exact previous `evs` and old construction path. This is essential for dormant/old byte preservation. The second fit after forced compaction repeats this whole boundary. `absorbedUpToSeq` stays fixed for the step; `toSeq` is the captured list's last seq, never a later database maximum. Tool-result pairing, media outcomes, hard-fit planning, hooks, appendWithSpecs and streaming stay in their existing order. A profile change during model.request hook processing leaves this already-built request unchanged and appears at the next fit construction.

Use a small internal `PermissionContextBeforeRequestError` with `kind: "publication-stale"|"binding-churn"|"storage-unavailable"|"invalid-context"|"actor-unavailable"`; the callback/refresh adapter maps known failures to it and never classifies them as provider errors. No new HTTP permission API is implied. The model-attempt catch must check `ExecutionRevoked` **first, before signal.aborted**, and rethrow the identical object. Then preserve StepAborted/signal cancellation; then convert PermissionContextBeforeRequestError to the corresponding RunError below before `classify`. RunError already bypasses provider classification. `runStep` only consumes StepAborted; LangGraphLoop rethrows these errors; RunWorker's existing ExecutionRevoked branch must receive the original object. Its existing RunError terminal path handles the named failures without a new retry queue.

| Outcome | Handling before any send |
| --- | --- |
| successful recorded/deduped snapshot | reread once and build from captured list |
| execution claim revoked/replaced, run ended/deleted | original ExecutionRevoked through ladder/loop to RunWorker; zero stale terminal write |
| ordinary user/shutdown abort | existing StepAborted path; if write fence is revoked, ExecutionRevoked still wins |
| publication-stale | RunError `run.permission_context_stale`: `Permission configuration changed. Wait for configuration activation, then retry this run.` |
| subject changed once | rediscover once outside transaction; no callback/effect/model retry |
| subject changed twice | RunError `run.permission_context_changed`: `The device binding changed while preparing this request. Retry the run after the binding settles.` |
| storage failure in recorder or its complete-log refresh | RunError `run.permission_context_unavailable`: `Permission context could not be read or recorded. Retry this run when storage is available.` |
| invalid schema/inconsistent fields or unexpected recorder exception | RunError `run.permission_context_invalid`: `Permission context is invalid. Ask an administrator to inspect the run before retrying.`; log sanitized cause, no fallback/default |
| missing/inactive actor or inaccessible run/conversation | RunError `run.permission_context_actor_unavailable`: `This run's actor is no longer authorized. Start a new run with an authorized account.` |

The adapter catches only callback+complete-log-refresh failures; loadMedia retains its existing MediaUnavailable behavior. If claim revocation can be recognized in the failure, preserve it before all mapping. Access to the selected device alone is the logged unavailable branch in B1; loss of run/conversation authority is this no-send branch. A failed recorder/refresh never builds from old `evs`. Failure statuses/messages are recorded through existing RunError handling; these codes are private run errors, not new permission endpoints.

Live callback invocation is **not** idempotent by run/step/attempt: two fit builds in one attempt may append A then B after compaction. Only normalized payload plus preceding event seq dedupes snapshots. Unchanged facts append nothing. Completed-step reuse makes no new request/context. The real production path remains RunWorker → RunExecution.withClaim → RunSteps/LangGraphLoop → model-call; tests must exercise that wrapper and ordered inherited fence. An execution-ID equality read is an additional check, never a substitute for its serialized PG claim/root/liveness checks. No TransactionHost extension or fence-clearing wrapper is introduced.

Compaction, title, review and web-extraction model calls do not gain a permission instruction; their separate requests do not consume this permission context. The requirement here is every agent-history model request, including a request rebuilt after compaction. Manual compaction continues excluding this event from its transcript.

Children read the current root for every request and write a snapshot into their own log (`inherited:true`), never consult the parent's model history for authority. Scheduled classification is root scheduled binding **or actual run's** `scheduled_task_run_id`, including children/wakes; use existing explicit task grants and no discretionary reviewer/human expansion. Nonowner triggers remain able to receive an ordinary model reply if existing run policy permits it, with an unavailable device context and no owner scope leakage.

## Pure rendering and byte contract

Proposed exact helpers:

```ts
permissionContextAt(events: readonly ConversationEvent[], seq: number):
  Extract<ConversationEvent, {type:"permission_context"}> | undefined;
permissionContextText(payload: PermissionContextV1): string;
permissionContextHash(payload: PermissionContextV1): string;
permissionContextMeta(events: readonly ConversationEvent[],
  contributions: readonly {type:"permission_context"|"device_paths"; text:string}[]):
  PermissionContextMetaV1 | undefined;
managedDevicePathsText(payload: ManagedDevicePathsV1): string;
devicePathsChangeFromPayload(latest: {seq:number; payload:DevicePathsPayload} | undefined,
  payload: DevicePathsPayload, runId?: string): AppendEvent | null;
```

Normal history renders each `permission_context` as a system message at its ordered event position. Payloads are complete snapshots, not patches. No changes to the initial system segment. After a summary: existing full run context, latest device paths, **latest permission context at coversUpToSeq**, then existing plugin/project/catalog restoration. Render newer events normally. Exclude permission context from compaction transcript, just as paths/run context are excluded. No extra line when no new event exists. `permission_profile_changed`, `permission_reviewed`, approval records and `ReviewRecord` remain display/audit-only.

### Complete v1 schema and byte freeze (B5)

Validate before rendering or hashing. Every key in the type is required (including explicit null fields); discriminated variants contain exactly their listed keys, never undefined or extra keys. `profileRevision` null iff selectedProfile null. Unavailable/null rules are exactly B1; all other states require non-null selected/effective profiles, revision and device/scope/authority IDs. `scope` is non-null **iff supported**. Unsupported/unprobed must have a reason and null scope; unavailable must have its cause and reason. Supported must have neither cause nor reason. This version has no requested-but-unverified scope: omit all scope lines for every nonsupported state.

For non-null effective profile: scheduled implies Request approval; interactive selected Request/Approve implies the same effective profile; interactive selected Full permits effective Full or the shared consent fallback Approve for me. No restricted→Full or Full→Request interactive coercion. Supported Full requires filesystem=device and network=environment; supported restricted requires filesystem=scoped and network=none or allowlist. Scoped write roots are a subset of read roots, both contain workingRoot, and the combined root/host caps apply. Empty allowlist is invalid (normalize to none at the producer); arrays must be unique and sorted by Unicode code point and conform to the same authority normalizers. Local outerNetwork must be host-environment; cloud outerNetwork must be none/allowlist/open-public, never host-environment. A cloud outer none with restricted allowlist is inconsistent and rejects; a cloud restricted allowlist must already satisfy the applied outer ceiling through the common resolver. Full cloud environment remains subject to the separately recorded outer boundary, including none. No optional-method capability is inferred. All violations reject new-event validation; never repair malformed supported data into usable defaults. Historical variants keep their existing parser unchanged.

Let `Q(s)` be ECMAScript `JSON.stringify(s)` followed by replacing literal `<`, `>`, `&`, U+2028 and U+2029 with lowercase `\u003c`, `\u003e`, `\u0026`, `\u2028`, `\u2029`. Standard JSON escapes already cover quote, backslash and C0 controls; no NFC or whitespace transformation. Let `A(xs)` be `[` + xs.map(Q).join(`,`) + `]`. Rendering never sorts or normalizes validated payloads. For example, Q of the characters `a`, quote, newline, `<` produces the literal bytes `"a\"\n\u003c"` inside the text; no literal newline is introduced by an interpolated value.

Permission text is `lines.join("\n")` with no leading/trailing newline or blank lines. Line order is exactly:

1. `Permission context for new operations: LABEL.` LABEL is Request approval / Approve for me / Full access from effectiveProfile **only for supported**; every nonsupported state uses `unavailable`.
2. `This context supersedes earlier device-mode descriptions for new operations.`
3. If supported, emit all applicable scope lines below in order, then exactly one policy line. Otherwise emit exactly the status line below and no scope/policy lines.
4. `Changes apply to new operations. Work already started keeps its starting permissions. Actual owner or organization revocation may still stop affected work.`

| Ordered supported scope branch | Complete literal line(s); braces mean substitution, not literal braces |
| --- | --- |
| all supported, first scope line | `Working directory: {Q(scope.workingRoot)}.` |
| filesystem scoped | `Readable directories: {A(readDirectories)}.` then `Writable directories: {A(writeDirectories)}.` |
| filesystem device, local | `Filesystem: this device as the existing OS user; no additional OS privileges.` |
| filesystem device, cloud | `Filesystem: the provisioned device environment as its existing OS user; no additional OS privileges.` |
| network none | `Network: no destinations are authorized for new commands.` |
| network allowlist | `Network: new commands may reach only these authorized hosts: {A(hosts)}.` |
| network environment, local Full | `Network: the host environment; restricted-profile host lists do not restrict Full access.` |
| network environment, cloud Full | `Network: the provisioned environment, subject to its outer network boundary.` |
| outerNetwork host-environment | `Outer network boundary: the host environment.` |
| outerNetwork none | `Outer network boundary: network access is disabled.` |
| outerNetwork allowlist | `Outer network boundary: allowed hosts {A(hosts)}.` |
| outerNetwork open-public | `Outer network boundary: public addresses only.` |

| Policy/status branch | Complete literal line |
| --- | --- |
| supported scheduled (replaces all interactive policy lines) | `Scheduled run: only the unattended policy and explicit task grants apply; interactive approvals and chat Full access do not apply.` |
| supported interactive Request | `Extra filesystem or network scope requires the person's approval.` |
| supported interactive Approve | `A separate reviewer may approve eligible extra scope; uncertainty asks the person.` |
| supported interactive Full | `No discretionary command approval; explicit policy, device-owner limits and OS permissions still apply.` |
| unprobed, any location/effective profile | `Device operations are unverified: {Q(reason)}.` |
| unsupported or unavailable, any location/effective profile | `Device operations are unavailable: {Q(reason)}.` |

This table is exhaustive for local/cloud × restricted/Full × supported/unprobed/unsupported/unavailable: nonsupported branches have no logged location/scope and the same four lines regardless of previously selected profile; supported branches select exactly one filesystem, one exec-network, one outer-network and one policy row. No root IDs, revisions, inherited flag or selected-profile extra line is rendered. Starting-work text is a general rule, not a guessed list of running tasks; Task 8 supplies actual task notices only through recorded tool/finish results.

Managed paths text is exactly two lines joined by one LF, without trailing LF: `Device directories: workspace {Q(workspace)}, skills {Q(skills)}, temporary files {Q(tmp)}.` then `Selected working directory: {Q(workingRoot)}. These paths do not grant access; the current permission context governs new operations.` This preserves the accepted two-line wording and grants nothing. Managed payload has only its required four fields (marker, deviceId, roots, workingRoot; roots has exactly three fields), all paths validated.

Canonical hashes use a new pure `canonicalPermissionJson`: recursively serialize objects with keys sorted by Unicode code point, arrays in their validated order, strings/numbers/null via standard ECMAScript JSON.stringify, no spacing/newline/BOM; encode UTF-8. Undefined, non-finite numbers and omitted required/null fields reject. Do not reuse the authority helper's locale-dependent key comparator or change its existing hashes. Payload hash is SHA-256 of canonical JSON `["permission_context",1,payload]`; managed hash uses `["device_paths",1,payload]`. Metadata hash uses `[1,contributions.map(({type,text}) => [type,text])]`, with rendered contribution order retained. Reordered input object keys hash identically; normalized arrays hash identically; unnormalized new arrays reject instead of being silently rearranged. Hashing uses the payload's actual nulls; null differs from absent. Every predecessor sentinel is integer **0** when no latest event exists; otherwise its positive seq, rendered as base-10 without padding. Permission idem is `permission_context:v1:<full lowercase 64-hex hash>:<previousSeq>`; managed idem is `device_paths:permission-v1:<full lowercase 64-hex hash>:<previousSeq>`. `model_call.request.permissionContext` is entirely absent without new contributions/markers; it is never null. Its contextSeq is null only when marked managed paths exist but no permission event is visible. Old idem helpers and their hashes remain unchanged.

The old `rootsText`, `modeLevelText`, `sandboxLevelText`, missing-level behavior and old `devicePathsChange` comparisons/idempotency remain byte-for-byte. Dispatch `devicePathsText` to the managed renderer only for the explicit marker. Retain all historical tier/isolation branches. Old logs with audit profile events alone get no new text, metadata, synthetic default profile, drift or changed `systemHash`. Existing fixtures are immutable. An old device-path message can remain in the append-only historical prefix after activation; the new permission snapshot expressly supersedes its meaning for future operations. Do not suppress or rewrite it retroactively.

## Task 8 exact common.ts handoff and atomic activation

Task 9 owns new payload schema, both pure renderers, payload comparison helper, transactional event recorder and replay copier. Task 8 owns `common.ts` physical fact acquisition/call-site switching and the held-instance evidence producer. Freeze this complete private contract before shared edits (B3):

```ts
// Kernel-private, not a new SDK or model-visible shape.
type HeldDeviceContextEvidence = {
  deviceId: string; provider: string;
  instanceId: string; instanceGeneration: string; bindingId: string;
  roots: SandboxRoots; workingRoot: string;
};
// New sandbox/managed-device-context.ts provider.
class ManagedDeviceContextRecorder {
  record(input: PermissionContextSubject,
    held: Readonly<HeldDeviceContextEvidence>, signal: AbortSignal): Promise<void>;
  // Private @Transactional method, exactly one transaction per record attempt.
  appendLocked(input: PermissionContextSubject,
    held: Readonly<HeldDeviceContextEvidence>, signal: AbortSignal): Promise<number | null>;
}
// New required managed dependency; no EventLog-shaped optional substitute.
type ManagedDeviceContextPort = Pick<ManagedDeviceContextRecorder,"record">;
// SandboxToolDeps adds managedDeviceContext?: ManagedDeviceContextPort while dormant;
// activated managed routes narrow/validate it to required before entering callbacks.
recordManagedDevicePaths(
  deps: { managedDeviceContext: ManagedDeviceContextPort },
  ctx: BuiltinCallContext, held: Readonly<HeldDeviceContextEvidence>,
): Promise<void>; // a thin delegator, not a transaction owner
```

Provide/export the recorder once from new `ManagedDeviceContextModule` under sandbox, importing EventLogModule, PermissionProfileStoreModule, PermissionAuthorityModule and OperationAuthorityModule (export the needed PermissionFacts adapter there). It injects KernelDb, TransactionHost, EventLog (`appendIn`/`notify`), PermissionProfileStore, PermissionAuthorityLock, PermissionConfigPublication and the common facts reader with explicit @Inject. ToolsModule imports this leaf module; BuiltinTools injects the recorder and puts it into the `SandboxToolDeps` object used by common.ts. No RuntimeModule import, EventLog permission methods, late setter or factory service. Pure payload/change helpers contain no Nest dependency. This adds a lower event writer, not another permission-context publisher.

Task 8 extends the **kernel-private** SandboxUseInfo/operation-entry evidence (currently roots and entered instance createdAt are available inside SandboxService) with `contextEvidence: HeldDeviceContextEvidence`. Populate once under the already held lifecycle/shared lease, after the exact installed binding is validated: deviceId/provider from the entered provider row, instanceId from that held handle.id, instanceGeneration from the accepted generation allocator's exact stored created_at milliseconds string, bindingId from the installed binding row, roots from that handle, workingRoot from the common accepted project/base-facts resolution. Do not reread only current device ID after entering or accept these values from a model/tool input. No process/global evidence cache. Existing holder signal is combined with ctx.signal; lost lease prevents recording. Task 8 B3's installed binding/generation contract is the identity authority; absence of that evidence makes the managed path unavailable, not a roots-only fallback. Cloud facts must supply the corresponding installed provider binding evidence too before activation.

At managed entry, assert the injected recorder exists **before** any user/preparation callback. After entering the actual held instance, call it before any preparation/user callback and before its eventual result; then run that callback once. The recorder begins outside a transaction, discovers complete subject, installs authority-before-inherited-real-claim withTransactionFencePrelude, then opens appendLocked. Inside: publication.assertCurrent; actual run/actor/root/claim validation; compare current device binding, provider, handle.id, generation and installed bindingId with the held evidence; compare roots with the canonical held handle roots and workingRoot with shared base facts. All comparisons happen under complete authority locks before latest-event read, with the real inherited fence serializing the conversation. Then read latest device_paths, full-payload compare and appendIn in that same transaction. afterCommit notify is a lossy hint; a notification failure never replays append or callback.

If discovery/subject/incarnation/evidence differs, throw a typed private `ManagedDeviceContextStale` before the user callback, return an actionable tool error (`Device context changed before this operation. Retry the tool call.`), and run no whole-handler automatic retry. Do not invoke provisioning, add another authority subject, reexecute an effect, or use a new operation identity to repair logging. ExecutionRevoked retains its identity; storage/invalid-evidence failures fail the call before its callback. Independent ordinary fresh user tool calls may resolve anew. Root/device strings with identical paths cannot satisfy a changed bindingId/generation. An incarnation replacement with identical roots that passes a **new** held entry does not require a new model event if its entire model-visible payload is unchanged; validation and dedupe are distinct.

The activated managed route may not silently skip recording when legacy `latestOfType` is absent. EventLog's old optional test seam stays only on unactivated legacy paths; new tests inject the real recorder or an explicit managed port. Preserve actual child's conversation/run as destination. Managed equality includes device ID, all roots, working root and marker; old→marked appends even for identical roots, A→B→A remains distinct, and the exact B5 managed idem key uses predecessor 0 initially. Do not use devicePathsLevel to reconstruct a managed payload.

Task 8 must not emit the old mode payload on *any* activated operation route, including foreground/native/skills/attachments/background paths that use common.ts. Task 9 must not emit v1 operative permission claims while all production calls still execute the legacy route. Proposed activation is one coordinated code cutover with Task 8 phase 8.6: dormant recorder/renderers may land first, but production `RunSteps` wiring and all managed common.ts producers become active together on the paired kernel/device release. The existing staged route is a test-only/dormant binding until then; no new public feature flag. If Task 8 cannot activate, Task 9 must be reported as dormant infrastructure, not completed delivery. Future supported/unprobed facts still describe truthfully unavailable operations after activation.

## Replay and meaningful drift detection

Metadata is needed because `systemHash` does not hash history. During pure build, collect the ordered *rendered* v1 permission and managed-path contributions (restored messages included, covered messages excluded). If neither marker/event exists, omit permissionContext metadata. Otherwise set `contextSeq` to latest permission event seq or null, and hash canonical `[1, contributions.map(({type,text}) => [type,text])]` using SHA-256. Keep this pre-hard-fit, like existing request metadata; the recorded `fit` separately determines sent bytes. A managed path without a permission event still has metadata and is detectable; live wiring tests require a permission context before its next request.

Add `permission_profile_changed` to `DriftReason` and `DRIFT_ORDER` immediately after `subagent_changed`, before `legacy_event`. Meaning: the request explicitly records v1 permission context, but the snapshot cannot reproduce its recorded permission contribution or active event locator. In `reconstructRequest`, after `assembleModelRequest`, compare recorded and rebuilt permission metadata when either is present; missing side, version/hash/locator mismatch adds the reason once. Old logs with neither have none. A normal profile transition is recorded input and produces **zero drift**. Changed current DB policy or candidate instructions/model do not themselves count: there is no permission override option and replay never selects today's permissions. Unsupported future schema versions reject snapshot validation rather than silently rendering v1.

Test actual missing/edited v1 event, altered managed path, invalid locator and missing required marker, plus unchanged baseline and audit-only old logs. Deleting an event must not trigger a live authority fallback. `system_hash` may independently flag a changed system prompt, but does not substitute for this reason. Full-run replay validates the original request metadata with the same pure checker and adds any such recorded-context defects to its result drift; it does not compare generated event seqs against original seqs.

### Sparse attempts and coordinate spaces (B4)

Add `recordedPermissionContext(snapshot, eventLog): ModelStepDeps["permissionContext"]` in `evals/recorded-permission-context.ts`. Let R be the original target run's run_started.seq. Existing seed copies exactly events with seq **< R**, preserving seq, and creates generated run_started at R. Do not copy original model_call rows for the target run or reappend seeded permission events; original pre-R model_call rows already in historical seed retain existing behavior. The feeder considers only `permission_context` with target runId and seq>R. Later-run events and unconsumed target-run context never leak into a generated request.

Build original request records `C=(step,attempt,callSeq,U)` with `U=min(request.toSeq,callSeq-1)`, ordered by source callSeq. Attempts come from actual logged payload numbers, not array indexes; missing legacy attempt uses the same recorded request attempt fallback already used by replay (1 if absent). Duplicate (step,attempt) or backward/inconsistent step/attempt order rejects invalid v1 replay input. A source context event's first visibility is the first such C whose U>=event.seq; without one it is never fed. Do not collapse multiple A/B snapshots before one call: both are fed in source seq order. In particular a pre/post-compaction live fit can log A and B before the only sent call, and the generated boundary receives both.

For generated `(s,a)`, choose an original C by this table; within a step attempts are sorted numerically. The chosen source visibility boundary is U; retain the maximum previously consumed boundary to make feeding monotone. No selected C means no new source boundary.

| Generated coordinate against original | Selected original C |
| --- | --- |
| exact same-step attempt exists | that attempt |
| a falls in an interior same-step gap | greatest recorded same-step attempt < a |
| a precedes the first recorded attempt in that same step | **first recorded attempt in that step** (explicit policy: the first actually sent request supplies the initial context; e.g. original attempt 2 feeds generated attempt 1) |
| a exceeds last recorded attempt in same step | last attempt of that step |
| step s has no original request | last request in greatest original step < s; never use a later step |
| s precedes every original request step | none, retain seeded history only |
| s exceeds every original request step | final original request |
| original run has no recorded agent request | none for every generated coordinate; seed only |

At chosen boundary, append not-yet-fed eligible target-run events with seq<=the monotone U in increasing source seq, before generated fit builds. This makes the before-first same-step choice deliberate while forbidding future-step selection. Source events still must have a first-visible original request at or before the chosen source visibility progression; verify this using original callSeq order, so a malformed/nonmonotone toSeq cannot introduce unseen context merely through numeric max. For valid logs, captured event ranges are append-only; reject backward U in v1 input instead of inventing new visibility. Same generated boundary reentry feeds nothing additional; the **live** callback remains payload-based, as B2 states.

Persistent feed identity is `replay_permission_context:<generatedRunId>:<originalEventSeq>`. Copy only payload, set generated runId, and let EventLog allocate generated seq. On each reentry read existing events for these idem keys (or the appendIn conflict-return lookup) and recover mapping originalSeq→generatedSeq; method-local maps are accelerators, not durable truth. Seeded originalSeq maps to the identical seed seq and is never appended again. Generated metadata always locates generated events and hashes generated rendered contributions. Original seqs are source identities only. Crash recovery already recreates the eval conversation; reused callback state cannot retain mappings for a prior generated run.

Original diagnostics run independently over **each original model_call**, using only `events.filter(seq<=min(toSeq,callSeq-1))`, its recorded absorption state, the same pure summary selection/restoration logic and recorded request metadata. Refactor the permission-contribution traversal used by build so both original diagnostics and generated build use the identical pure rules. Compare original locator/hash in original coordinates; a locator outside U, missing event, altered contribution or recorded-vs-rebuilt metadata mismatch yields permission_profile_changed. Do not satisfy a locator from later events. Do not compare original hash against candidate-generated/compacted history or generated locators against original numbers. Candidate compaction/model/instructions alone adds no permission drift; generated calls simply record their own metadata. No original context markers and no original metadata means no diagnostic drift. Malformed unsupported schema version fails snapshot validation, not a live-authority lookup.

When the original recording has no v1 permission or managed-path marker, return **undefined** rather than install a no-op feeder, so B2's absent-callback path preserves old request ranges. A marked recording installs a recorded-only feeder even if no target-run event is eligible (prior-run seed context still applies). Empty/no-request recordings do not fabricate a default. Finishing early consumes no future context; extra steps retain last recorded context, never today's policy.

`run-replay.ts` passes this feeder through the extended `RunReplayDeps.loop` dependency type. `evals/worker.ts` destructures the live `permissionContext` out alongside hooks/progress/forks, then overlays the recorded feeder. Add a fail-closed guard in the live recorder against eval conversations and tests that throw if it is invoked. Step replay goes directly through pure reconstruction and needs no feeder.

`recordedCalls` preserves an entire managed `device_paths` payload; `RecordedToolPipeline` inserts it via `devicePathsChangeFromPayload`. Old payloads still use the old change semantics. Add `review?: ReviewRecord` (the exported type in conversations/events.ts) to RecordedCall and its result accumulator. When an original tool_result has review, structured-copy that exact validated object into the recording; on a matched replay result copy it verbatim to `tool_result.payload.review`. Include all accepted Task 7 profile/profileRevision/scopeRevision/decisionSource fields and old fields. Preserve absence (no `{}`/null/default review); unmatched results have no review. Review remains out of matching keys, content, compaction and permission-context metadata. No original approval/review/grant effect is reenacted and no new permission_reviewed event is invented. Review outcomes come from recorded tool results; no previewCall, reviewer, admission, task control, runtime probe or provider operation is called by replay.

## Remaining freeze decisions

1. Task 7 source/wire acceptance is bound and closed at ce94b4d2. Independently review the new single shared read extraction against it and the combined 55979ebb baseline; no moving worktree shape is authoritative.
2. Controller and independent builder accept this v1 schema, text, metadata semantics and request-boundary timing. This is an implementation contract decision, not a new user/product decision.
3. Task 8's accepted handoff remains frozen; B6 waits for this corrected exact recorder/evidence/fact contract and its independent acceptance. Serialize common.ts, shared authority extraction and event schema edits. Task 9 changes no owner-ceiling API. These two Task 9 proposal files plus independent acceptance report and SHA-256 manifest are mandatory before shared-writer edits. No independent Task 8 model-text publisher is authorized.
4. Root uses combined 55979ebb as the current baseline and rebinds any subsequent integration before implementation. Run required before/after tests during implementation; none were run for this docs correction.
