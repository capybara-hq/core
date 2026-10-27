# Reference set

The reference set is the baseline the UI refresh is accepted against (UI refresh spec §7.1). It
replaces the design canvas as the source: the canvas was a draft with web substitute fonts and
off-scale sizes; the pages here use the real self-hosted fonts, the generated tokens and the shared
fixtures, and every size is a step of `docs/design/tokens.json`.

| Path | What it is |
|---|---|
| `src/*.html` | One page per component; one `<section data-ref-block="<component>-<state>">` per state |
| `src/reference.css` | Reference-only layout and component styles, written only with `var(--cb-*)` |
| `src/fill.js` | Fills `<template data-fixture>` from `@capybara-hq/design/fixtures` and `<i data-icon>` from the icon set; `?theme=dark\|light` |
| `src/conversation.js` | The conversation-page renderers (UI refresh B), loaded before `fill.js` on the B pages, which merges them into its table |
| `<block>-<theme>.png` | One image per block and theme, rendered at device scale factor 2 |
| `index.html` | The static review page: every block, dark and light side by side, grouped by project (A: shell, list and form pages; B: conversation page), plus the tokens |

## Rendering

```bash
pnpm --filter @capybara-hq/web reference:render
```

This starts `apps/web/reference/serve.mjs` (127.0.0.1:3200, read-only: `src/` at `/`, the design
package's `styles/` and `fonts/` at `/design/`), runs `apps/web/reference/render.spec.ts` (fails
if a real font did not load or a block id is duplicated or malformed) and rewrites `index.html`.

The committed PNGs come only from the `reference-update` workflow (manual, `workflow_dispatch`
with the branch), which renders in `mcr.microsoft.com/playwright:v1.64.1-noble` like the visual
job and commits the result. Local renders on other systems are for looking only; don't commit them.
The first committed set (UI refresh A) was rendered before the workflow reached `main`, so it
could not be dispatched: it was rendered with `docker run --platform linux/amd64` in that same
image (Node 24, `pnpm install --frozen-lockfile`, then `reference:render` on a clean export of the
branch), which gives the same output as the workflow. Later changes use the workflow.

Pseudo-states (hover, focus) are drawn with `data-state`, never with real hover, so the images are
deterministic.

## UI refresh B (conversation page)

The B pages (`template-conversation`, `title-bar`, `composer`, … `file-preview`; the list is in
`apps/web/reference/render.spec.ts`) were drawn from the canvas conversation boards with the
fixtures in `packages/design/src/fixtures/conversation.ts`, snapped to the token scales, and are
waiting for the maintainer's sign-off (UI refresh B plan, sign-off gate). Until then they are not
part of the signed set below.

## Sign-off and use

The maintainer signed the set off on 2026-10-26, with every default of the UI refresh A plan's
decision list accepted (recorded in `docs/superpowers/specs/2026-10-22-ui-refresh-design.md` §7.1)
and one fix (the table empty state has `space-8` vertical padding). From then on, changing it goes
through the design spec's §10 change process: the spec's rule, state list and size table first,
then the page here.

The implementation is accepted against it in two ways (design spec §9):

- **Measuring**: `apps/web/visual/fidelity.spec.ts` checks `/dev/ui/reference/<component>` against
  the size tables in `docs/design/spec.md` (±1px, colors equal to the token). It measures against
  the tokens, never against these PNGs.
- **Side by side**: `COMPARE=<components> pnpm --filter @capybara-hq/web compare` puts each PNG
  next to a screenshot of the `/dev/ui` block with the same id, for review by eye.
