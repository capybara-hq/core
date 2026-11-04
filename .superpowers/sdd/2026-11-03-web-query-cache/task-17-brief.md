### Task 17: e2e, docs, changeset

**Files:**
- Create: `apps/web/e2e/query-cache.spec.ts`.
- Modify:
  - `apps/web/e2e/chat.spec.ts` (the 404 for a missing conversation becomes the not-found state with 200; the unknown route keeps its 404)
  - `apps/web/e2e/ssr.spec.ts`
  - `AGENTS.md` ("UI" rule, CI table)
  - `.agents/skills/writing-web-ui/SKILL.md`
  - `docs/superpowers/specs/2026-11-01-web-ssr-design.md` (top note)
  - the spec's status line, to "implemented"
- Create: `.changeset/web-query-cache.md` (`@capybara-hq/web`: minor).

- [ ] **Step 1:** Write the e2e cases of spec §9, counting `/api` GETs with `page.on("request")`:
  - `"back to a conversation within 30 s reads only its stream"`: the only request for A is `…/stream?after=<n>`.
  - `"after 30 s it paints at once and refreshes in the background"`: use `page.clock` to advance 31 s. A's content is visible before the first background GET answers (hold it with `page.route`).
  - `"editing my display name updates the sidebar without a reload or a second /me"`.
  - `"switching org never shows the old org"`: a MutationObserver probe, as in `ssr.spec.ts`.
  - `"a reload paints complete with no skeleton"`: there is no `[aria-busy=true]` in the first paint (check in `DOMContentLoaded`).
  - `"a client navigation to an uncached page shows the template's loading state"`: hold `GET …/agents/<id>` and assert `[aria-busy=true]` inside the FormPage.
- [ ] **Step 2:** Run `pnpm --filter @capybara-hq/web e2e`.
  Expected: every spec PASSES, including the existing ones unchanged except the 404 assertion moved in `chat.spec.ts`.
- [ ] **Step 3:** Write the docs:
  - `AGENTS.md` "UI": page = thin server `page.tsx` + client view; first load from the route prefetch, navigation from the query cache; keys, freshness and `defineQuery`; no `loading.tsx`.
  - The skill: the query layer, the recipe of Tasks 10–16 condensed, the test helpers, and the template loading props.
  - The web-SSR spec note pointing to this spec for §1.1–1.3, §9 and S1.
- [ ] **Step 4:** Run `pnpm verify`.
  Expected: every required check passes locally.
- [ ] **Step 5:** Commit: `test(web): request-counting e2e for the query cache; docs`. Push `fix/rc2-acceptance`.
- [ ] **Step 6:** Trigger `visual-update` and `reference-update` on `fix/rc2-acceptance` for the new loading-state baselines and reference PNGs (`gh workflow run visual-update.yml -f branch=fix/rc2-acceptance`, and the same for `reference-update.yml`). Review the PNGs. Then push an empty commit to rerun CI, because the bot's commit does not trigger checks.
