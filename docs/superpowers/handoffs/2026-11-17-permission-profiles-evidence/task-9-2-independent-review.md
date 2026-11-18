# Task 9.2 independent source review

- Scope: `git diff 94bc2dddd bbcd3b92d -- . ':!docs/superpowers/handoffs'` (commits 09de26a53, bbcd3b92d), HEAD `bbcd3b92d09ce107a027e5b568ddcb5ab3bc04a0`, worktree clean.
- Contract: `docs/superpowers/specs/2026-11-16-permission-context-replay-design.md` (B1/B5, "Pure rendering and byte contract", "Replay and meaningful drift detection"), plan Gates 9.1/9.2, `task-9-2-brief.md`, AGENTS.md, replay-evals skill.
- Reviewer: independent, read-only (only this file written). Judgment formed from code, not from the author's report.

## Verdict: APPROVE (dormant checkpoint)

No Critical or Important findings. Four Minor findings; M1 and M2 must be closed before any live producer / activation (Gates 9.3–9.5 / 8.6), not before this dormant checkpoint lands.

## Findings

### Critical
None.

### Important
None.

### Minor

**M1. Live `buildModelRequest` still silently renders an unsupported `device_paths` marker as historical text** — `packages/kernel/src/runtime/context/build.ts:906-914`, `runtime/context/device-paths.ts:169-171`, `runtime/context/permission-profile.ts:817-823`.
`assertRecordedPermissionEvents` is only called from `recordedPermissionContextDrift` (replay). Live events are read without a schema parse (`ConversationEventSchema` is checked only on write, `event-log.ts:424`). In build, a `device_paths` payload whose marker is present but `!== 1` (2, null, "1") gets no contribution from `permissionContextHistory`, falls into the `else if (e.type === "device_paths")` branch and `devicePathsText` renders legacy roots/mode text (the same in the summary restore via `devicePathsAt` + `permissionContextVersion !== 1`). A `permission_context` with version 2 instead throws a raw ZodError. Scenario: during a rolling deploy a newer replica writes a v2 marker; an older replica builds the next request and the model receives legacy device-mode text with no "supersedes" line — exactly the fallback the bbcd3b9 docstring says must never happen. Not reachable today (no producer; write validation rejects it). Fix before activation: put the marker guard inside the shared traversal (`permissionContextHistory` throws `RecordedPermissionContextError` for any present marker/version that fails the v1 schema), so build and the original-coordinate checker share one rule as the spec's "identical pure rules" requires, and let the 9.3 callback map it to `run.permission_context_invalid`.

**M2. `RecordedPermissionContextError` is unregistered (author concern) — actual surface is a misclassified eval result, not HTTP 500** — `runtime/context/permission-profile.ts:6-16`, `evals/reconstruct.ts:401`, `evals/worker.ts:124-155,568`.
`reconstructRequest` is reached only through `replayStep`, called only by the eval worker (no synchronous HTTP step-replay route in `src`). There `classify` maps a plain Error to `{ retryable: false, code: "run.provider_error" }`, so a corrupt snapshot ends the case with a non-retryable result error that wrongly blames the provider, after `registry.resolve` and media loading but before any send (no token spend, no retry loop). Full-run replay does not call the checker yet. Judgment: acceptable for the dormant checkpoint (write-side validation plus no producer makes it unreachable from real data), but fix in the gate that wires the full-run checker (9.4) or before activation: register a 4xx code (e.g. `eval.snapshot_invalid` 422, beside `eval.compact_not_replayable`) and throw `ApiError`, or map the class explicitly in `classify` / `isReplayFailure` so whole-run replay records it as a replay failure instead of a crash.

**M3. New `DriftReason` lacks web labels and doc entry** — `apps/web/messages/en.json:~3554`, `apps/web/messages/zh.json:~3542`, `apps/web/test/messages-parity.test.ts:69-85` ("keep in step when a reason is added"), `.agents/skills/replay-evals/SKILL.md` "Existing reasons" list.
The eval inspector falls back to the raw code (`td.has(d) ? td(d) : d`), so nothing breaks, and the brief scoped 9.2 to kernel files. Add zh/en labels (zh without 企业 / Latin `agent`), the parity list entry and the skill line (plus a short `permission_context` paragraph) in the same change that makes the reason reachable.

**M4. Outer-allowlist coverage duplicates `coversHost`** — `conversations/events.ts:217-232` vs `sandbox/modes.ts:45-46`.
The inline predicate equals `coversHost` today (`*.x` covers subdomains, never the apex). A later change to the authority's wildcard semantics would make the schema reject payloads the common resolver produced (no-send) or accept ones it would not. Reuse the shared function (check no import cycle) or pin equality in a test.

Nits (no action required): recorded metadata with `version: 2` yields drift rather than snapshot rejection (reasonable; spec only mandates rejection for event payloads). `reason` strings accept DEL/C1/bidi characters; `Q` follows the spec literally and sanitization is the producer's job. `devicePathsChangeFromPayload` with a legacy payload after a marked latest delegates to the old `devicePathsChange`, which can return null for equal roots and no level — irrelevant once Task 8 never emits legacy payloads on managed routes.

## What I verified

- **Replay invariant / old bytes**: no fixture file in the diff; old `rootsText`/`modeLevelText`/`devicePathsChange`/`devicePathsIdemKey` untouched; legacy branch of the `device_paths` union keeps its non-strict parser (unknown keys still stripped as before; `permissionContextVersion: z.never().optional()` adds no key on output); `devicePathsLevel`/`devicePathsText` dispatch only on marker `=== 1`. The one edit to an existing reconstruct test (`reconstruct.test.ts:2371`) is type narrowing only, expectation unchanged. Zero-drift groups pass (reconstruct 51/51, rename-compat 12/12).
- **Audit events non-model-visible**: `permission_profile_changed`, `permission_reviewed`, approvals have no build case and no transcript line; test asserts no text and no metadata.
- **Strict v1 schema** (`events.ts:46-255`): `.strict()` at every object/variant level; all keys required, nullable-not-optional (null ≠ absent); revision nonnegative safe int ⇔ selectedProfile nullability; uuid IDs (device ids are uuid, migration 0093); revision strings 1..256; reasons 1..1000 non-blank; paths via `validateSandboxPathShape` (controls, `..`, `//`, absolute, ≤4096) plus `posix.normalize` identity and no trailing slash; hosts via `validateAllowHost` (lowercase, no IP/internal) ≤253, 1..100, strictly code-point sorted; directories 1..64 sorted unique. Cross-field: unavailable exact reasons and null device facts, actor-device-access redacts profile/revision; non-unavailable requires all identities; scope ⇔ supported; scheduled ⇒ Request approval; interactive selected Full ⇒ Full or Approve-for-me, otherwise equality; Full ⇔ device+environment, restricted ⇔ scoped+none/allowlist; write ⊆ read, both contain workingRoot; local ⇔ host-environment outer; cloud outer none rejects restricted allowlist, outer allowlist must cover it. Managed paths strict with exactly three roots. Mixed marked+legacy shape rejects (`z.never` + strict). Marker 2/null/"1" and version 2 / unknown keys inside summary-covered superseded events reject in replay (`assertRecordedPermissionEvents` over the whole snapshot; tests cover covered and uncovered cases).
- **Canonical hashing** (`permission-profile.ts:19-43,134-152`): code-point key sort independent of locale/UTF-16; arrays in validated order; undefined, NaN/Infinity, sparse arrays, non-plain objects throw; UTF-8 SHA-256; tuples `["permission_context",1,p]`, `["device_paths",1,p]`, `[1,[[type,text]...]]`; idem `permission_context:v1:<64hex>:<prev>` / `device_paths:permission-v1:<64hex>:<prev>`, predecessor 0 sentinel, nonnegative safe integer enforced. Tests freeze canonical bytes as literals and hash them with an independent `createHash`, cover reordered keys, `` vs `\u{10000}` ordering, null vs omitted.
- **Literal rendering**: line order and every literal match the spec tables; `lines.join("\n")`, no trailing newline; `Q` = JSON.stringify + lowercase `< > &    `; `A` joins with `,`. Nonsupported states render label `unavailable`, exactly one status line (`unverified` only for unprobed) and no scope/policy lines; scheduled policy replaces interactive lines. Managed paths two lines, no grant. Golden matrix covers local/cloud × three profiles × four states as literal strings.
- **Ordering**: normal history renders each v1 event at its seq; after a summary: run context → legacy or managed latest covered paths → latest covered permission context → plugin → project → catalog; later events in order; summary-at-0..5 table for A→B→A; compaction transcript excludes the new event (default branch) — tested with `compactionPlan`; initial system segment unchanged (test compares `request.system`).
- **Metadata**: spread from `ModelCallMeta` into `model_call.request` (`model-call.ts:1853`) and validated strictly on write; absent (never null) when no v1 contribution; contextSeq = latest permission event or null for managed-paths-only; hash over rendered contributions in render order, pre-fit.
- **Drift**: `permission_profile_changed` after `subagent_changed`, before `legacy_event`; checker runs on `inputEvents` = `seq <= min(toSeq, callSeq-1)`, the same events build receives; missing side, invalid meta, hash or locator mismatch → reason once; candidate model/instructions add none (tested); future-locator test proves later events cannot satisfy metadata.
- **No DB/device/current-state reads** in build, `permissionContextHistory`, the checker or reconstruct additions — all pure over passed events.
- **Changeset** present (kernel patch). No SDK/public API change (only existing SDK validators imported).

## Commands and results

```
CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run \
  packages/kernel/test/runtime/permission-context.test.ts \
  packages/kernel/test/evals/reconstruct.test.ts \
  packages/kernel/test/tools/rename-compat.test.ts
# Test Files 3 passed (3); Tests 221 passed (221); exit 0
#   permission-context.test.ts 158/158, reconstruct.test.ts 51/51, rename-compat.test.ts 12/12
npx tsc -p packages/kernel/tsconfig.json --noEmit         # clean
npx tsc -p packages/kernel/test/tsconfig.json --noEmit    # only pre-existing JSX errors in test/fixtures/plugins/ui-components (untouched)
npx biome check <7 changed files>                         # clean
```
