# UI Refresh A (Shell and Refined E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the reference set (step 0), then move every page of the web app from the TopBar shell to the refined E shell: left sidebar with conversations grouped by agent, the two-row page header, content widths, a status bar inside the content area. The work is accepted against the reference set, not against its own screenshots.

**Architecture:** `docs/design/tokens.json` is the one source for colors, shadows, scales and motion. `pnpm gen:tokens` writes `packages/design/src/styles/tokens.css` and `packages/design/src/tokens.ts` from it, and `check:tokens` keeps all three in step. The reference set is static HTML in `docs/design/reference/src/`. It reads the generated CSS, the real self-hosted fonts and the same fixtures module as `/dev/ui`, and Playwright renders it to PNGs inside the visual-update Docker image. After the maintainer signs off the PNGs, the design spec is rewritten first. Then come a fidelity harness (measuring, state coverage, side-by-side), the refined components, a kernel endpoint for the grouped conversation list, the Sidebar and shell, and finally the migration of every page.

**Tech Stack:** TypeScript, React 19, Next 16 (apps/web), Playwright 1.64.1 (`mcr.microsoft.com/playwright:v1.64.1-noble`), vitest + jsdom, NestJS + Fastify + Kysely (kernel), fontTools (Python) for subsetting, Lucide (ISC) SVG paths, Inter + Source Han Sans SC (OFL).

**Spec:** `docs/superpowers/specs/2026-10-22-ui-refresh-design.md` (§3, §4, §7, §8, §9, §10; §5.9 "Sidebar list API" only). Also read `docs/design/spec.md`, `.agents/skills/writing-web-ui/SKILL.md`, `.agents/skills/writing-kernel-api/SKILL.md`, `.agents/skills/writing-migrations/SKILL.md`, and `AGENTS.md` "CI and checks".

## Global Constraints

- Dependency direction is unchanged. `apps/web` depends only on `@capybara-hq/design` and talks to the kernel over HTTP. `packages/design` depends on no `@capybara-hq/*`.
- `check:web-ui` is unchanged and must stay green: apps/web writes no `className` / `style` / `.css` / color literals, iframes only via `EmbedFrame`, and every page renders a template. Color literals in design are allowed only in `styles/tokens.css`, which is now generated.
- New components and templates change `docs/design/spec.md` first (spec §10 change process). The spec stays the single source of rules.
- Every size a component uses is a step of a §4.3 scale stored in `tokens.json`. Pages never pick sizes.
- Dark and light ship together. All text contrast meets WCAG AA (4.5:1 for text, 3:1 for UI boundaries and large text). Status never relies on color alone.
- Success, done and connected are not colored. Color is only for failure, things needing a person, things happening, and the primary action (§4.2.2).
- No characters as icons (`▾ ✓ ◐ › ● ⠿ ▤` and siblings). Icons are design components; `apps/web` never imports an icon library.
- `prefers-reduced-motion` is respected by every new transition. Hover transitions take 120–150ms.
- UI copy goes through i18n (zh and en). Design-internal text goes through `packages/design/src/i18n.ts`. Labels use the code's current names (the nav item is "Catalog" at `/catalog`, as the code already calls it).
- Sample copy in fixtures and the reference set uses placeholders (示例组织, 研究助手, 客服分流, Acme…), never the canvas's real-work names (AURE, Revolut, 金蝶, SGD amounts) (spec §9).
- Every new automatic check has a violating-fixture test that was seen failing (red) before the check was implemented. Every new check states full vs. by-diff in `AGENTS.md` "CI and checks" and in the `ci.yml` header comments, with the reason.
- Kernel: multi-replica rules (no in-process state), migrations named `NNNN_<snake>.sql` with `IF NOT EXISTS`, domain classes not depending on Nest, explicit `@Inject`.
- Screenshot baselines and reference PNGs are generated only in `mcr.microsoft.com/playwright:v1.64.1-noble` (workflows), never committed from darwin.
- Changesets: `@capybara-hq/web` (minor) for the UI, `@capybara-hq/kernel` (minor) for the endpoint and migration. `@capybara-hq/design` is private and needs none.
- Commits: Conventional Commits, body lines ≤ 100 characters, ending `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Work only in the worktree `.claude/worktrees/feat-ui-refresh-a` (branch `feat/ui-refresh-a`).
- **Out of scope (project B):** the conversation page's three columns, title bar, composer dropdowns, title generation, the properties panel, the right panel, tool/subagent display, and prose in the chat column. `/chat/[conversationId]` keeps PlaygroundPage + ChatPanel and changes only what the new shell forces (§3 transition rule, designer's call).

## Review Focus

1. **Long Chinese conversation titles and agent names** (40+ CJK characters, no spaces) in the sidebar, the rail tooltip and the page-header title must truncate to one line with an ellipsis, keep the full text in `title`, and never widen the 256 sidebar or cause horizontal page scroll. Tested in Task 9 (`sidebar-long-title` block + measuring) and Task 11 (page title).
2. **Zero conversations and many groups:** a new user sees a one-line empty hint in the conversation section, not a blank area or a spinner forever. A user with 60 agents gets 20 groups, then a "More" button for groups, and the section scrolls on its own while the account footer stays pinned. Tested in Task 8 (API paging) and Task 9 (blocks `sidebar-empty`, `sidebar-many-groups`, interaction test).
3. **Role hiding:** guest, member, admin and enterprise admin see exactly the nav items `NavAudience` allows. The Extensions group shows only when there are pages; Settings and Admin follow their audiences. Hiding is cosmetic and the kernel still decides. Tested in Task 11 (`nav.test.tsx` per level) and Task 9 (`sidebar-guest` block).
4. **Narrow screens:** at 1279 the sidebar becomes a 48-wide icon rail with tooltips, and at 959 a drawer opened from a menu button. Esc closes the drawer and returns focus. There is no horizontal page scroll at 1440 / 1279 / 959 / 640, and the status bar truncates its left part first. Tested in Task 9 (interaction spec) and Task 12 (visual widths).
5. **Reduced motion and contrast in both themes:** group collapse and hover transitions are instant under `prefers-reduced-motion: reduce`. Group labels (agent names) are essential text, so they use `muted`, never `faint` (the canvas light sidebar draws them in `#85857F`, below 4.5:1). Every text/background pair in `tokens.json.contrast` passes AA. Tested in Task 1 (`tokens-contrast` rule), Task 9 (reduced-motion interaction test) and Task 6 (measuring colors).

---

## File Structure

| Path | Responsibility | Task |
|---|---|---|
| `docs/design/tokens.json` | Source of truth: colors (dark/light), shadows, scales (§4.3), layout widths, motion, fonts, contrast pairs | 1 |
| `tools/checks/src/tokens.ts`, `tools/checks/src/cli/{gen-tokens,tokens}.ts` | Parse and validate tokens.json, render tokens.css / tokens.ts, the check | 1 |
| `packages/design/src/styles/tokens.css`, `packages/design/src/tokens.ts` | Generated; never hand-edited | 1 |
| `packages/design/scripts/subset-font.py`, `packages/design/src/fonts/*` | Subset Sarasa + Inter + Source Han Sans SC; licenses | 2 |
| `packages/design/src/styles/fonts.css` | `@font-face` only (moved out of base.css so reference pages can link it) | 2 |
| `packages/design/scripts/gen-icons.mjs`, `packages/design/src/icons/{paths.ts,icon.tsx,LICENSE.txt}` | Vendored Lucide paths, `Icon` component | 2 |
| `packages/design/src/fixtures/index.ts` (subpath `@capybara-hq/design/fixtures`) | The one fixtures module for `/dev/ui` and the reference set | 3 |
| `docs/design/reference/src/*.html`, `docs/design/reference/src/reference.css`, `docs/design/reference/src/fill.js` | Reference pages, one `data-ref-block` per component state | 3 |
| `apps/web/reference/{serve.mjs,render.spec.ts}`, `apps/web/playwright.reference.config.ts` | Render reference blocks to PNG | 3 |
| `docs/design/reference/*.png` | Rendered reference images (only from the workflow) | 3 |
| `.github/workflows/reference-update.yml` | workflow_dispatch: render and commit the PNGs | 3 |
| `docs/design/spec.md`, `.agents/skills/writing-web-ui/SKILL.md` | Rules, size tables, required states, interaction spec | 4 |
| `packages/design/src/reference/{spec-tables.ts,index.ts}` (subpath `@capybara-hq/design/reference`) | Parse size tables and state lists from spec.md, resolve token paths | 5 |
| `apps/web/src/dev/catalog/reference.tsx`, route `reference/<component>` | `/dev/ui` blocks with `data-ref-block` ids | 5+ |
| `apps/web/visual/{fidelity.spec.ts,accepted.ts}` | Measuring + state coverage (visual job) | 5 |
| `apps/web/playwright.compare.config.ts`, `apps/web/compare/compare.spec.ts` | Side-by-side acceptance page | 5 |
| `packages/design/src/{controls,display,table,overlays}/*`, `styles/*.css` | Refined E: density steps, radius, lines, color rules, motion | 6 |
| `tools/checks/src/web-ui.ts` (rule `design-char-icon`) | Rejects character icons | 7 |
| `packages/kernel/src/conversations/*`, `packages/kernel/src/migrations/0051_conversations_account_agent_idx.sql` | Grouped list API | 8 |
| `packages/design/src/shell/sidebar.tsx`, `styles/sidebar.css` | Sidebar (full / rail / drawer), conversation section | 9 |
| `packages/design/src/shell/{app-shell,page-header,stat-cards,status-bar,action-row,body}.tsx`, `templates/*` | New shell and header, widths, templates | 10 |
| `apps/web/src/components/shell/{AppFrame,nav,conversations}.tsx`, `apps/web/src/lib/conversations.ts`, all pages | Web on the new shell | 11 |

---

### Task 1: tokens.json, generator and `check:tokens`

Step 0 part 1. This task creates the token source and the pipeline. Values come from the canvas (`Refined*`, `Sidebar`, `ListPage`, `FormPage`; `Conv*` only for tokens). The canvas disagrees with itself in places, and the chosen value below is the starting value that step 0 confirms at sign-off (designer's call).

**Files:**
- Create: `docs/design/tokens.json`
- Create: `tools/checks/src/tokens.ts`, `tools/checks/src/cli/tokens.ts`, `tools/checks/src/cli/gen-tokens.ts`
- Create: `tools/checks/fixtures/tokens/{valid,stale,invalid,low-contrast}/…` (each a mini root with `docs/design/tokens.json` and `packages/design/src/{styles/tokens.css,tokens.ts}`)
- Test: `tools/checks/test/tokens.test.ts`
- Modify: `package.json` (scripts `gen:tokens`, `check:tokens`), `tools/checks/src/cli/all.ts` (add "Design tokens")
- Modify (generated): `packages/design/src/styles/tokens.css`, `packages/design/src/tokens.ts`; `packages/design/test/tokens.test.ts` (compare with tokens.json instead of hard-coded maps)
- Modify: `tools/ci/src/affected.ts` `EXTRA_INPUTS`: `docs/design/tokens.json` → `tools/checks` and `packages/design`. An entry maps to one dir, so add two entries or make `dir` a list; update `tools/ci/test/affected.test.ts`.
- Modify: `AGENTS.md` "CI and checks" (new bullet), `.github/workflows/ci.yml` header comment.

**Interfaces:**
- Produces: `docs/design/tokens.json` shape:

```jsonc
{
  "version": 1,
  "color": {                      // name -> { dark, light, purpose }; emitted as --cb-<name>
    "bg": { "dark": "#0A0A0A", "light": "#F7F6F2", "purpose": "Page background" }
    // …
  },
  "shadow": { "shadow-1": { "dark": "…", "light": "…", "purpose": "…" } },
  "size": {
    "control": { "dense": 24, "default": 28, "prominent": 32 },
    "row":     { "dense": 28, "default": 32, "roomy": 44 },
    "space":   { "1": 4, "2": 8, "3": 12, "4": 16, "5": 20, "6": 24, "7": 32, "8": 40 },
    "pad":     { "dense": [4, 8], "default": [6, 12] },
    "radius":  { "sm": 4, "md": 8, "bubble": 10 },
    "type": {
      "micro": [11, 14], "small": [12, 16], "body": [13, 20], "h2": [16, 24], "h1": [20, 28],
      "prose": [15, 26], "prose-small": [13, 20], "metric": [18, 24]
    },
    "layout": {
      "sidebar": 256, "sidebar-rail": 48, "content-list": 1080, "content-form": 880,
      "chat": 720, "status-bar": 24, "action-row": 40, "gutter": 20
    }
  },
  "motion": { "hover": "120ms", "expand": "160ms", "overlay": "120ms" },
  "font": {
    "mono": "\"Sarasa Mono SC\", ui-monospace, monospace",
    "prose": "\"Inter\", \"Source Han Sans SC\", system-ui, sans-serif"
  },
  "z": { "sheet": 40, "dialog": 50, "popover": 60, "toast": 70 },
  "contrast": [ ["ink", "bg", 4.5], ["muted", "bg", 4.5], ["muted", "panel", 4.5], ["muted", "sidebar", 4.5],
                ["ink", "sidebar-active", 4.5], ["on-accent", "accent", 4.5], ["fail", "bg", 4.5],
                ["warn", "bg", 4.5], ["accent", "bg", 3], ["line", "bg", 1.0] ]
}
```

`prose` line height 26 is 15 × 1.75 rounded (spec says 1.75). Store `[15, 26]` and note the rounding in the spec.

Color mapping (canvas hex onto existing names, plus new names). Every row goes into tokens.json:

| Token | Dark | Light | Purpose | Canvas variants step 0 must settle |
|---|---|---|---|---|
| `bg` | `#0A0A0A` | `#F7F6F2` | page | light was `#F6F6F3` |
| `panel` | `#111110` | `#FFFFFF` | cards, table container, stat cards, form field cards, overlays | — |
| `panel-2` | `#0E0E0D` | `#FBFAF7` | action row, right-panel ground (B) | — |
| `sidebar` (new) | `#111110` | `#EFEEE9` | sidebar ground | dark equals `panel` |
| `sidebar-active` (new) | `#1A1A18` | `#E2E1DB` | current nav item / conversation | — |
| `raised` (new) | `#141413` | `#FFFFFF` | floating inline cards, composer (B) | — |
| `selected` (new) | `#1F1F1D` | `#ECEBE6` | selected segment, selected filter chip ground, avatar | — |
| `hover` | `#171716` | `#F4F3EF` | hover ground | was `#161614` / `#ECECE7` |
| `line-soft` (new) | `#1C1C1A` | `#E6E5E0` | column dividers, table row dividers, status-bar top line | light: `#ECEBE6` (list) / `#E2E1DB` (sidebar) |
| `line` | `#2A2A28` | `#D6D5CF` | input / button border | light list page uses `#DAD9D3`; dark was `#262624` |
| `line-strong` | `#3A3A37` | `#B5B5AE` | overlay border | unchanged |
| `ink` | `#E6E6E3` | `#1A1A18` | text | light was `#0A0A0A` |
| `muted` | `#8E8E89` | `#5E5E5A` | secondary text, group labels | — |
| `faint` | `#5A5A56` | `#9A9A94` | placeholders, separators only | light sidebar uses `#85857F` |
| `accent`, `accent-hover`, `accent-press`, `on-accent` | unchanged | unchanged | — | — |
| `accent-tint` | unchanged (`color-mix` 12%) | unchanged | — | — |
| `focus-ring` (new) | `rgba(255,106,19,.25)` | `rgba(204,70,9,.18)` | 3px input focus halo | needs a spec §2.5 change (see Task 4) |
| `ok`, `fail`, `warn`, `scrim` | unchanged | unchanged | — | — |
| `shadow-float` (new, `shadow` group) | `0 8px 24px rgba(0,0,0,.45)` | `0 8px 24px rgba(26,26,24,.08)` | composer (B), drawer | — |
| `shadow-1`, `shadow-2`, `shadow-sheet` | unchanged | unchanged | — | — |

- Produces (tools/checks/src/tokens.ts):
  - `type DesignTokens` (the shape above)
  - `parseTokens(text: string, file: string): { tokens?: DesignTokens; findings: Finding[] }` (rule `tokens-invalid`: missing dark/light, a color not matching `/^#[0-9A-F]{6}$/` or `rgba\(…\)` / `color-mix(…)`, a size not a positive integer, a contrast pair naming an unknown token)
  - `renderTokensCss(t: DesignTokens): string` emits a header `/* Generated by pnpm gen:tokens from docs/design/tokens.json; do not edit. */` plus the biome-ignore line already in the file. `:root` holds the non-color vars: `--cb-font` (= mono, kept for existing CSS), `--cb-font-prose`, `--cb-z-*`, `--cb-motion` (= hover, kept), `--cb-motion-<name>`, `--cb-control-<step>`, `--cb-row-<step>`, `--cb-space-<n>`, `--cb-pad-<step>-y/-x`, `--cb-radius-<step>`, `--cb-type-<name>-size/-line`, `--cb-layout-<name>`. The `:root[data-theme="dark"]` / `light` blocks hold colors and shadows plus `color-scheme`. Values are emitted verbatim, with `px` added to numbers.
  - `renderTokensTs(t: DesignTokens): string` exports `TOKEN_NAMES` (colors + shadows, in file order), `SIZES` (the `size` object as a const) and `type TokenName`, and contains no color values (so `design-color-literal` stays meaningful).
  - `contrastRatio(fg: string, bg: string): number` (WCAG relative luminance; `color-mix` tokens are skipped from pairs)
  - `checkTokens(root: string): Finding[]` (rules `tokens-invalid`, `tokens-stale` with message "run pnpm gen:tokens", `tokens-contrast` naming the pair, theme, ratio and floor)

- [ ] **Step 1: Write the fixtures and failing tests** in `tools/checks/test/tokens.test.ts`:
  - `valid` fixture → `checkTokens` returns `[]`.
  - `stale` (tokens.css hand-edited) → exactly one `tokens-stale` finding whose file ends with `tokens.css`; `stale` with tokens.ts edited → one finding on tokens.ts.
  - `invalid` (light value missing on `panel`) → one `tokens-invalid` naming `color.panel.light`.
  - `low-contrast` (`muted` light `#B0B0AA` on `bg` `#F7F6F2`) → one `tokens-contrast` whose message contains `muted on bg (light)` and `4.5`.
  - `contrastRatio("#FFFFFF", "#000000")` is `21` (to 2 decimals); `contrastRatio("#FFFFFF", "#CC4609")` ≥ 4.72 (the spec §2.1 claim).
  - `renderTokensCss(parse(valid))` equals the fixture's tokens.css byte for byte.
  - The repository root → `checkTokens(root)` returns `[]`.
- [ ] **Step 2: Run, see red.** `pnpm exec vitest run tools/checks/test/tokens.test.ts`. Expected: FAIL (module not found). Then implement only `parseTokens` as a stub returning no findings and confirm the `invalid` / `stale` / `low-contrast` cases fail on their assertions (red proven per rule).
- [ ] **Step 3: Implement** `tools/checks/src/tokens.ts`, the two CLIs (`report("Design tokens", checkTokens(root))`; gen writes both files), the `package.json` scripts (same `tsx --tsconfig tsconfig.base.json` form as `check:i18n`) and the all.ts entry. Write `docs/design/tokens.json` with the table above and run `pnpm gen:tokens`.
- [ ] **Step 4: Update `packages/design/test/tokens.test.ts`** so it reads `docs/design/tokens.json` and asserts that every color token appears in both theme blocks of tokens.css with the JSON value, and that `TOKEN_NAMES` equals the JSON color + shadow keys.
- [ ] **Step 5: Run.** `pnpm exec vitest run tools/checks/test/tokens.test.ts packages/design/test/tokens.test.ts tools/ci/test` → PASS. `pnpm check:tokens` → `[Design tokens] passed`. `pnpm check:web-ui` → passed.
- [ ] **Step 6: CI docs.** AGENTS.md bullet: "`check:tokens` (full: cheap, part of `pnpm check`; reads one JSON and two generated files): `packages/design/src/styles/tokens.css` and `src/tokens.ts` must equal what `pnpm gen:tokens` renders from `docs/design/tokens.json` (`tokens-stale`); the JSON must be well-formed (`tokens-invalid`); every pair in `contrast` must meet its floor in both themes (`tokens-contrast`)." Add the EXTRA_INPUTS line to the AGENTS.md EXTRA_INPUTS sentence. Add one line to the ci.yml header comment.
- [ ] **Step 7: Commit** `feat(design): tokens.json as the token source, with gen:tokens and check:tokens`.

### Task 2: Proportional font and the Icon component

Step 0 part 2: the assets that both the reference set and the implementation render with.

**Files:**
- Modify: `packages/design/scripts/subset-font.py` (multi-family), `packages/design/scripts/charset.txt` (regenerated)
- Create: `packages/design/scripts/charset-latin.txt`
- Create: `packages/design/src/fonts/{Inter-Regular,Inter-Bold,SourceHanSansSC-Regular,SourceHanSansSC-Bold}.subset.woff2`, `OFL-Inter.txt`, `OFL-SourceHanSans.txt` (keep `OFL.txt` for Sarasa)
- Create: `packages/design/src/styles/fonts.css`. Modify: `styles/base.css` (remove `@font-face`), `styles/index.css` (import fonts.css first)
- Create: `packages/design/scripts/gen-icons.mjs`, `packages/design/src/icons/{paths.ts,icon.tsx,index.ts,LICENSE.txt}`, `styles/icons.css`
- Modify: `packages/design/package.json` (devDependency `lucide-static`, exact version; script `gen:icons`), `packages/design/src/index.ts`
- Test: `packages/design/test/icons.test.tsx`, `packages/design/test/fonts.test.ts`

**Interfaces:**
- Produces: CSS families `"Inter"` and `"Source Han Sans SC"` (400 / 700), used through `var(--cb-font-prose)`. Sarasa stays `var(--cb-font)`.
- Produces: `type IconName` (fixed union, exported), `ICON_NAMES: readonly IconName[]`, `ICON_PATHS: Record<IconName, string[]>` (raw `d` / element strings of the 24-grid SVG), and

```ts
export function Icon(p: { name: IconName; size?: 16 | 14 | 12; label?: string }): JSX.Element
// <svg viewBox="0 0 24 24" width/height=size (default 16) fill="none" stroke="currentColor"
//  stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="cb-icon">;
// aria-hidden="true" unless label is given (then role="img" aria-label=label).
```

- Icon names (Lucide source name in parentheses). Task 7 may add names, and the union grows only through `gen-icons.mjs`: `plus`, `search`, `home` (house), `agent` (bot), `skills` (sparkles), `inbox`, `connector` (plug), `catalog` (library), `channel` (message-square), `evals` (flask-conical), `admin` (shield), `extension` (puzzle), `settings`, `chevron-down`, `chevron-right`, `chevron-left`, `chevron-up`, `chevrons-left`, `chevrons-right`, `check`, `x`, `more-horizontal` (ellipsis), `more-vertical` (ellipsis-vertical), `spinner` (loader-circle), `file`, `file-text`, `image`, `refresh` (refresh-cw), `external-link`, `arrow-up`, `arrow-down`, `arrow-up-down`, `circle-alert`, `circle-x`, `circle-check`, `circle`, `pause`, `ban`, `diamond`, `copy`, `download`, `upload`, `paperclip`, `menu`, `panel-left`, `log-out`, `languages`, `sun`, `moon`, `user`, `building` (building-2), `empty` (circle-slash), `trending-up`, `trending-down`, `square`.

- [ ] **Step 1: Failing tests.** `icons.test.tsx`: every `ICON_NAMES` entry has a non-empty `ICON_PATHS` entry; `<Icon name="search" />` renders an `svg` with `aria-hidden="true"`, width 16, stroke-width 1.5; `<Icon name="x" size={12} label="关闭" />` has `role="img"` and accessible name 关闭. `fonts.test.ts`: `fonts.css` declares the six faces (Sarasa 400/700, Inter 400/700, Source Han Sans SC 400/700) and each `url(...)` file exists. Every woff2 is under 2.5 MB, so a full unsubsetted file fails the test. Run → FAIL.
- [ ] **Step 2: Fonts.** Extend `subset-font.py` with `--family sarasa|inter|source-han-sans` and a source directory. Pin in the script header: Inter (rsms/inter release 4.1, `extras/ttf/Inter-Regular.ttf` / `Inter-Bold.ttf`) and Source Han Sans (adobe-fonts/source-han-sans 2.x `SubsetOTF/CN/SourceHanSansCN-Regular.otf` / `-Bold.otf`, renamed to family "Source Han Sans SC" in `@font-face`). Record the exact release tag and the sha256 of each source file in the script header. Source Han Sans uses the existing `charset.txt` (ASCII + GB2312 level 1 + every character in `apps/web/messages/*.json` and `src/i18n.ts` + the symbol table), so it covers the same set as Sarasa. Inter uses `charset-latin.txt`: 0x20–0x7E, 0xA0–0x17F, the general punctuation block 0x2010–0x206F, ₤€¥, and the arrows `←↑→↓↵`. Run `--build-charset` first, because new messages may have added characters. Use `--layout-features=kern,liga,calt,tnum` for Inter (tabular numbers). Add the two OFL texts with each font's copyright line.
- [ ] **Step 3: Icons.** `gen-icons.mjs` maps `IconName → lucide file name`. It reads `node_modules/lucide-static/icons/<file>.svg`, extracts the child elements and writes `src/icons/paths.ts` with the header `// Generated by pnpm --filter @capybara-hq/design gen:icons from lucide-static@<version> (ISC); do not edit.` Copy Lucide's ISC license to `src/icons/LICENSE.txt`. Write `icon.tsx` per the interface; `icons.css` sets `.cb-icon { flex: none; vertical-align: middle }`.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/design/test/icons.test.tsx packages/design/test/fonts.test.ts` → PASS; `pnpm check:web-ui` and `pnpm typecheck` → pass.
- [ ] **Step 5: Commit** `feat(design): self-hosted Inter and Source Han Sans SC, Lucide icon component`.

### Task 3: Reference set (pages, fixtures, renderer, workflow)

Step 0 part 3. One block per component state, with fixed fixture data shared with `/dev/ui`.

**Files:**
- Create: `packages/design/src/fixtures/index.ts` (pure data, no React; add `"./fixtures"` to `package.json` `exports` with the `@capybara-hq/source` condition like `./theme`)
- Create: `docs/design/reference/src/{index,sidebar,page-header,stat-cards,status-bar,action-row,controls,table,icon,template-list,template-form}.html`, `reference.css` (reference-only layout CSS using `var(--cb-*)`), `fill.js` (fills `<template data-fixture>` from `window.__CB_FIXTURES__` and replaces `<i data-icon="name" data-size="16">` with SVG from `window.__CB_ICONS__`)
- Create: `apps/web/reference/serve.mjs` (node:http on 127.0.0.1:3200, read-only, serving `docs/design/reference/src/**` at `/` and `packages/design/src/{styles,fonts}/**` at `/design/…`; 404 for everything else, no `..`)
- Create: `apps/web/playwright.reference.config.ts`, `apps/web/reference/render.spec.ts`; script `reference:render` in `apps/web/package.json`
- Create: `.github/workflows/reference-update.yml`
- Create: `docs/design/reference/README.md` (how to render; PNG naming; that the canvas is no longer the source)
- Modify: `apps/web/src/dev/catalog/fixtures.tsx` to re-export / derive from `@capybara-hq/design/fixtures`; product-flavoured copy moves there
- Test: `packages/design/test/fixtures.test.ts`; `apps/web/reference/render.spec.ts` is itself the renderer

**Interfaces:**
- Produces `@capybara-hq/design/fixtures`:

```ts
export const FIXTURE_ORG = "示例组织";
export const FIXTURE_USER = { name: "grant", initial: "G" };
export type FixtureNavItem = { id: string; label: string; href: string; icon: IconName; count?: number; audience: "all" | "member" | "admin" | "enterprise" };
export const NAV_FIXTURE: FixtureNavItem[];               // Overview … Evals, Settings, Admin, in §4.4 order
export const EXTENSION_PAGES_FIXTURE: { id: string; label: string; href: string }[]; // 2 items
export type FixtureConversation = { id: string; title: string | null; startedAt: string; updatedAt: string };
export type FixtureGroup = { agentId: string; agentName: string; conversations: FixtureConversation[]; more: boolean };
export const GROUPS_FIXTURE: FixtureGroup[];              // 研究助手 (5 + more), 客服分流 (1), 周报助手 (2, one untitled)
export const LONG_TITLE_GROUP_FIXTURE: FixtureGroup;      // a 48-CJK-character title and a 30-character agent name
export const MANY_GROUPS_FIXTURE: FixtureGroup[];         // 20 groups × 1, more groups = true
export const LIST_PAGE_FIXTURE: { title: string; description: string; metrics: { label: string; value: string; tone?: "warn" | "fail" }[]; rows: … };
export const FORM_PAGE_FIXTURE: { breadcrumb: …; sections: … };
export const STATUS_FIXTURE: { context: string; pageStatus: string; system: string; version: string; timeZone: string };
```

Placeholder copy only (Global Constraints). Rows for the list page reuse the canvas structure (connectors: name, type, status, tools, 7-day calls, owner) with names like `Acme Docs`, `示例工单`, `内部 Wiki`.

- Block ids `<component>-<state>`. The list is final for step 0, and Task 4 copies it into the spec's state lists:
  - `sidebar`: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `rail`, `drawer`
  - `page-header`: `title`, `breadcrumb`, `description-actions`, `long-title`
  - `stat-cards`: `four`, `five`, `tones`
  - `status-bar`: `default`, `truncated`
  - `action-row`: `unsaved-errors`, `clean`
  - `button`: `default-step`, `dense-step`, `prominent-step`, `hover`, `focus`, `disabled`, `loading`
  - `input`: `default`, `focus`, `error`, `disabled`
  - `segmented`, `switch`, `filter-chip`: `default`, `selected`, `focus`
  - `table`: `default`, `row-hover`, `row-selected`, `loading`, `empty`
  - `icon`: `set-16`, `set-14`, `set-12`
  - `template-list`, `template-form`: `page` (1280 × 820 full page, the canvas artboard size)
- PNG name: `docs/design/reference/<id>-<theme>.png`, rendered at `deviceScaleFactor: 2`.
- Theme: `?theme=dark|light` sets `<html data-theme>`. Pseudo-states (hover, focus) are drawn with a `data-state="hover"` class rule in `reference.css`, never with real hover, so rendering is deterministic.

- [ ] **Step 1: Failing test** `fixtures.test.ts`: the fixtures module imports nothing from React (assert the source has no `react` import). No fixture string contains any canvas real-work name: assert none of `AURE`, `Revolut`, `金蝶`, `SGD`, `林岚`, `周舟`, `陈默`, `许诺` appears in `JSON.stringify` of all exports. `LONG_TITLE_GROUP_FIXTURE.conversations[0].title` has ≥ 40 characters. `MANY_GROUPS_FIXTURE.length === 20`. Run → FAIL.
- [ ] **Step 2: Implement** the fixtures module and switch `apps/web/src/dev/catalog/fixtures.tsx` to it (the catalog's existing exports keep their names; TopBar-specific fixtures stay until Task 11 deletes them).
- [ ] **Step 3: Write the reference pages.** Each page links `/design/fonts.css`, `/design/tokens.css`, `reference.css`, `fill.js`. Each block is `<section data-ref-block="<id>" style="width:…;height:…">` with explicit pixel sizes taken from tokens (`var(--cb-layout-sidebar)` etc.). Draw from the canvas structure (Sidebar, ListPage, FormPage, Refined for the composer shadow only), but snap every size to a `tokens.json` step. Use `muted` for group labels (Review Focus 5). Use no ok-green dot for "system OK" and "connected" (§4.2.2: success not colored; the canvas still colors them). Every icon is an `<i data-icon>`.
- [ ] **Step 4: Renderer.** `playwright.reference.config.ts`: testDir `./reference`, chromium, `deviceScaleFactor: 2`, `webServer: { command: "node reference/serve.mjs", url: "http://127.0.0.1:3200/index.html" }`. `render.spec.ts`: for each page and theme, `addInitScript` sets `window.__CB_FIXTURES__` (from `@capybara-hq/design/fixtures`) and `window.__CB_ICONS__` (from `ICON_PATHS`). It then goes to the page, awaits `document.fonts.ready`, and asserts `document.fonts.check('13px "Sarasa Mono SC"')` and the same for Inter / Source Han Sans SC, failing if a real font did not load. For every `[data-ref-block]` it writes `locator.screenshot({ path, animations: "disabled" })`. It also asserts that block ids are unique and match `/^[a-z-]+-[a-z0-9-]+$/`.
- [ ] **Step 5: Workflow** `reference-update.yml`, a copy of `visual-update.yml`'s shape: same image `mcr.microsoft.com/playwright:v1.64.1-noble`, input `branch`, `contents: write`, concurrency per branch. It runs `pnpm --filter @capybara-hq/web reference:render`, then `git add docs/design/reference/*.png` and commits `docs(design): render reference images` only if something changed. The header comment says it is manual and never runs on PRs.
- [ ] **Step 6: Run locally** `pnpm --filter @capybara-hq/web reference:render`. Expected: PASS, with PNGs in `docs/design/reference/` (darwin; do not commit them: add `docs/design/reference/*.png` to the commit only from the workflow, and `git restore` locally). `pnpm exec vitest run packages/design/test/fixtures.test.ts` → PASS.
- [ ] **Step 7: CI docs.** AGENTS.md: reference-update is manual, like visual-update. Add `reference-update.yml` to the repository map / the "Visual baselines" bullet.
- [ ] **Step 8: Commit** `feat(design): reference set pages, shared fixtures and renderer`. Push the branch and dispatch `gh workflow run reference-update.yml -f branch=feat/ui-refresh-a`. Wait for its commit and pull it.

---

## ⛔ Sign-off gate (maintainer)

Execution **stops here**. The coordinator publishes a review page from the committed PNGs (dark | light per block) together with the token mapping table from Task 1 and the "Needs a maintainer decision" list at the end of this plan. The maintainer signs off or asks for changes. Changes loop back into Tasks 1–3 (tokens.json values, reference pages), and the workflow re-renders. Tasks 4–12 start only after an explicit sign-off. From then on, changing the reference set goes through the design spec's §10 change process.

---

### Task 4: Design spec changes (§4.7) and the skill

The first implementation task. Docs only, reviewed before Task 5 (spec §4.7: "Project A's first task is to change the spec … and get it reviewed").

**Files:**
- Modify: `docs/design/spec.md`, `.agents/skills/writing-web-ui/SKILL.md`, `docs/design/reference/README.md`

**Interfaces:**
- Produces two machine-readable formats in spec.md, parsed by Task 5. Each A component in §6 gets both:

```md
<!-- states: sidebar -->
States: `default`, `item-hover`, `item-focus`, `conversation-active`, `group-collapsed`, `empty`, `loading`, `error`, `long-title`, `many-groups`, `guest`, `rail`, `drawer`

<!-- size-table: sidebar -->
| Part | State | Property | Value |
|---|---|---|---|
| root | default | width | layout.sidebar |
| nav-item | default | height | row.default |
| nav-item | default | border-radius | radius.sm |
| nav-item | default | padding-left | space.3 |
| nav-item | conversation-active | background-color | color.sidebar-active |
| group-label | default | color | color.muted |
| group-label | default | font-size | type.small |
```

`Value` is a tokens.json path (`size.` prefix omitted for sizes; `color.` for colors; `type.<name>` means the size, `type.<name>.line` the line height) or a literal number in px. `Part` is a `data-part` attribute value inside the block, or `root`. `State` names the block `<component>-<state>`.

- [ ] **Step 1: Rewrite spec sections** per spec §4.7's table, with the decisions of this plan:
  - §1: add "spacing before lines" and "color only for what needs attention"; replace "character grid / one monospace font" with the two-font rule (mono skeleton, proportional prose).
  - §2.1: the token table regenerated from tokens.json (all tokens, both themes, purpose), plus a sentence that tokens.json is the source and `check:tokens` enforces it.
  - §2.2: two fonts and what each is for (§4.2.5): mono for navigation, labels, buttons, tables, tool rows, keys, paths, numbers, status bar; prose (`--cb-font-prose`, 15 / 26) for conversation prose, rendered Markdown and descriptive text in forms and page headers (`prose-small` 13 / 20). Weights 400 / 700 only. Remove "a second font must not be introduced".
  - §2.3: current top-level navigation = `sidebar-active` tinted background (no underline). The other four roles stay.
  - §2.4: the high-frequency list rule (success = no mark; failure = the word "Failed" in `fail`). Every status symbol becomes an `Icon` (running = `spinner` in accent, failed = `circle-x`, pending approval = `pause` warn, queued = `circle`, cancelled = `ban`, limit = `diamond` warn, succeeded = `check` but uncolored `muted`) and still always has text.
  - §2.5: replace the fixed 24/28/36 heights and radius 0 with the §4.3 scales, density steps and their usage rules (copy the spec's table and rules verbatim; numbers come from tokens.json). Radius: `sm` inputs / buttons / chips, `md` inline cards / property sections / overlays / form field cards, `bubble` message bubbles, 0 for tables and page structure. Focus: inputs get an `accent` border + 3px `focus-ring` halo; other controls keep the 2px accent outline.
  - §3: logo at pixel unit 2 (28 × 20) in the sidebar; 2 in the rail without the wordmark.
  - §4 App Shell: "Sidebar | content area (page header / body / action row / status bar)". Remove the TopBar. The status bar sits in the content area only: no background, `line-soft` top line, `micro` type, `muted`, height `layout.status-bar`, read-only. Left: `user@org:route` · page status; right: system status · version · time zone. Content widths: lists 1080, forms 880, centered. Remove the Centered body's 180 anchor nav (see the maintainer list).
  - §4.x Sidebar: everything in spec §4.4 plus the builder's calls of Task 9 (rail < 1280, drawer < 960, group collapse remembered per viewer in `localStorage` key `cap.sidebar.collapsed`, 5 conversations per group then "More", 20 groups then "More", untitled placeholder `未命名会话 · MM-DD HH:mm` / `Untitled conversation · MM-DD HH:mm`).
  - §5: T7 stays as is for A (B decides between a Conversation template and extending T7). All templates take the new header; ListPage shows metrics as stat cards below the header.
  - §6: new components Icon, Sidebar, conversation list (part of Sidebar), StatCards; changed: Button / Input / Segmented / Switch / filter chip / DataTable / PageHeader / StatusBar / ActionRow (density steps, radius, lines). Each gets a size table and a state list in the formats above, for exactly the block ids of Task 3. The other §6 additions in spec §4.7 (tool group, subagent row, file card, composer…) are B's and get a one-line "added by project B" placeholder.
  - §6.11 (new) Interaction: hover background transition `motion.hover`; group expand / collapse height transition `motion.expand`; sidebar keyboard (Tab enters at the current item; ↑/↓ move between nav items and conversation rows; Home/End; Enter / Space on a group label toggles it, `aria-expanded`; Esc closes the drawer and returns focus to the menu button); reduced motion makes all of these instant.
  - §9: rewrite per spec §7. Reference images in `docs/design/reference/` are the first-acceptance baseline. Describe the measuring tests (±1px sizes, exact colors), the state-coverage test, side-by-side acceptance with the image-reviewing step, and the screenshot regression that stays. CI placement per §7.7.
  - Header "Status / Visual reference": the reference set in `docs/design/reference/` replaces the canvas as the visual source.
- [ ] **Step 2: Skill.** `writing-web-ui/SKILL.md`: the reference set exists now (remove "don't look for it"); the flow for a new component adds "reference block + size table + state list + `/dev/ui` block with the same id + `pnpm --filter @capybara-hq/web compare`"; the template table loses nothing; add `Icon` usage ("never a character as an icon; `design-char-icon`"). Keep the frontmatter valid (`pnpm check:skills-frontmatter`).
- [ ] **Step 3: Verify** `pnpm check:terms && pnpm check:skills-frontmatter` → passed.
- [ ] **Step 4: Commit** `docs(design): refined E rules, sidebar shell, size tables and states`. Request review of the spec diff before Task 5 (the coordinator relays it).

### Task 5: Fidelity harness (measuring, coverage, side-by-side)

**Files:**
- Create: `packages/design/src/reference/spec-tables.ts`, `packages/design/src/reference/index.ts`; add `"./reference"` export
- Test: `packages/design/test/spec-tables.test.ts` with fixtures `packages/design/test/fixtures/spec-{valid,missing-state,bad-value,dup-table}.md`
- Create: `apps/web/src/dev/catalog/reference.tsx` (route `reference/<component>`; add `REFERENCE_ROUTES` to `routes.tsx`, excluded from `CATALOG_ROUTES` screenshots), `apps/web/src/dev/catalog/ref-block.tsx` (`RefBlock`)
- Create: `apps/web/visual/accepted.ts`, `apps/web/visual/fidelity.spec.ts`
- Create: `apps/web/playwright.compare.config.ts`, `apps/web/compare/compare.spec.ts`; script `compare` in `apps/web/package.json`; gitignore `apps/web/compare-out/`
- Modify: `tools/ci/src/affected.ts` EXTRA_INPUTS (`docs/design/spec.md` → `apps/web`, `docs/design/tokens.json` → `apps/web` too) + test; `AGENTS.md`; `ci.yml` comments

**Interfaces:**
- Produces (`@capybara-hq/design/reference`, pure TS):

```ts
export type SizeRow = { part: string; state: string; property: string; value: string; line: number };
export type SizeTable = { component: string; rows: SizeRow[] };
export type StateList = { component: string; states: string[]; line: number };
export function parseSizeTables(specMd: string): SizeTable[];          // throws SpecFormatError on a malformed table
export function parseStateLists(specMd: string): StateList[];
export function resolveToken(tokens: unknown, value: string, theme: "dark" | "light"): string | number; // "row.default" -> 32, "color.muted" -> "#8E8E89"
export function missingStates(lists: StateList[], blockIds: string[], components: string[]): string[]; // "<component>-<state>" not rendered
export function checkSpecTables(specMd: string, tokens: unknown): { message: string; line: number }[];
// rules: a size table without a state list, a row state not in the list, a value path tokens.json lacks,
// a duplicate size-table marker
export class SpecFormatError extends Error {}
```

- Produces: `RefBlock({ id, width?, height?, children })` renders `<div data-ref-block={id}>`. Design components gain `data-part` attributes named in the size tables, as part of each component task.
- Produces: `apps/web/visual/accepted.ts` exports `ACCEPTED: string[]`, the components whose blocks are accepted so far. Tasks 6, 9 and 10 append, and Task 12 asserts it equals every component with a state list.

- [ ] **Step 1: Failing tests** in `spec-tables.test.ts`: `spec-valid.md` parses into 1 table with 3 rows and 1 state list; `missingStates` with the block ids minus `sidebar-empty` returns `["sidebar-empty"]` (the violating fixture for the coverage check); `spec-bad-value.md` → `checkSpecTables` reports the row's line and `row.huge`; `spec-dup-table.md` → reports the duplicate; `resolveToken(tokens, "type.body.line", "dark")` → 20; `resolveToken(tokens, "color.ink", "light")` → `#1A1A18`. Finally the repo's `docs/design/spec.md` + `tokens.json` → `checkSpecTables` returns `[]`. Run → FAIL (module not found). Stub the functions to return empty results and confirm the `missingStates` and bad-value cases fail on assertions (red per rule).
- [ ] **Step 2: Implement** the parser (markers are HTML comments on their own line; the table must directly follow, header `| Part | State | Property | Value |`). Implement `RefBlock`, the `reference/<component>` route (renders every `/dev/ui` block for that component, both themes via the existing `cb-theme` cookie), `accepted.ts` (empty at first) and `fidelity.spec.ts`. For each theme and each component in `ACCEPTED`, `fidelity.spec.ts` (a) asserts `missingStates(...)` is `[]` on `/zh/dev/ui/reference/<component>` and (b) for each size row finds `[data-ref-block="<c>-<state>"]` and its `[data-part="<part>"]` (or the block for `root`) and compares: px properties from `getBoundingClientRect()` for `width`/`height` and `getComputedStyle` otherwise, within ±1px; colors as `getComputedStyle` rgb equal to the token converted to rgb. Failures name component, state, part, property, expected and actual.
- [ ] **Step 3: Side-by-side.** `compare.spec.ts` reads `COMPARE` (comma-separated components, required) and screenshots each `/dev/ui/reference/<c>` block at `deviceScaleFactor: 2` in both themes. It writes `apps/web/compare-out/<id>-<theme>.impl.png` and `apps/web/compare-out/index.html`: one row per block, reference PNG (`docs/design/reference/<id>-<theme>.png`) left and implementation right, dark then light, with the block id as caption. It fails if a reference PNG is missing.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/design/test/spec-tables.test.ts tools/ci/test` → PASS; `pnpm --filter @capybara-hq/web visual -- fidelity` → PASS (no components accepted yet: zero cases plus one sanity case that `/dev/ui/reference/sidebar` returns 200).
- [ ] **Step 5: CI docs.** AGENTS.md: the `visual` row now says "screenshot regression, measuring and state-coverage tests (`apps/web/visual/fidelity.spec.ts`)". It stays by diff, because it builds Next and runs Playwright (minutes) and its inputs are `apps/web/**`, `packages/design/**`, plus `docs/design/{spec.md,tokens.json}` via EXTRA_INPUTS. Note that `compare` is a local / review tool, not CI. Update the ci.yml `web, visual:` comment line.
- [ ] **Step 6: Commit** `test(web): fidelity harness: size tables, state coverage, side-by-side`.

**Per-task acceptance procedure (used by Tasks 6, 9, 10, 11)**, referenced as "Acceptance" below:
1. `COMPARE=<components> pnpm --filter @capybara-hq/web compare`.
2. Dispatch an image-reviewing subagent with the paths of `apps/web/compare-out/*.png` (reference and implementation pairs) and only this instruction: "List every difference between each reference (left) and implementation (right) by severity: severe = different structure or layout, missing state, wrong color; moderate = size or spacing off; minor = rendering details. Cite the block id." Do not tell it what you changed.
3. Fix every severe and moderate difference, then repeat from 1. Minor differences are listed in the task report.
4. Append the components to `ACCEPTED`, run `pnpm --filter @capybara-hq/web visual -- fidelity` → PASS. The maintainer reviews `compare-out/index.html` at the end (Task 12).

### Task 6: Refined E for existing components

Apply §4.2 / §4.3 to the controls, display and table components. The shell and Sidebar are Tasks 9–10; character icons are Task 7.

**Files:**
- Modify: `packages/design/src/controls/{button,inputs,toggles,field,slider}.tsx`, `display/{basic,tabs,pagination,key-value,tooltip}.tsx`, `table/DataTable.tsx`, `overlays/{dialog,menus,palette,sheet,toast}.tsx`; styles `controls.css`, `display.css`, `table.css`, `overlays.css`, `base.css`
- Create: `packages/design/src/controls/filter-chip.tsx` (`selected` = `selected` ground + `ink` border; maintainer decision 8)
- Modify: `apps/web/src/dev/catalog/components/*` (blocks with `RefBlock` ids for button, input, segmented, switch, filter-chip, table, icon)
- Modify: all `size={24|28|36}` call sites in design and web (TypeScript finds them)
- Test: `packages/design/test/controls.test.tsx`, `table.test.tsx` (prop changes)

**Interfaces:**
- Produces: `type Density = "dense" | "default" | "prominent"`. `Button`, `IconButton`, `Input`, `Select`, `Segmented`, `FilterChip` take `density?: Density` (default `"default"`), replacing `size?: 24 | 28 | 36`. A container sets the step: `DataTable` passes `dense` to its toolbar controls through a `DensityContext`; `useDensity()` reads it, and an explicit prop wins.
- Produces: `FilterChip({ label, count?, selected, onSelect, density? })`.
- Consumes: tokens from Task 1 (`--cb-control-*`, `--cb-radius-*`, `--cb-space-*`, `--cb-line-soft`, `--cb-motion-hover`), `Icon` from Task 2.

- [ ] **Step 1: Failing tests.** `controls.test.tsx`: `<Button density="dense">` has `data-density="dense"`; inside `<DensityContext value="dense">` a `Button` without a prop is dense; `IconButton` keeps `aria-label`. `table.test.tsx`: toolbar buttons are dense. Run → FAIL (type errors or missing attributes).
- [ ] **Step 2: Implement.** CSS uses only `var(--cb-*)`: control heights per step; padding `pad.dense` / `pad.default`; radius `sm` on inputs, buttons and chips; `md` on overlays and option cards; tables square. Borders only on things floating over content (inputs, inline cards, overlays). Cards and sections lose borders and use `panel` ground. Table row dividers use `line-soft`. `transition: background-color var(--cb-motion-hover)` on hoverable things. Success colors are removed from high-frequency status (StatusMark succeeded = `muted` check). Focus halo on inputs per Task 4 §2.5. Add `data-part` attributes named in the size tables.
- [ ] **Step 3: Blocks.** Add `RefBlock`s with the Task 3 ids to the components catalog.
- [ ] **Step 4: Run** `pnpm exec vitest run packages/design apps/web/test` → PASS; `pnpm typecheck && pnpm check:web-ui` → pass.
- [ ] **Step 5: Acceptance** (procedure above) for `button,input,segmented,switch,filter-chip,table,icon`.
- [ ] **Step 6: Commit** `feat(design): refined E density steps, radius, lines and color rules`.

### Task 7: No characters as icons (`design-char-icon`)

**Files:**
- Modify: `tools/checks/src/web-ui.ts` (rule `design-char-icon`), `tools/checks/test/web-ui.test.ts`, fixtures `tools/checks/fixtures/web-ui/char-icon/{design,web}/…`
- Modify: every design and web file the rule reports (StatusMark, Checklist, ThinkingRow, ToolCallRow, AttachmentPreview, Pagination, DataTable sort marks, Sheet `↗` / `✕`, Toast, Body rail `«` `»`, Button loading `⠿`, Menu triggers `▾`, AppFrame org menu `✓ name`, catalog fixtures such as `状态: 2 项 ▾`, and `apps/web/visual/catalog.spec.ts` selectors that name them)
- Modify: `packages/design/src/overlays/menus.tsx` (`MenuItem.checked?: boolean` rendered as a `check` icon, replacing `✓ ` prefixes); `scripts/subset-font.py` `SYMBOLS` (drop the retired glyphs, keep box-drawing and `⌘↵·…→`)
- Modify: `.agents/skills/writing-web-ui/SKILL.md` forbidden table, `docs/design/spec.md` §9 item 3

**Interfaces:**
- Produces: rule `design-char-icon`. In non-test `.ts` / `.tsx` under `packages/design/src` and `apps/web/src`, any string literal, template literal chunk or JSX text containing a character of `ICON_CHARS = "▾▴▸◂✓✗✕◐›‹«»●○⠿▤⋯↻↗↕▲▼‖⊘◆□▶∅☰⚙⌕▦"` is reported. The message reads "Use <Icon name=…> (packages/design/src/icons); characters are not icons", with the suggested icon name from a map (`▾`→`chevron-down`, `✓`→`check`, `✕`→`x`, `⋯`→`more-horizontal`, `⠿`→`spinner`, `▤`→`file`, …). It also applies to `apps/web/messages/*.json` values (currently none) and to `packages/design/src/i18n.ts`. Box-drawing (`─│└`), `⌘`, `↵`, `→`, `·`, `…` are allowed.
- Consumes: `Icon`, `IconName` (Task 2); add any icon names the replacements need through `gen-icons.mjs`.

- [ ] **Step 1: Fixtures and failing test.** `char-icon/design/src/bad.tsx` has `<span>▾</span>` and `const spin = "⠿"`, and `char-icon/web/src/bad.tsx` has `label: \`✓ ${name}\``: expect exactly 3 `design-char-icon` findings with lines. `char-icon/design/src/ok.tsx` with `<Kbd>⌘K</Kbd>` and `"└ "` gives 0 findings. Run `pnpm exec vitest run tools/checks/test/web-ui.test.ts` → FAIL (rule absent).
- [ ] **Step 2: Implement the rule** (AST walk with the existing `source.ts` helpers, as `web-ui-color` does) → fixture tests PASS. Run `pnpm check:web-ui` on the repo and confirm it is red with the current findings (record the count in the commit body).
- [ ] **Step 3: Replace every finding** with `Icon` (or `MenuItem.checked`), keeping accessible names and screen-reader status text. Update tests that queried by the old characters (`packages/design/test/*`, `apps/web/test/*`, `apps/web/visual/catalog.spec.ts`) to query by role / name.
- [ ] **Step 4: Run** `pnpm check:web-ui` → passed; `pnpm exec vitest run packages/design apps/web/test tools/checks/test/web-ui.test.ts` → PASS; `pnpm typecheck`.
- [ ] **Step 5: Docs.** Forbidden-table row in the skill; spec §9 item 3 mentions the rule; AGENTS.md: no new CI entry needed (part of `check:web-ui`, full), but add one clause to the UI rule line: "no characters as icons (`design-char-icon`)".
- [ ] **Step 6: Commit** `feat(design): replace character icons with Icon, add design-char-icon`.

### Task 8: Kernel grouped conversation list

Spec §5.9 "Sidebar list API" (designer's call on the shape).

**Files:**
- Create: `packages/kernel/src/migrations/0051_conversations_account_agent_idx.sql`
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (`listGroups`, `listMine` gains `agentId`), `conversations.controller.ts` (route + query), `apps/web/src/lib/conversations.ts` (client)
- Test: `packages/kernel/test/conversations/conversation-groups.http.test.ts`, `apps/web/test/conversations-lib.test.ts`
- Create: `.changeset/ui-refresh-a-kernel.md` (`"@capybara-hq/kernel": minor`)

**Interfaces:**
- Migration: `CREATE INDEX IF NOT EXISTS conversations_account_agent_idx ON capybara.conversations (org_id, account_id, agent_id, updated_at DESC, id DESC) WHERE kind = 'chat';`
- HTTP: `GET /api/v1/orgs/:orgId/conversations/groups?perGroup=5&limit=20&after=<agentId>`, `@OrgAction("agents.use")`, human users only (`requireUser`, so a service token → 403 `forbidden`, as `list`):

```ts
const GroupsQuery = z.object({
  perGroup: z.coerce.number().int().min(1).max(20).default(5),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  after: z.string().min(1).max(100).optional(),     // the last group's agentId
});
type ConversationGroup = {
  agent: { id: string; name: string };
  latestAt: string;                 // max(updated_at) of the group, ISO
  conversations: ConversationView[]; // ≤ perGroup, updated_at DESC, id DESC
  more: boolean;                     // the group has more than perGroup
};
// 200 { groups: ConversationGroup[]; next: string | null }
```

- Service: `listGroups(orgId: string, accountId: string, opts: { perGroup: number; limit: number; after?: string }): Promise<{ groups: ConversationGroup[]; next: string | null }>`. It includes only the caller's `kind = 'chat'` conversations whose agent is not deleted and is `visibleTo(accountId)` (same filter as `listMine`). Groups are ordered by `(latestAt DESC, agent_id DESC)`. The cursor is the last group's agent id, re-evaluated against its current `latestAt` like `listMine`'s cursor; a cursor agent that is no longer listed returns an empty page. One SQL statement: a grouped CTE limited to `limit + 1`, then `LATERAL (… LIMIT perGroup + 1)`.
- `GET /conversations` gains `agentId: z.string().min(1).max(100).optional()` (per-group "More": `?agentId=…&after=<conversationId>&limit=20`).
- Web client: `listConversationGroups(orgId, opts?: { perGroup?: number; limit?: number; after?: string })` and `listConversations(orgId, opts: { agentId?: string; after?: string; limit?: number })`, returning the shapes above.

- [ ] **Step 1: Failing HTTP tests** (same harness as `conversations.http.test.ts`):
  - zero conversations → `{ groups: [], next: null }`;
  - 3 agents with 7 / 1 / 2 conversations, touched in a known order → groups ordered by latest activity; first group has 5 conversations and `more: true`, the others `more: false`; `agent.name` present; `title` null for all (untitled);
  - `limit=2` → 2 groups, `next` = second group's agent id; `after=next` → the third group, `next: null`;
  - another user's conversations never appear; a `kind = 'eval'` conversation never appears;
  - an agent made private to someone else / soft-deleted → its group disappears;
  - `GET /conversations/groups` is not captured by `GET /conversations/:id` (200 with the groups shape, not 404 `conversation.not_found`);
  - `GET /conversations?agentId=<a>` lists only that agent's conversations and pages with `next`;
  - `perGroup=21` → 400; service token → 403 `forbidden`.
  Run `pnpm exec vitest run packages/kernel/test/conversations/conversation-groups.http.test.ts` → FAIL.
- [ ] **Step 2: Implement** the migration, service and route (static route declared before `@Get(":id")`). Run → PASS. Also run `pnpm exec vitest run packages/kernel/test/conversations` (no regressions) and `pnpm check:migrations`.
- [ ] **Step 3: Web client + test** (`apps/web/test/conversations-lib.test.ts` with a mocked `fetch`: URL and query encoding, typed result) → PASS.
- [ ] **Step 4: Changeset** "Add `GET /conversations/groups` (the caller's conversations grouped by agent, per-group and group paging) and an `agentId` filter on `GET /conversations`, for the sidebar."
- [ ] **Step 5: Commit** `feat(kernel): list my conversations grouped by agent`.

### Task 9: Sidebar component

**Files:**
- Create: `packages/design/src/shell/sidebar.tsx`, `packages/design/src/styles/sidebar.css` (imported from `index.css`)
- Modify: `packages/design/src/shell/index.ts`, `packages/design/src/i18n.ts` (zh + en keys below)
- Modify: `apps/web/src/dev/catalog/components/shell.tsx` and the reference route: one `RefBlock` per sidebar state
- Test: `packages/design/test/sidebar.test.tsx`; `apps/web/visual/sidebar.interaction.spec.ts`

**Interfaces:**

```ts
export type SidebarNavItem = {
  id: string; label: string; href: string; icon: IconName;
  count?: number; countMore?: boolean;          // inbox: shown as count Badge, 99+, n+; aria-label includes it
};
export type SidebarConversation = { id: string; title: string | null; startedAt: Date; href: string };
export type SidebarGroup = {
  agentId: string; agentName: string; conversations: SidebarConversation[];
  more: boolean; onMore(): void;                 // loads the next page into this group
  onNew(): void;                                 // ＋ next to the group name
};
export type SidebarProps = {
  newConversation: { href: string };            // label from design i18n "新会话" / "New conversation"
  nav: SidebarNavItem[];                         // Overview … Evals
  activeNav: string;                             // "" when a conversation is active
  extensions?: { id: string; label: string; href: string }[];  // group shown only when non-empty
  footerNav: SidebarNavItem[];                   // Settings, Admin (already filtered by role)
  conversations: {
    state: "loading" | "ready" | "error";
    groups: SidebarGroup[];
    activeId?: string;
    moreGroups: boolean; onMoreGroups(): void;
    onRetry(): void;
  };
  account: { name: string; org: string | null; menu: MenuItem[] };  // menu: org switch, language, theme, sign out
  onOpenCommands(): void;
  mode?: "full" | "rail" | "drawer";            // default from media queries: <1280 rail, <960 drawer
};
export function Sidebar(p: SidebarProps): JSX.Element;
export function untitledLabel(startedAt: Date, locale: "zh" | "en"): string; // "未命名会话 · 10-26 14:02"
```

- Layout (from Task 4's size tables): width `layout.sidebar` (rail `layout.sidebar-rail`), ground `sidebar`, right divider `line-soft`. The top row holds logo (unit 2) + wordmark + search IconButton (`search`, opens ⌘K). Then "＋ New conversation", nav, Extensions group, footer nav (Settings, Admin), all `row.default` high with `radius.sm`; the active item has the `sidebar-active` ground and `ink` text, the others `muted`. The conversation section scrolls on its own (`overflow-y: auto`, `min-height: 0`): group label `small` `muted` with a collapse toggle (`button`, `aria-expanded`, `chevron-down` / `chevron-right`) and a ＋ IconButton (`aria-label` "与 {agent} 新建会话" / "New conversation with {agent}"); rows `row.dense`, single-line ellipsis with `title` = full text, active row `sidebar-active`. "More" is a text button. The empty state is one `muted` line "还没有会话" / "No conversations yet". Loading shows 3 skeleton rows (no spinner). Error shows "加载失败 · 重试" with a button. The account footer is pinned at the bottom: 22px initial avatar on `selected` + name · org + `chevron-up`, opening `account.menu`.
- Rail: icons only, `Tooltip` with the label, inbox count as a small Badge on the icon. The conversation section is replaced by one IconButton (`panel-left`, "展开侧栏") that opens the drawer. Drawer: a `Sheet` from the left (width `layout.sidebar`, `shadow-float`), opened by a menu IconButton that AppShell (Task 10) places at the top of the content area. Esc and route changes close it, and focus returns to the menu button.
- Group collapse state: `localStorage["cap.sidebar.collapsed"]` = JSON array of agent ids, read and written inside try/catch (renders expanded when storage throws).
- Keyboard per Task 4 §6.11: one roving tab stop for the nav list and one for the conversation list (↑/↓/Home/End move focus; Enter follows the link).
- i18n keys: `sidebar.new`, `sidebar.newWith`, `sidebar.conversations`, `sidebar.empty`, `sidebar.loadFailed`, `sidebar.retry`, `sidebar.more`, `sidebar.moreGroups`, `sidebar.untitled`, `sidebar.extensions`, `sidebar.expand`, `sidebar.collapseGroup`, `sidebar.expandGroup`, `sidebar.menu`.

- [ ] **Step 1: Failing jsdom tests** `sidebar.test.tsx`:
  - nav renders in order with `aria-current="page"` on `activeNav`; inbox with `count: 120` renders `99+` and accessible name "收件箱，99+ 项待处理";
  - `extensions: []` → no Extensions heading; two items → heading + two links;
  - groups render the agent name, conversations as links with `aria-current="page"` on `activeId`; `title: null` → `untitledLabel(startedAt, "zh")` text, e.g. `未命名会话 · 10-26 14:02` for `new Date(2026, 9, 26, 14, 2)`;
  - a 48-character title row has `title` attribute equal to the full title;
  - group toggle sets `aria-expanded="false"`, hides rows, and writes the agent id to `localStorage`; a `localStorage` that throws on `getItem` still renders expanded;
  - `more: true` → "更多" button calls `onMore`; `moreGroups` → "更多" at the end calls `onMoreGroups`;
  - `state: "loading"` → 3 skeleton rows and `aria-busy="true"`; `"error"` → "重试" calls `onRetry`; `ready` with `groups: []` → "还没有会话";
  - ↓ from the first nav item moves focus to the second; End moves to the last; Tab from the nav list leaves the list;
  - `mode="rail"` → no visible labels, each nav link keeps its accessible name; the conversation section is replaced by the expand button.
  Run `pnpm exec vitest run packages/design/test/sidebar.test.tsx` → FAIL.
- [ ] **Step 2: Implement** `sidebar.tsx` and `sidebar.css` (tokens only, `data-part` names from the size table). Run → PASS.
- [ ] **Step 3: Blocks.** All 13 sidebar states as `RefBlock`s from `GROUPS_FIXTURE` / `LONG_TITLE_GROUP_FIXTURE` / `MANY_GROUPS_FIXTURE` / guest nav (only audience `all`). Pseudo-states use real `:hover` / `:focus-visible` forced by Playwright in the fidelity spec: add a `forceState?: "hover" | "focus"` handling in `fidelity.spec.ts` keyed by state names `*-hover` / `*-focus`.
- [ ] **Step 4: Interaction tests** `sidebar.interaction.spec.ts` on `/zh/dev/ui/templates/list` (full shell with fixtures): keyboard path (Tab into nav, ↓↓, Enter navigates); group collapse animates height over `motion.expand` (assert the computed `transition-duration` is 160ms) and with `page.emulateMedia({ reducedMotion: "reduce" })` the duration is ≤ 0.01ms; at width 1279 the rail shows and the label text is not visible; at 959 the menu button opens the drawer and Esc closes it with focus back on the menu button; at 1440 / 1279 / 959 / 640 `document.documentElement.scrollWidth <= innerWidth`. Run `pnpm --filter @capybara-hq/web visual -- sidebar.interaction` → PASS.
- [ ] **Step 5: Acceptance** for `sidebar`.
- [ ] **Step 6: Commit** `feat(design): sidebar with navigation and conversations grouped by agent`.

### Task 10: App shell, page header, stat cards, status bar, widths, templates

**Files:**
- Modify: `packages/design/src/shell/{app-shell,page-header,status-bar,action-row,body}.tsx`, delete `top-bar.tsx` (and `TopBarProps` export), `styles/shell.css`, `styles/templates.css`
- Create: `packages/design/src/display/stat-cards.tsx`
- Modify: every template in `packages/design/src/templates/*` (header props, StatCards, widths)
- Modify: `apps/web/src/dev/catalog/{frame.tsx,fixtures.tsx,templates/*}` (FixtureShell on the Sidebar), blocks for `page-header`, `stat-cards`, `status-bar`, `action-row`, `template-list`, `template-form`
- Test: `packages/design/test/{shell,templates}.test.tsx`

**Interfaces:**

```ts
export function AppShell(p: {
  sidebar: Omit<SidebarProps, "onOpenCommands" | "mode">;
  commands: CommandGroup[];
  status: { context: string; version: string; timeZone?: string; system?: ReactNode };
  children?: ReactNode;
}): JSX.Element;
// Layout: [Sidebar | content column]. The content column is [drawer menu bar (only < 960) |
// template | ActionRow (when the template has one) | StatusBar]. ⌘K handling moves here unchanged.

export type PageHeaderProps = {
  breadcrumb?: { label: string; href: string }[];   // row 1, optional; replaces `parent`
  title: string;                                     // row 2 left, h1, single-line ellipsis, title attr
  description?: string;                              // row 2 left under the title, prose-small, muted
  count?: ReactNode; status?: ReactNode;             // after the title, as today
  metrics?: MetricProps[];                           // rendered by the template as StatCards below the header
  actions?: HeaderAction[];                          // row 2 right; ≤1 primary (assertHeader unchanged)
};
export function StatCards(p: { metrics: MetricProps[] }): JSX.Element; // ≤5 (throws in dev/test), panel ground,
// radius md, padding 8/12, gap 8, label small muted, value metric; tone warn/fail colors the value only.
export type StatusBarProps = { context: string; version: string; timeZone?: string; system?: ReactNode; pageStatus?: ReactNode };
```

- `Body`'s `centered` layout drops `anchors` / `activeAnchor` (max width `layout.content-form`, centered). A new `width?: "list" | "form" | "full"` on templates sets the content max width: ListPage and OverviewPage `list` (1080), FormPage / SettingsPage content / WizardPage `form` (880), Detail / Inbox / Playground / Trace `full`. The page gutter is `layout.gutter` on both sides.
- StatusBar: no background, `line-soft` top line, `micro` type, `muted`, height `layout.status-bar`, no `> ` prefix. Left: `context` · `pageStatus` (left part truncates first). Right: `system` · `version` · `timeZone`. Never interactive.
- ActionRow: above the StatusBar, `panel-2` ground, `line-soft` top line, `default` density buttons; unchanged props.
- FormPage loses `anchors` (see maintainer decision 3). FormSection: two columns (title + prose-small description ≤ 260 wide | fields on a `panel` card, radius md, padding 14 → snapped `space` per Task 4), sections divided by `line-soft`.

- [ ] **Step 1: Failing tests.** `shell.test.tsx`: AppShell renders a `navigation` landmark (sidebar) and a `contentinfo` (status bar) *inside* the content column, not spanning the sidebar (assert the footer's parent is the content column element); status bar right part reads `0.1.0 · UTC+8`; no `> ` prefix; PageHeader with `breadcrumb` renders a `nav` with aria-label "面包屑" / "Breadcrumb" and links in order; `description` renders under the title; two primaries still throw; `StatCards` with 6 metrics throws. `templates.test.tsx`: ListPage renders StatCards after the header when `metrics` is given; FormPage has no anchor nav; `data-width="list"` / `"form"` on the content wrapper per template. Run → FAIL.
- [ ] **Step 2: Implement**, delete TopBar, migrate the templates and the dev catalog. Run `pnpm exec vitest run packages/design` → PASS. `pnpm typecheck` will fail in `apps/web` (TopBar / `parent` / `anchors` users): leave the apps/web errors for Task 11 only if both tasks land in one PR. Otherwise keep a temporary `parent` → `breadcrumb` mapping in PageHeader and remove it in Task 11 (recommended: keep `pnpm typecheck` green at every commit, so add the mapping, marked `// removed in Task 11`).
- [ ] **Step 3: Blocks** for `page-header`, `stat-cards`, `status-bar`, `action-row`, `template-list`, `template-form`; extend `visual/catalog.spec.ts` `NARROW` with `templates/list: [1279, 959]` and `templates/form: [959]`.
- [ ] **Step 4: Acceptance** for those six components.
- [ ] **Step 5: Commit** `feat(design): left-sidebar app shell, two-row page header, stat cards, status bar in the content area`.

### Task 11: Every page on the new shell

**Files:**
- Modify: `apps/web/src/components/shell/AppFrame.tsx`, `nav.tsx`; create `apps/web/src/components/shell/conversations.tsx`
- Modify: every page passing `parent` / `anchors` / TopBar-era props under `apps/web/src/app/**` and `apps/web/src/components/**` (TypeScript lists them)
- Modify: `apps/web/messages/{zh,en}.json` (`nav.settings`, `nav.newConversation`, sidebar strings that web owns)
- Modify: `apps/web/src/app/[locale]/(app)/chat/[conversationId]/page.tsx` only for the transition (no `activeNav` "agents"; nothing else)
- Test: `apps/web/test/nav.test.tsx` (new), `apps/web/test/sidebar-conversations.test.tsx` (new), `apps/web/test/pages.test.tsx`, affected e2e specs (`apps/web/e2e/*.spec.ts` that locate the TopBar or "主导航")
- Create: `.changeset/ui-refresh-a-web.md` (`"@capybara-hq/web": minor`)

**Interfaces:**
- Consumes: `AppShell`, `SidebarProps` (Tasks 9–10), `listConversationGroups` / `listConversations` / `createConversation` (Task 8).
- Produces in `nav.tsx`:
  - `NAV` gains `{ id: "settings", key: "settings", href: "/settings/connections", audience: "all", footer: true }`, and `admin` becomes `footer: true`. Every entry gets an `icon: IconName` (`home`, `agent`, `skills`, `inbox`, `connector`, `catalog`, `channel`, `evals`, `settings`, `admin`).
  - `activeNavOf(pathname)`: `/settings/*` → `"settings"` (no longer `"connectors"`; delete `CONNECTOR_SETTINGS`); `/chat/*` → `""` (the conversation row is active instead); the rest unchanged.
  - `useExtensions` returns `{ id, label, href }[]` (label = page title; the plugin name moves to `title` text only if two pages share a title).
  - `useNav(...)` returns `{ nav, footerNav, commands }`, each item a `SidebarNavItem`.
- Produces in `conversations.tsx`: `useConversationGroups(orgId: string | null, pathname: string): SidebarProps["conversations"] & { activeIdFrom(pathname): string | undefined }`. It loads `listConversationGroups()` on org change and on pathname change into `/chat/*` (a new conversation appears), and on `window` focus. `onMore(agentId)` appends from `listConversations({ agentId, after: lastId })`; `onMoreGroups` appends the next group page; `onNew(agentId)` = `createConversation` then `router.push("/chat/<id>")` (today's Agents-list behavior; B changes it). The state is browser-only per viewer (no kernel state).
- "＋ New conversation" links to `/agents` in A (maintainer decision 2).
- The org switcher moves into `account.menu` (the org items with `checked` on the current org, separator, language, theme, sign out).

- [ ] **Step 1: Failing tests.** `nav.test.tsx`: for levels guest / member / admin and enterprise true/false, the visible nav ids and footer ids equal exact arrays (guest: overview, agents, inbox, connectors + settings; member adds skills, catalog; admin adds channels, evals; enterprise adds admin). `activeNavOf("/settings/members")` → `"settings"`; `activeNavOf("/chat/abc")` → `""`. `sidebar-conversations.test.tsx` (mocked fetch): groups render, "更多" fetches `?agentId=…&after=…`, a failed load shows retry, switching org reloads and drops the old groups (never shows org A's conversations under org B), and the group ＋ posts `{ agentId }` and navigates. Run `pnpm exec vitest run apps/web/test/nav.test.tsx apps/web/test/sidebar-conversations.test.tsx` → FAIL.
- [ ] **Step 2: Implement** AppFrame on `AppShell({ sidebar, commands, status })` with `status = { context: who:route, version, timeZone }`, nav, and conversations. Migrate every page to `breadcrumb` / `description` and remove `anchors` (descriptions: use existing i18n hint keys where a page has them; otherwise none; no new copy beyond `nav.*`). Remove the temporary PageHeader `parent` mapping from Task 10. Chat page: the transition only.
- [ ] **Step 3: Run** `pnpm typecheck && pnpm lint && pnpm check` → pass; `pnpm exec vitest run apps/web/test packages/design` → PASS.
- [ ] **Step 4: e2e.** Update locators in `apps/web/e2e` that used the TopBar (role `navigation` name 主导航 stays the Sidebar's aria-label, so most locators keep working; menu-based org switching changes to the account menu). Run `pnpm --filter @capybara-hq/web e2e` → PASS (needs Docker).
- [ ] **Step 5: Acceptance** of real pages: `COMPARE=template-list,template-form` against `/dev/ui`, plus a manual screenshot of `/connectors` and `/agents/new` in both themes, compared with `template-list-*` / `template-form-*` by the image-reviewing subagent (same procedure, same severity rule).
- [ ] **Step 6: Changeset** "The web app moves to a left sidebar with your conversations grouped by agent, a two-row page header, stat cards on list pages, and a status bar in the content area; refined E styling (softer lines, line icons, compact sizing, a proportional font for descriptions) in dark and light."
- [ ] **Step 7: Commit** `feat(web): every page on the sidebar shell`.

### Task 12: Close-out: completeness, baselines, docs

**Files:**
- Modify: `apps/web/visual/fidelity.spec.ts` (completeness case), `apps/web/visual/catalog.spec.ts-snapshots/*` (regenerated by workflow only)
- Modify: `AGENTS.md`, `.github/workflows/ci.yml` comments (final consistency pass), `docs/design/spec.md` header status line

- [ ] **Step 1: Completeness test.** Add a case to `fidelity.spec.ts`: `ACCEPTED` sorted equals the sorted components of `parseStateLists(spec)` that are not marked `(project B)`. Run → it fails if any A component skipped acceptance; fix by accepting it.
- [ ] **Step 2: Full local verification.** `pnpm verify` → all required checks pass; `pnpm --filter @capybara-hq/web visual -- fidelity sidebar.interaction` → PASS. The catalog screenshots fail as expected because the baselines are stale.
- [ ] **Step 3: Baselines.** Push, `gh workflow run visual-update.yml -f branch=feat/ui-refresh-a`, pull the bot's commit, then push an empty commit (`git commit --allow-empty -m "test(web): rerun CI after baseline update"`) so the PR checks rerun.
- [ ] **Step 4: Whole-PR side-by-side.** `COMPARE=<every ACCEPTED component> pnpm --filter @capybara-hq/web compare`; one last image-reviewing subagent pass over all pairs; hand `apps/web/compare-out/index.html` (and the PNGs) to the coordinator for the maintainer's review (spec §7.4 final step).
- [ ] **Step 5: Docs pass.** AGENTS.md "CI and checks" has entries for `check:tokens` (full), `design-char-icon` (in `check:web-ui`, full), the visual job's fidelity / interaction specs (by diff, with the EXTRA_INPUTS for `docs/design/{spec.md,tokens.json}`), and `reference-update` (manual). The ci.yml header comments say the same. `pnpm check:terms` passes.
- [ ] **Step 6: Commit** `chore: close out UI refresh A (acceptance, docs)`.

---

## Needs a maintainer decision (raised while planning)

These are places where the spec, the canvas and the code disagree, or where the spec leaves a gap A runs into. The plan's default is given for each, and the sign-off gate is the natural place to confirm them.

1. **Canvas values off the §4.3 scales.** The canvas uses radius 6 everywhere (scale: 4 / 8 / 10), type 11.5 / 12.5 / 14 (scale: 11 / 12 / 13 / 16), sidebar rows 30 (scale: 28 / 32), and status bar 26 (24 and 28 are equally near). Weights are 500 / 600, but Sarasa ships only 400 / 700 (Sarasa does have a SemiBold if wanted). Default: snap to the scale (radius sm 4 for controls, md 8 for cards; status bar 24 / 11; nav rows 32; conversation rows 28; weights 400 / 700). The alternative is changing `radius.sm` to 6 and adding a SemiBold face.
2. **"＋ New conversation" in A.** Composer-first creation is B (§5.2), so in A the item has nowhere to open an empty composer. Default: link to `/agents` (pick an agent); the group ＋ creates immediately, as the Agents list does today.
3. **Form anchors.** §4.5 replaces the Centered body (180 anchor nav + 760). The canvas form has no anchor nav, so FormPage loses `anchors`, including the "section has an error ●" marker. Error counts remain in the ActionRow. Confirm dropping anchors; the alternative is keeping a slim anchor list inside the 880.
4. **Every sidebar entry is "Untitled" until B.** Titles are model-generated (B) and nothing sets `title` today, so A's sidebar shows `未命名会话 · MM-DD HH:mm` for every conversation. Accept this, or move title generation (or at least manual rename) into A.
5. **Light-theme canvas inconsistencies.** `line-soft` appears as `#ECEBE6` / `#E6E5E0` / `#E2E1DB`, `line` as `#DAD9D3` / `#D6D5CF`, the selected ground as `#ECEBE6` vs `#E2E1DB`, and `faint` as `#9A9A94` vs `#85857F`. The light sidebar draws group labels (agent names, essential) in `#85857F` (≈3.3:1 on `#EFEEE9`, below AA). Defaults are in the Task 1 table; group labels use `muted`.
6. **Success colored on the canvas.** The list page's "connected" dot and the status bar's "system OK" dot are `ok` green, against §4.2.2 ("success, done and connected are not colored"). Default: no color for success (muted text, no dot); warn / fail keep color.
7. **Focus style.** The canvas form draws an accent border plus a 3px translucent halo (`focus-ring`) on inputs. Design spec §2.5 (2px outline) is not in spec §4.7's change table. Default: change §2.5 for inputs only (Task 4), with a new token `focus-ring`.
8. **Filter chip "selected" pattern.** The canvas's selected filter chip is an `ink` ground with `bg` text, which matches none of the five accent roles and no existing component. Default: a new FilterChip with `selected` = `selected` ground + `ink` border (no accent).
9. **Rail mode and the conversation section.** §4.4 says only "collapses to an icon rail". Default: the rail hides conversations behind an expand button that opens the drawer.
10. **Route naming in the spec.** The spec names "Directory" at `/directory` (becoming "Catalog"); the code already uses `/catalog` and the label "Catalog". Default: follow the code (as the spec's terminology note says).
11. **CI placement of state coverage.** §7.7 puts it in the visual job (by diff). That is what the plan does, but it means a docs-only change to `spec.md` state lists runs the visual job (EXTRA_INPUTS). An alternative is a static full-run check in `pnpm check`. Default: as §7.7.
12. **Third-party notices.** Lucide (ISC) and the two OFL fonts get license files next to the assets in `packages/design` (as Sarasa's `OFL.txt` does). The root `NOTICE` is not changed, because changing it ripples into every published package's copy (`release-notice`), and design ships only inside the web image. Confirm that this is enough for the image.
