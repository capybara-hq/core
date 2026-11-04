### Task 1: Spike: shared layouts do not re-run on client navigation

This task is throwaway and is not committed. It is a gate: if the result is negative, stop and report to the user before doing any other task (spec §3.1).

**Files:**
- Temporary only: `apps/web/src/app/(app)/layout.tsx`. Add a `console.log("LAYOUT", await currentPath())` and revert it afterwards.

- [ ] **Step 1:** Start the dev stack (`pnpm dev:kernel`, `pnpm dev:web`). Sign in, open `/agents` as a document request, and confirm `LAYOUT /agents` appears in `/tmp/capybara-dev-web.log`.
- [ ] **Step 2:** Click through `/agents` → `/agents/<id>` → `/chat/<id>` → `/trajectories?agent=<a>` → `/trajectories?agent=<b>`.
  Expected: no new `LAYOUT` line.
- [ ] **Step 3:** Trigger one `router.refresh()`, for example a save on `/settings/organization`.
  Expected: exactly one new `LAYOUT` line.
- [ ] **Step 4:** Revert the log line (`git checkout -- apps/web/src/app/\(app\)/layout.tsx`). Record the result in the PR description draft, `/private/tmp/claude-501/-Users-grant-Capybara-core/437af9d4-1202-42df-baf1-cdba60333527/scratchpad/query-spike.md`.

