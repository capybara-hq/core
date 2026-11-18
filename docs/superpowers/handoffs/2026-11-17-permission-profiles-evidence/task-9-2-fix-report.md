# Task 9.2 fix — raw snapshot validation, legacy matrix, boundary normalization, Biome cleanup

Worktree `/Users/grant/Capybara/core/.claude/worktrees/docs-conversation-permission-profiles`, branch
`docs/conversation-permission-profiles`, base HEAD `f3c8e1402` (9.2 code at `09de26a53`). Scope limited to
the three listed items; no producers, recorder, runtime wiring, migrations, SDK change or activation.

## Files changed

- `packages/kernel/src/runtime/context/permission-profile.ts`: new `RecordedPermissionContextError` and
  `assertRecordedPermissionEvents(events)`: every `permission_context` and every `device_paths` whose
  payload has a present `permissionContextVersion` must pass its strict v1 schema, covered by a summary
  or not, in or out of the request range. Unmarked historical paths are not inspected.
- `packages/kernel/src/evals/reconstruct.ts`: `recordedPermissionContextDrift` (called first by
  `reconstructRequest`, before `assembleModelRequest`) runs that validation on the whole cast snapshot.
- `packages/kernel/src/conversations/events.ts`: `PermissionPath` (v1 schemas only) additionally requires
  the authority's exact spelling: `posix.normalize(p) === p` and no trailing slash (except `/`).
- `packages/kernel/test/runtime/permission-context.test.ts`: new raw-snapshot cases, legacy literal/idem
  matrix, boundary normalization cases, warning cleanup.

The changeset `.changeset/dormant-recorded-permission-context.md` (kernel patch) already covers this.

## RED (behavioral, new assertions; the error class existed so imports succeeded)

1. `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run packages/kernel/test/runtime/permission-context.test.ts -t "raw snapshot|unmarked historical"`
   — **8 failed | 1 passed | 107 skipped (116)**. Every failure: `AssertionError: expected function to
   throw an error, but it didn't` (each case first asserts zero drift before mutation, which passed):
   - uncovered legacy path with marker 2; uncovered managed path with marker 2 / null / "1";
   - covered superseded permission_context with version 2 / unknown key;
   - covered superseded managed path with marker 2; latest covered managed path with marker 2
     (previously restored as legacy "This device's directories ..." text).
   Log: `task-9-2-fix-red.log`.
2. Boundary: same file, full run — **8 failed | 150 passed (158)**, all `expected true to be false`:
   dot segment / nested dot / trailing slash in readable and writable directories and working root,
   managed working root `/project/` and `/./project`. Log: `task-9-2-fix-red-boundary.log`.
   The new legacy matrix (13 rows) passed against the 09de26a53 code before and after: it asserts the
   bytes and keys generated from the base commit `94bc2dddd` `device-paths.ts` (preservation proof, not RED).

## GREEN

- Targeted: same `-t` command — **9 passed | 107 skipped**. Log `task-9-2-fix-green-targeted.log`.
- Final: `CAPYBARA_TEST_WORKERS=2 CAPYBARA_TEST_CONTAINER_STARTS=2 pnpm exec vitest run packages/kernel/test/runtime/permission-context.test.ts packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts`
  — **3 files, 221/221 passed, exit 0, 51.87 s** (158 pure + 51 reconstruct + 12 rename; containers
  started, Docker available). Log `task-9-2-fix-final-tests.log`.
- `pnpm typecheck` — exit 0 (tsc -b, tsconfig.test.json, web). Log `task-9-2-fix-typecheck.log`.
- Scoped noEmit: evidence `task-9-2-source-tsconfig.json` with paths rewritten to this worktree — exit 0.
  The test config needed `@capybara-hq/kernel` mapped to `packages/kernel/src/index.ts` (no kernel `dist`
  in this worktree; without it only `packages/testing` failed to resolve the kernel) and now also includes
  `rename-compat.test.ts` — exit 0. Configs in the scratchpad, not committed.
- `pnpm exec biome check` on the 7 Task 9.2 TS files — **0 errors, 0 warnings**. Log `task-9-2-fix-biome.log`.
- `pnpm check` — **All checks passed**. Log `task-9-2-fix-check.log`.
- `git diff --check` — clean.

## Coverage added

- Raw snapshot: 8 rejection cases above + unmarked historical tier/isolation path still reconstructs with
  zero drift, no metadata, legacy text.
- Legacy matrix (13 rows: roots-only, strict, strict unattended, dev without/with local facts, open container,
  open without sandbox, network off, tier without isolation, auto local, sandbox local, cloud public, cloud
  allowlist): exact text, `devicePathsIdemKey` at predecessors 0 and 7 (base digests), `devicePathsChange`
  key, `devicePathsChangeFromPayload` delegating identically, unchanged → null, schema parse, `build` text
  with no `permissionContext` metadata. Audit-only profile/review/approval events: no text, no metadata,
  unchanged `systemHash`.
- Boundaries: accepted at the bound — 64 roots, 100 hosts, 253-char host, 4096-char working root, max safe
  revision, 256-char revisions, 1000-char reason, wildcard outer covering nested hosts, exact outer = host,
  restricted hosts under open-public outer, Full cloud behind outer none. Rejected — the normalization cases,
  empty segment, 254-char host, wildcard used for its bare apex, restricted wildcard wider than an exact
  outer host, host with port, IP literal, empty outer allowlist; managed roots/working root with
  `/project/`, `/./project`, `/a/../project`, `//project`.
- Warnings: all 26 removed (non-null assertions replaced by throwing helpers `scopeOf`, `scopedFs`,
  `literalLines`, `eventAt`, `callOf`, `metaOf`; `any` mutator table retyped to `PermissionContextV1` with
  `Object.assign` / `Reflect.deleteProperty` for invalid shapes; comma expression split; unused imports
  dropped). Assertions unchanged.

## Historical fixture hash proof

All 7 files in `task-9-2-historical-fixtures.json` match both the recorded SHA-256 and `git show 94bc2dddd:<path>`
("ALL MATCH"). Log `task-9-2-fix-fixture-hashes.log`. `git diff HEAD -- packages/kernel/test/evals/fixtures` empty.

## Remaining limitations

- `RecordedPermissionContextError` is a plain typed error, not a registered `ApiError` code: an HTTP step
  replay of a corrupt snapshot surfaces as an internal error / failed eval case. A dedicated code
  (errors.ts + web i18n) was out of this task's file scope.
- Validation runs in `recordedPermissionContextDrift` / `reconstructRequest`; other `toEvents` consumers
  (trajectory view, `snapshotMediaRefs`, `loadSnapshotMedia`, worker template lookup) render nothing from
  these events and were left unchanged. The live `buildModelRequest` path trusts the event log schema.
- Request metadata with an unsupported version still reports `permission_profile_changed` drift (existing
  spec'd behavior), it does not throw.
- Not run: full `pnpm verify`, independent source review, Linux confinement proof (blocked; not attempted).
