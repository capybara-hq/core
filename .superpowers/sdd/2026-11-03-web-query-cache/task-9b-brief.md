### Task 9b: Skeleton alignment visual spec

**Files:**
- Create: `apps/web/visual/skeleton-alignment.spec.ts`.

- [ ] **Step 1:** Write the spec. For every template in a new list `LOADING_TEMPLATES` (exported from `accepted.ts`):
  1. Open `/dev/ui/reference/template-<name>`.
  2. For each `data-part` present in both the `-loading` and `-default` blocks, compare `boundingBox()` relative to the block: x, y and width within ±1 px.
  3. Height is compared for every part whose loaded height is fixed by the size table. The list `VARIABLE_HEIGHT` names the parts that are exempt (prose bodies).
  - Run it in both themes.
- [ ] **Step 2:** Run it locally against a template still missing a part (temporarily remove one part from the Detail skeleton) and see it fail. Restore, then run `pnpm --filter @capybara-hq/web visual -- skeleton-alignment`.
  Expected: PASS (layout only; no screenshot comparison here).
- [ ] **Step 3:** Add the spec to the `visual` job's list in `ci.yml` (by diff, same inputs as the other visual specs), and update the `visual` row in `AGENTS.md`.
- [ ] **Step 4:** Commit: `test(web): skeleton boxes equal the loaded page's boxes`.

