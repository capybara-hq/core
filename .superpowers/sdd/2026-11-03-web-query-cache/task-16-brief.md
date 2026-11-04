### Task 16: Remove the old read paths

**Files:**
- Remove:
  - `lib/use-load.ts`, `lib/use-server-state.ts`
  - `read` / `section` / `optional` from `lib/server/page.ts`. Keep `currentPath`, `isSignedOut` and `isKernelUnavailable`.
  - `workspace` / `admin` from `lib/server/session.ts`, except what the layouts use.
- Modify: `tools/checks/src/web-ui.ts` (`QUERY_PENDING` must be `[]`; keep the mechanism, like `SSR_PENDING`).
- [ ] **Step 1:** Run `grep -rn "useLoad\|useServerState\|router.refresh()" apps/web/src`.
  Expected: only the `router.refresh()` calls in the paths Task 4 listed.
- [ ] **Step 2:** Run `pnpm check:web-ui`, `pnpm --filter @capybara-hq/web typecheck` and `pnpm exec vitest run apps/web/test`.
  Expected: all clean.
- [ ] **Step 3:** Commit: `refactor(web): remove the server-first read helpers`.

