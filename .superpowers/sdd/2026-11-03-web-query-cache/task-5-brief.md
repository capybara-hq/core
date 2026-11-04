### Task 5: `check:web-ui` query rules (red first) with a pending ratchet

**Files:**
- Modify: `tools/checks/src/web-ui.ts`
- Create fixtures under `tools/checks/fixtures/web-ui/`:
  - `query-direct-read/`
  - `query-key-literal/`
  - `query-no-freshness/`
  - `query-page-read/`
  - `query-route-missing/`
  - `query-ok/`
  - `query-pending-stale/`
- Remove fixtures: `ssr-first-paint*`
- Test: `tools/checks/test/web-ui.test.ts`

**Interfaces:**
- Produces: `QUERY_PENDING: readonly { path: string; reason: string }[]`, a list of `app/(app)/**/page.tsx` and `view.tsx` paths not converted yet. It starts as every page except `[...rest]`. Each migration task removes its entries, and Task 17 asserts it is empty.

The rules, with their messages naming the spec section:

| Rule | Fails when |
|---|---|
| `web-query-no-direct-read` | in a `"use client"` file under `app/` or `components/`: a call of a `/lib/` value import outside a function passed as `fn` to `defineQuery` / `useAppMutation` (`fn`), or any `useLoad(` / `useServerState(` / `apiFetch(` call |
| `web-query-keys` | a `queryKey` property, or a `key:` passed to `defineQuery`, whose value is an array literal, anywhere outside `lib/query/keys.ts` (the literal `"self"` me key lives in keys.ts) |
| `web-query-freshness` | `queryOptions(` / `useQuery({` with an inline object outside `lib/query/define.ts` (all queries go through `defineQuery`, whose type requires `freshness`) |
| `web-query-page-read` | a server `page.tsx` that calls a `/lib/` loader, `read(`, `section(`, `optional(`, `workspace(` or `admin(` |
| `web-query-route-table` | a `page.tsx` whose pattern has no `ROUTES` entry, or whose entry has `none: ""` (no reason) |
| `web-query-stale-pending` | a `QUERY_PENDING` path that no longer violates (the list only shrinks) |

`web-ssr-first-paint` is removed. `web-ssr-client-page`, `web-ssr-location`, `web-ssr-view-value-import` and `web-ssr-loading-file` stay.

- [ ] **Step 1:** Add one red fixture per rule and one green fixture (`query-ok`). Write the tests `"<rule> flags its fixture"` and `"query-ok passes"` in `web-ui.test.ts`, each asserting the rule id and line.
- [ ] **Step 2:** Run `pnpm exec vitest run tools/checks/test/web-ui.test.ts`.
  Expected: the new tests FAIL.
- [ ] **Step 3:** Implement the rules. The route-table rule parses `lib/query/routes.ts` statically, reading the `pattern:` string literals. Findings under `QUERY_PENDING` paths are suppressed, the same way `SSR_PENDING` worked.
- [ ] **Step 4:** Run the tests. Expected: PASS. Then run `pnpm check:web-ui`.
  Expected: clean, with every unconverted page covered by `QUERY_PENDING`.
- [ ] **Step 5:** Update the CI notes: the `check:web-ui` bullets in `AGENTS.md` "CI and checks" and in the comments in `.github/workflows/ci.yml`. The new rules run in full on PRs: they are cheap text and AST scans, part of `pnpm check`.
- [ ] **Step 6:** Commit: `feat(checks): web-query rules for the query cache`.

