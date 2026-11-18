# Validation integration delta 1

Branch/worktree: `codex/fix-bind-hydration` at `/Users/grant/.codex/worktrees/permission-native-sdk/core`, HEAD `62d1deea7c4406539fb8aaaaa2fcb7a8483a8227`.

Root's required verification returned exit1 (`/tmp/capybara-bind-hydration-verify.json`): lint, custom checks, commitlint and affected tests passed; typecheck alone failed. The generated Next development guard `.next/dev/types/app/(app)/extensions/page.ts:42` rejected the page's first-argument type because the outer `= {}` default makes it include `undefined`. Next passes a props object. PR318 already corrected the same contract on the agents server entry.

## Exact delta

Seven server entries remove only their outer parameter default: `} = {}) {` becomes `}) {`. Their `searchParams?` member stays optional, and all query parsing, default tabs, filters, cookie reads and returned views stay byte-for-byte unchanged:

- `apps/web/src/app/(app)/extensions/page.tsx`
- `apps/web/src/app/(app)/evals/new/page.tsx`
- `apps/web/src/app/(app)/admin/models/page.tsx`
- `apps/web/src/app/(app)/schedules/page.tsx`
- `apps/web/src/app/(app)/admin/inbox/page.tsx`
- `apps/web/src/app/(app)/settings/models/page.tsx`
- `apps/web/src/app/(app)/admin/extensions/page.tsx`

`apps/web/test/roles.test.tsx` changes only three direct-call arguments to model the real framework contract: `NewEvalSetPage()`→`NewEvalSetPage({})`, `ExtensionsPage()`→`ExtensionsPage({})`, and `ModelsSettingsPage()`→`ModelsSettingsPage({})`. `ModelsSettingsPage` is the local alias importing settings/models/page. No role cases, assertions, titles or expected behavior changed. `pages.test.tsx` needed no caller change and is untouched.

The accepted original four binding files were compared by SHA-256 before and after and remain byte-identical. The existing generated development guard is also byte-identical; no guard, tsconfig include/exclude, Next validation, framework dependency or source-building command was modified. No new checker or mirror test was introduced.

## Evidence

- RED: `pnpm --filter @capybara-hq/web typecheck`, exit1, normal `next typegen && tsc --noEmit -p .`; exact TS2344 reproduced against the unchanged development PageProps guard. Log: `/tmp/capybara-bind-validation-fix-1-typecheck-red.log`.
- GREEN: same normal typecheck command, exit0; types generated and TypeScript passes. Log: `/tmp/capybara-bind-validation-fix-1-typecheck-green.log`.
- `pnpm exec vitest run apps/web/test/roles.test.tsx apps/web/test/pages.test.tsx apps/web/test/bind.test.tsx`, exit0;165passed in3files,1.64s. Log: `/tmp/capybara-bind-validation-fix-1-regressions.log`.
- Earlier independent `pnpm exec vitest run apps/web/test/pages.test.tsx apps/web/test/bind.test.tsx`, exit0;38passed. Log: `/tmp/capybara-bind-validation-fix-1-pages-bind.log`.
- `pnpm exec biome check` with exactly the eight delta paths, exit0;8files checked, no fixes. Log: `/tmp/capybara-bind-validation-fix-1-biome.log`.
- `git diff --check`, exit0.

## Frozen review material

- Before snapshots: `/tmp/capybara-bind-validation-fix-1-before/`
- Before manifest (including accepted Bind and generated guard hashes): `/tmp/capybara-bind-validation-fix-1-before.json`
- After snapshots: `/tmp/capybara-bind-validation-fix-1-after/`
- Exact eight-path validation diff: `/tmp/capybara-bind-validation-fix-1-review.diff`
- Before/after hashes, aliases, accepted four-file invariants and command receipts: `/tmp/capybara-bind-validation-fix-1-review.json`

The original binding fix's scope and release changeset remain unchanged. These mechanical server signatures enforce the actual Next entry contract and do not alter the page data or rendered behavior. No services, builds, broad suite, timeouts/retries, Git index operations, commits or pushes were performed during this validation delta. Root owns the independent delta review and full required verification rerun.

Validation delta SHA-256: `4343a7a6313bc8c8dfa1e50ef95c2094ae6fed91c608b9d87cbf7e05c00509e4`
