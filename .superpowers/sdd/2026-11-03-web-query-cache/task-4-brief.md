### Task 4: Client gates, sign-out and org switch

**Files:**
- Create: `apps/web/src/lib/query/workspace.ts`, `apps/web/src/lib/query/agents.ts` (first entry:
  `agentsQuery(orgId)`, key `keys.org(orgId).agents()`, `orgConfig`; Tasks 10–11 add to the file).
- Modify:
  - `apps/web/src/components/QueryProvider.tsx` (the global `QueryCache.onError`)
  - the org switcher and sign-out callers (`components/shell/AppFrame.tsx`, `components/LeaveOrgDialog.tsx`, `components/CreateOrgDialog.tsx`, the account menu)
- Test: `apps/web/test/query-gates.test.tsx`

**Interfaces:**
- Produces:
  - `useWorkspace(opts?: { min?: "guest" | "member" | "admin"; setup?: "home" | "step" }): Workspace | { kind: "pending" }`. `Workspace` is the same union as `lib/server/session.ts`. It reads `meQuery` and `readinessQuery` from the cache. When the org is not ready and `setup` is unset, it calls `router.replace("/")` and returns `pending` until then.
  - `useAdmin(): { kind: "ok"; me: Me } | { kind: "noAccess"; need: "enterprise" }`.
  - `resetSession(qc: QueryClient, then: () => void): Promise<void>`. It runs `await qc.cancelQueries()` and `qc.clear()`, then calls `then()`.
- [ ] **Step 1:** Write failing tests:
  - `"a member below admin gets noAccess admin"`.
  - `"an org that is not ready redirects to / unless the page is a setup route"`.
  - `"a 401 auth.* on a client query redirects to /login?next=<path> and clears the cache"`: render `/agents` with an empty cache, stub `GET …/agents` → 401 `auth.required` and `POST /api/v1/auth/refresh` → 401. Expect `router.replace` to be called with `/login?next=%2Fagents`, `qc.getQueryCache().getAll()` to be empty, and no error state in the DOM at any point (check after each `await`).
  - `"org switch drops a read of the old org that answers late"`: start `agentsQuery("A")` with a deferred promise and call `resetSession`. Switch the current org to B, then resolve A's promise. `qc.getQueryData(keys.org("A").agents())` is `undefined`, and no A row is in the DOM.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Every org switch and sign-out path goes through `resetSession`. The `router.refresh()` calls in those paths stay, because the layout must decide again (spec §6).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(web): client-side gates and session reset on org switch and sign-out`.

