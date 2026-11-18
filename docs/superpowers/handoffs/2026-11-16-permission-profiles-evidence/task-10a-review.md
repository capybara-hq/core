# Task 10A independent source review

Verdict: **spec PASS; code-quality PASS for the authorized dormant HTTP/query foundation.**
No blocking or actionable source findings. This accepts the bounded source slice, not integrated
permission UI, runtime activation, or a full-green combined verification gate.

Reviewed 2026-11-16 in
`/Users/grant/Capybara/core/.claude/worktrees/fix-project-context-notice`, branch
`codex/permission-web-data`, declared base `55979ebb89fe1a7bd730e5f5c854d0b6e9b1af1f`.
Reviewed the complete frozen report, nine-file manifest and exact patch
`bdb35b7ab70839b7582befc0f1eab97000518e4b6f131ddf3b43ed8e3281fe24`.
The controller independently verified the frozen hashes; this review did not mutate or re-create
the patch, manifest or index.

## Requirements and source bindings

Read the primary `task-10a-brief.md` first, the Slice A preflight/plan requirements and builder
review/amendments, the full `writing-web-ui` skill, web AGENTS, and relevant installed Next
server/client and router guidance. The narrower brief governs this slice. The ninth file,
`apps/web/test/conversation-project.test.tsx`, is the controller-authorized explicit preview
fixture only. No behavior from later slices was demanded or inferred.

- **Owner authorization:** `apps/web/src/lib/query/conversation.ts:452` requires a known session
  account and equality with the authoritative conversation row. It does not inherit the adjacent
  legacy undefined-owner skills fallback. `apps/web/src/lib/query/routes.ts:769` obtains the row
  from the completed conversation query and supplies `me?.account.id`. No other production
  permission-query caller or observer exists. Actual route tests at
  `apps/web/test/conversation-cache.test.tsx:639` assert zero owner HTTP calls for viewers and
  unknown owners; helper cases at line 614 also cover unknown session and both unknown.
- **Child/schedule semantics:** the read remains addressed to the viewed conversation, and the
  returned root ID is preserved, not fabricated. The child case at
  `apps/web/test/conversation-cache.test.tsx:660` asserts no extra root read. The scheduled case
  at line 680 retains the allowed owner GET. This matches `PermissionProfilesService.get` and
  `PermissionProfileStore.readOwnedRoot`; only `setLocked` rejects child/noninteractive/scheduled
  editing. No PATCH caller was activated.
- **HTTP contract:** `apps/web/src/lib/permissions.ts:4` mirrors the actual profile/selection,
  runtime report, direct preview and direct effective-view shapes. Bound to the existing
  permission controller/schemas, `PermissionFacts.scope/view`, availability type and SDK report
  definition by read-only inspection. Lines 51–82 encode identifiers and project, retain optional
  consent only as supplied, forward AbortSignal and return only `{ revision }` from PATCH.
  Existing `apiFetch` preserves JSON, CSRF, session transport and cancellation. No client roots,
  inferred reviewer configuration, or invented authority endpoint appears.
- **Cache/session isolation:** `apps/web/src/lib/query/keys.ts:59` and line 430 place previews below
  the explicit org/device preview prefix and views below org/conversation. Project is part of the
  preview key. `apps/web/src/lib/query/permissions.ts:6` and line 14 are hook-free, live-freshness
  definitions forwarding query signals. Existing per-request server clients and
  `apps/web/src/lib/query/workspace.ts:73` cancellation/clear-before-navigation remain the account
  isolation boundary; shell org-switch, cross-tab account change and logout actually use it.
  No new global or persistent state bypasses that boundary.
- **Selected device and no-device path:** `apps/web/src/lib/query/routes.ts:737` uses the same
  `chosenDeviceId` as the composer, returns before preview when absent, and requests metadata
  after the selected device's projects. The initial project is free mode, consistent with
  `useDeviceChoice`'s initial state. This does not provision a device or introduce a Full-specific
  default. Selected-device and unusable/no-device HTTP cases are explicit in
  `apps/web/test/conversation-permissions.test.tsx:158` and line 194.
- **Truthful state and tests:** fixtures distinguish runtime availability from independent ceiling,
  preserve null no-device facts and revision zero, and first-send seeding leaves the permission
  key absent (test line 215). Controlled-query cases cover pending/error, retained authoritative
  data after failed refresh, and cancellation of obsolete reads without fabricated permission
  data. Shared fixture additions are exact routes, not permissive transport fallbacks.

## Verification assessment and required remaining gate

The supplied report records the genuine pre-implementation owner-prefetch RED (zero requests versus
one expected), separately identifies later mutation regression REDs, and accurately records final
61 focused tests, 459 tests across 27 actual fixture-consumer files, Biome on nine files and
`check:web-ui` passing. Source inspection supports the scope of those assertions. These are reported
runs, not reruns by this reviewer; no tests, services, builds, Git operations, subagents or outward
posts were performed in this review. Only this review artifact was written.

Normal web typecheck is **not PASS**: the report records the inherited #318 agents PageProps guard
failure and says the new fixture type errors were corrected. The controller's separately reviewed
#318 source fix must be integrated, followed by the normal unweakened web typecheck as a required
combined gate. This review neither waives that gate nor requests a generated-guard exclusion.
No additional type issue was identified by source inspection.

The failed-hydration test at `apps/web/test/conversation-cache.test.tsx:596` proves error dehydration
and absence of a product first-paint request while no permission observer is mounted. The isolated
observer at `apps/web/test/conversation-permissions.test.tsx:223` proves successful hydration and
explicit query lifecycles; it is not an implementation of owner gating or hydrated-error retry
suppression for a future control. Later production observers must apply strict ownership/device
enablement and `retryOnMountOf`, and test their actual failed-hydration mount. This is an explicit
later-slice boundary, not a defect in the dormant foundation.

Revision watermark/monotonic confirmation, child root subscriptions, client selection invalidation,
first-send serialization, permission controls and runtime/provider acceptance remain later gates.
Their absence here is consistent with the brief and is not presented as shipped behavior.
