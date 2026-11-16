# Bind confirmation hydration fix

Worktree: `/Users/grant/.codex/worktrees/permission-native-sdk/core`
Branch: `codex/fix-bind-hydration`
Base and current HEAD: `62d1deea7c4406539fb8aaaaa2fcb7a8483a8227`

The reusable SDK verification worktree was clean at `6caebc1b70718f87b222b4054ec37eee73333bca` before creating this branch at the requested main commit. Release refs and release version files were not modified. The web package remains at main's `0.1.0-rc.35`; there is no release-version leakage. No staging, commits, pushes, PRs or merges were performed. Root owns repository verification and outward actions.

## Diagnosis

Release PR316 run43848384319, e2e shard3 job133234569635, failed at `im-channels.spec.ts:132`: the Confirm click completed but binding success never appeared. Nineteen other tests passed. Main62's full CI passing does not disprove this timing window, and the release CI was not blindly rerun.

The bind page receives its pending identity from the server-prefetched query cache, so its heading, warning and buttons are visible before browser JavaScript attaches event handlers. Confirm and Cancel were enabled in this server HTML despite depending entirely on `onClick`. Sign-in intentionally returns through a full document navigation. Login's native form fallback is separate and unchanged. AuthPage has no responsive sidebar, so the test's generic `hydrated(page)` helper would immediately pass and is not used here.

The existing release trace shows Confirm at308738ms, no JavaScript page-error event, no confirmation POST and the same confirmation AuthPage at failure. The server answered the bind document successfully. The code path from that rendered button to its mutation is missing until hydration; this is not a kernel binding rejection.

## Deterministic behavioral evidence

A temporary diagnostic modified only the real fake-IM e2e: immediately before login submission, browser requests for `**/_next/static/**/*.js` were held on an explicit Promise barrier. The test followed the actual signed-out link, login and full return to bind, then performed the original Confirm click while those scripts were still held. It released all scripts in `finally`, with `visitor.unrouteAll({ behavior: "wait" })` waiting for route completion. There were no fixed latency sleeps, new timeouts, retries or network-idle waits.

The original enabled SSR button accepted the click. Diagnostic confirmation POST count was0. Even after the scripts were released, success never appeared through the ordinary30s assertion deadline. This reproduces the CI failure without relying on machine speed.

The final permanent e2e uses the same deterministic barrier to assert that both controls are disabled in the visible SSR page. After releasing scripts it checks that both controls become enabled, no confirmation POST was sent automatically, then performs one actual Confirm click and observes exactly one POST and binding success. The existing real IM reply and account-identities checks still run.

Commands were run from the worktree root:

| Phase | Command | Result | Log |
|---|---|---|---|
| RED SSR contract | `pnpm exec vitest run apps/web/test/bind.test.tsx` | exit1;1failed,8passed; Confirm's actual server-rendered DOM has disabled=false | `/tmp/capybara-bind-hydration-unit-red.log` |
| RED actual lost click | `pnpm --filter @capybara-hq/web e2e im-channels.spec.ts` | exit1;1failed,1passed(1.7m); IM case49.3s; no binding success after original Confirm click and script release | `/tmp/capybara-bind-hydration-e2e-lost-click-red.log` |
| GREEN final SSR/hydration tests | `pnpm exec vitest run apps/web/test/bind.test.tsx` | exit0;9passed(1.30s) | `/tmp/capybara-bind-hydration-unit-green.log` |
| GREEN final real fake-IM flow | `pnpm --filter @capybara-hq/web e2e im-channels.spec.ts` | exit0;2passed(1.1m); IM case22.7s | `/tmp/capybara-bind-hydration-e2e-green.log` |
| Web rules | `pnpm check:web-ui` | exit0; Web UI rules check passed | `/tmp/capybara-bind-hydration-web-ui-check.log` |
| Formatting | `pnpm exec biome check apps/web/src/app/\(auth\)/bind/\[token\]/view.tsx apps/web/test/bind.test.tsx apps/web/e2e/im-channels.spec.ts` | exit0;3files checked, no fixes | tool output |
| Diff whitespace | `git diff --check` | exit0 | tool output |

The e2e runs used the existing global setup, fresh Testcontainers and random-port kernel/Next servers. RED used53705/53706; GREEN used54342/54343. No interactive3000/8080 dev stack was started. Test fixtures and owned processes were stopped by global cleanup. The only test-run warning was the existing NO_COLOR/FORCE_COLOR warning.

## Final implementation

Four files change:

- `apps/web/src/app/(auth)/bind/[token]/view.tsx`: a local `useSyncExternalStore` read returns false for SSR and the first hydration render, then true in the browser. Confirm is disabled until that point. Cancel is disabled until then or while confirmation is pending. Confirm's existing loading state continues to disable the button during its mutation. Query, mutation, ownership, account invalidation, user-consent, retry and redirect behavior are unchanged. No design-private import or new public design/app helper API was added.
- `apps/web/test/bind.test.tsx`: real renderToString→hydrateRoot regression checks the disabled server DOM, hydration with no recoverable errors, enabled browser controls, no automatic API calls, one actual-click POST, disabled controls during the pending response, and no duplicate POST from a second click. Existing cancellation, session-expiry, identity-taken and cache-invalidation tests all pass.
- `apps/web/e2e/im-channels.spec.ts`: the permanent script-barrier readiness assertions described above; existing real identity binding, IM conversation and identities coverage remains. The edited title and comments are English.
- `.changeset/bind-confirmation-hydration.md`: patch changeset for the web/image app packages (`@capybara-hq/web`, `@capybara-hq/capybara`). No package-version files are changed.

## Frozen review artifacts

Exact diff including the untracked changeset: `/tmp/capybara-bind-hydration-review.diff`

Manifest: `/tmp/capybara-bind-hydration-review.json`, including base, current HEAD, each file SHA-256, diff SHA-256 and commands/results.

Frozen final-file copies: `/tmp/capybara-bind-hydration-final/`

Original and diagnostic sources:

- `/tmp/capybara-bind-view-original.tsx`
- `/tmp/capybara-bind-original.test.tsx`
- `/tmp/capybara-bind-unit-red.test.tsx`
- `/tmp/capybara-bind-im-channels-original.spec.ts`
- `/tmp/capybara-bind-im-channels-lost-click.spec.ts`

Retained proof:

- `/tmp/capybara-bind-hydration-lost-click-red-results/` (error context and trace)
- `/tmp/capybara-bind-hydration-lost-click-red-stack-logs/`
- `/tmp/capybara-bind-hydration-green-stack-logs/`
- Existing release artifacts remain under `/tmp/capybara-release316-6ca-e2e-artifact/`; job log `/tmp/capybara-release316-6ca-e2e3-job.log`.

## Boundaries, risks and remaining gate

The fix is limited to binding consent controls. No SDK, kernel, login/native-form, layout, styles, live configuration, feature worktree or held Linux proof was touched. The new readiness state does not confirm anything and makes no API call. With JavaScript unavailable the JS-dependent controls remain disabled. Existing browser rendering paths enable them immediately when handlers are attached.

The macOS real-stack and SSR regressions are green. Linux CI and root's frontier review remain required. `pnpm verify` is deliberately left to root before push under the bounded assignment; no broad full suite or source build was run. Focused passing tests are not a substitute for that repository gate.

Frozen diff SHA-256: `149258572604b7163752354fde97afbec7dd910af4774855264ecbd6b738de9c`

## Validation integration follow-up 1

The first required root verification found only the existing Next page-props TS2344 contract failure. The accepted four binding files remain byte-identical. A separately frozen mechanical delta corrects seven outer page parameter defaults and three direct-call arguments in roles.test.tsx. Normal Next typechecking and165existing role/page/bind tests now pass. Delta report: `/tmp/capybara-bind-validation-fix-1-report.md`; diff: `/tmp/capybara-bind-validation-fix-1-review.diff`; manifest: `/tmp/capybara-bind-validation-fix-1-review.json`. Root still owns the full required gate rerun.
