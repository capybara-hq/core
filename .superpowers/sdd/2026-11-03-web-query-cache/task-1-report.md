# Task 1 spike: BLOCKED

Spike not run. The e2e stack (global-setup) started a kernel and containers, then launched `next dev` for apps/web, which refused:

    ⨯ Another next dev server is already running.
    - Local:        http://localhost:3000
    - PID:          69036
    - Dir:          .../worktrees/fix-rc2-acceptance/apps/web
    - Log:          .next/dev/logs/next-development.log

Cause: Next 16 allows one `next dev` per project dir (lock in apps/web/.next/dev), and the user's dev web (PID 69036) runs in this same worktree dir, so the e2e web server cannot start regardless of port. Not stopped, per ruling.

Second issue (independent): global-setup's `register("data:text/javascript,...")` fails under Playwright 1.64.1 + Node 24.11.0 with
"TypeError: Expected a string, an ArrayBuffer, or a TypedArray to be returned for the \"source\" from the \"load\" hook but got null" (ERR_INVALID_RETURN_PROPERTY_VALUE). Worked around temporarily by removing register and passing NODE_OPTIONS=--conditions=@capybara-hq/source (reverted).

Options: (a) run the spike from a different worktree/copy of apps/web (separate .next dir; e.g. a fresh `pnpm wt:new spike` worktree) while the dev stack keeps running; (b) user stops dev web for a few minutes; (c) set a distDir override for e2e (changes global-setup/next config, not minimal).

Prepared (discarded on revert): layout.tsx logging with appendFileSync + headers rsc/next-router-prefetch; spec using clicks where an anchor exists and window.next.router.push/refresh otherwise (filter param is `agentId`, not `agent`).

git status: clean (layout.tsx and global-setup.ts reverted, spec deleted).

# Addendum: spike run in worktree chore/layout-spike (removed afterwards)

Setup: e2e stack (kernel :57425, `next dev` web :57426), Google Chrome via `channel: "chrome"` (temp config edit; the Playwright chromium download stalled), global-setup `register()` removed, `NODE_OPTIONS=--conditions=@capybara-hq/source`. Layout logged each render with path + rsc / next-router-prefetch / next-router-segment-prefetch / next-url headers. Navigation count and prefetch count were both 0 per step.

| Step | Layout renders (navigation / prefetch) | Re-ran? |
|---|---|---|
| 0 document request /agents | 1 for /agents (sign-in/setup documents before it logged 4 more, not counted) | n/a (initial) |
| 1 click link /agents -> /agents/<id> | 0 / 0 | no |
| 2 click link -> /chat/<id> (a link existed) | 0 / 0 | no |
| 3a /trajectories (router.push; no link found) | 0 / 0 | no |
| 3 /trajectories?agentId=A (router.push) | 0 / 0 | no |
| 4 /trajectories?agentId=B (router.push) | 0 / 0 | no |
| 5 /settings/organization (router.push) | 0 / 0 | no |
| 6 router.refresh() (window.next.router.refresh()) | 1 (path /settings/organization) | YES, exactly once |

Caveats:
- Dev mode: `next dev` does not do link prefetching, so the prefetch count is 0 by construction; production prefetch of dynamic routes was NOT measured (global-setup always runs next dev). Needs a prod build (`next build` + server.mjs) to confirm.
- Every render line had rsc=null prefetch=null (also the refresh), so the headers do not reach the layout (proxy strips or Next hides them); header-based classification is unusable. Only the counts are reliable.
- Steps 3a-5 and the refresh used window.next.router.push/refresh (equivalent to useRouter); steps 1-2 were real link clicks. Refresh was not triggered through a real save.

## Reproducing the global-setup register() failure
Command: `cd apps/web && pnpm exec playwright test <any spec>` (also `pnpm --filter @capybara-hq/web e2e`), Node v24.11.0, Playwright 1.64.1. Error at global setup (stack through playwright/lib/common/index.js `load` hook, node customization_hooks validateLoad):
`TypeError: Expected a string, an ArrayBuffer, or a TypedArray to be returned for the "source" from the "load" hook but got null.` (code ERR_INVALID_RETURN_PROPERTY_VALUE). Cause: `register("data:text/javascript,...")` at e2e/global-setup.ts:~51. Workaround: drop that call and run with `NODE_OPTIONS=--conditions=@capybara-hq/source`.
Other env facts: Playwright browsers are not installed on this machine (`~/Library/Caches/ms-playwright` absent; `playwright install chromium` stalled, ~80MB in 10 min); Google Chrome.app exists (use `channel: "chrome"`). `next dev` allows one server per apps/web dir, so the e2e needs its own worktree while a dev web runs.
