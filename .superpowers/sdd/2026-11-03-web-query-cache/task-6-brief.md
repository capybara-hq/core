### Task 6: Skeleton primitives and the header loading state

**Files:**
- Create: `packages/design/src/display/skeleton.tsx` (export it from `display/index.ts`).
- Modify:
  - `packages/design/src/shell/page-header.tsx` (`loading`)
  - `packages/design/src/styles/display.css`
  - `docs/design/spec.md` (new §6.29 Skeleton; the §4.2 PageHeader loading state and size table)
  - `docs/design/reference/src/page-header.html` (a `page-header-loading` block)
  - `apps/web/src/app/dev/ui/...` (reference blocks)
- Test:
  - `packages/design/test/skeleton.test.tsx`
  - `packages/design/test/spec-tables.test.ts` (runs on the new tables as is)

**Interfaces:**
- Produces:
  - `SkeletonText({ width, size }: { width: "30%" | "45%" | "55%" | "70%" | "100%" | number; size?: "body" | "small" | "title" })`. It is one bar with the height of that type size's line box, the `hover` ground and radius `sm`.
  - `SkeletonBox({ part, height?, width? })`: a control-sized block, the `selected` ground.
  - `SkeletonGroup({ label, children })`: `aria-busy`, with a hidden "正在加载 / Loading" (i18n). Nested groups announce once.
  - `PageHeaderProps.loading?: { title?: boolean; actions?: number; tabs?: number }`. A title that is not known yet is a `title`-size bar of 30%. Known actions and tabs render for real. `actions` / `tabs` give the slot count when unknown.
- Reduced motion: none of these animate, in any mode (no shimmer at all, which also satisfies spec §7.1).

- [ ] **Step 1:** Write failing tests:
  - `"SkeletonText takes the line box of its type size"`: compare the measured height with the `type.<size>` line height via the tokens.
  - `"one busy announcement per group"`.
  - `"PageHeader loading keeps the actions it knows"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/skeleton.test.tsx`.
  Expected: FAIL.
- [ ] **Step 3:** Implement. Write §6.29 with its state list (`text`, `box`, `group`) and size table, and add the `loading` state to PageHeader's state list and size table.
- [ ] **Step 4:** Run the tests and `pnpm exec vitest run packages/design/test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(design): skeleton primitives and the page header loading state`.

