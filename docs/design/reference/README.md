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
| `<block>-<theme>.png` | One image per block and theme, rendered at device scale factor 2 |
| `index.html` | The static review page: every block, dark and light side by side, plus the tokens |

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

Pseudo-states (hover, focus) are drawn with `data-state`, never with real hover, so the images are
deterministic. After the maintainer signs the set off, changing it goes through the design spec's
§10 change process.
