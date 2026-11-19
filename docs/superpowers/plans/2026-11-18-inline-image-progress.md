# Inline image progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, layered
> with the repo's `wave-planned-subagent-development` skill (wave table below), to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** While a `GenerateImage` call runs, the web conversation draws one flowing placeholder per
requested image, shaped by the call's `aspect_ratio`, which the delivered images replace in place.

**Architecture:** The pure timeline builder (`apps/web/src/lib/timeline.ts`) turns a group's
`files` entry into an ordered `images` slot list (call order; images then placeholders per call)
plus `others`. The design package gains `ImagePlaceholder` and an `ImageOutput.ratio` pre-load hint;
the web `Thread` only maps slots to those components. Theme plugins restyle the placeholder through
a new `UI_PARTS` entry `image-placeholder`. No kernel, event or tool change.

**Tech Stack:** TypeScript, React 19 / Next 16 (apps/web), plain CSS in `packages/design`, Vitest
(jsdom for design and web), Playwright visual and fidelity specs.

**Spec:** `docs/superpowers/specs/2026-11-18-inline-image-progress-design.md` (open questions
decided as recommended: one named §3 exception, existing tokens via `color-mix`, failed calls drop
their placeholders, call order inside a group, nothing while `pending`, unknown ratio = 1:1, no
`image-output` part, no elapsed time).

## Global Constraints

- `apps/web` writes no styles (`pnpm check:web-ui`); the placeholder, the ratio boxes and the
  animation live in `packages/design`.
- The design package and the web import no `@capybara-hq/plugin-sdk`: the ratio list is a design
  copy (`INLINE_IMAGE_RATIOS`) of `IMAGE_ASPECT_RATIOS` = `1:1 4:3 3:4 3:2 2:3 16:9 9:16`.
- Colours only from tokens: `accent` ~35 %, `accent-hover` ~25 %, `ink` ~8 %, each
  `color-mix(in oklab, var(--cb-<token>) N%, var(--cb-panel))` fading to transparent, on `panel`.
- Animation: transform only (translate, rotate) on one pseudo element; one loop per `motion.flow`
  = `6000ms`, `ease-in-out`, `infinite alternate`; `0%` and `100%` keyframes equal the element's
  static pose (`transform: none`), so the global reduced-motion rule leaves a still field.
- Placeholder frame: `layout.inline-image` wide, `max-width: 100%`, radius `md`, `panel` ground,
  `aspect-ratio` from its ratio (1:1 when `null`), caption the same `cb-tool-line` as
  `ImageOutput`.
- Copy (design i18n): `files.generating` 正在生成图片 / Generating image; `files.generatingOf`
  正在生成图片 {index}/{count} / Generating image {index}/{count}; `files.generatingRatio`
  {label}，{ratio} / {label}, {ratio}. No 企业, no Latin "agent" in zh.
- Placeholder ARIA: `role="img"`, `aria-busy="true"`, `aria-label` = caption text (with the ratio
  via `files.generatingRatio` when known). No live region.
- Part: `image-placeholder`, version 1, owner `packages/design/src/conversation/files.tsx`, states
  `["aria-busy"]`, description en "A generating image's placeholder in the conversation." / zh
  "对话中正在生成的图片的占位框。".
- English for comments; new comments in English (`pnpm check:english-comments --base origin/main`).
- Run single tests from the worktree root: `pnpm exec vitest run <path>`.

## Review Focus

1. A call `running` in a run that already closed (abort, crash without `run_aborted` until the next
   run) must show no placeholder: placeholders are computed after the builder's "cancelled" pass,
   never inside the event loop. (Task 3 test "an aborted run drops the placeholders".)
2. A group whose only content is placeholders must still emit its `files` entry: the builder's early
   return (`groupFiles.size === 0 && …`) must not skip it. (Task 3 test "a lone running call
   emits the entry".)
3. An `n` that is a float, a string or 0 / 5 falls back to 1, and an `aspect_ratio` outside the enum
   (e.g. `"21:9"`) gives `ratio: null`. (Task 3 test "invalid n and ratio fall back".)
4. A ratio added to the SDK list later must not silently render 1:1 or lose its CSS box: a
   `tools/checks` test pins the design copy to the SDK list, and a design test pins one CSS rule per
   ratio. (Task 2 tests "ratios match the SDK" and "every ratio has a box".)
5. Rerendering from the running log to the delivered log keeps the `files` entry's DOM node and
   puts each image at its placeholder's index, also for two parallel calls finishing out of order.
   (Task 3 tests "out-of-order calls keep call order" and "placeholders, then images in place".)

---

## Wave plan (for the ledger)

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 Design spec, reference set, fixture | — | `docs/design/spec.md`, `docs/design/reference/src/*`, design fixtures, client-ext spec | normal | 1 | batched |
| 2 Design component, token, SDK part | — | `packages/design` (files.tsx, css, i18n, index), tokens, SDK ui-parts + generated, checks test, changeset | normal | 1 | batched |
| 3 Timeline slots and thread | 2 (`ImagePlaceholder`, `ImageRatio`, `isImageRatio`) | `timeline.ts`, `Thread.tsx`, web tests, web changeset | normal | 2 | batched |
| 4 Catalog blocks | 1 (fixture), 2 (components) | `apps/web/src/dev/catalog/conversation-blocks.tsx` | normal | 2 | batched |
| 5 Visual acceptance and baselines | 1–4 | compare, `reference-update` + `visual-update` workflows (controller) | normal | 3 | controller |

The entry shape change and its one consumer (`Thread.tsx`) stay in one task so every commit
typechecks.

No task touches a trust boundary, migration, multi-replica state or a cross-tenant rule.

---

### Task 1: Design spec, reference set and fixture

The spec change comes first in the review (writing-web-ui "Adding a component", step 1).

**Files:**
- Modify: `docs/design/spec.md` (§2.5 motion line `:189`; §3 last bullet `:222`; §6.16.20 `:2105-2125`)
- Modify: `docs/design/reference/src/file-outputs.html`, `docs/design/reference/src/conversation.js` (`fileOutputs`, `:749`), `docs/design/reference/src/reference.css`
- Modify: `packages/design/src/fixtures/conversation.ts` (`FILE_FIXTURE`, `:836`)
- Modify: `docs/superpowers/specs/2026-11-09-client-extensions-design.md` (§7.1 table, after `agent-chip` `:642`)

**Interfaces:**
- Produces: `FILE_FIXTURE.generating: { ratio: "1:1" | …; several: { ratio: "3:4"; count: 2 }; wide: { ratio: "16:9" } }`
  (exact shape your choice, documented in the fixture type) used by Task 4 and the reference
  renderer; reference block ids `file-outputs-generating`, `file-outputs-generating-several`,
  `file-outputs-generating-wide`.

- [ ] **Step 1: Spec §3 exception.** Replace "Apart from agent avatars: no illustrations, gradients,
  frosted glass or emoji." with: "Apart from agent avatars and the generating image placeholder
  (§6.16.20, built from `accent`, `accent-hover`, `ink` and `panel` only): no illustrations,
  gradients, frosted glass or emoji. Nothing else may cite these exceptions."
- [ ] **Step 2: Spec §2.5 motion.** Add "the generating image placeholder's colour field drifts once
  per `motion.flow` (6000ms, `ease-in-out`, alternate; transform only)" to the motion list, and
  "the placeholder still" to the reduced-motion sentence.
- [ ] **Step 3: Spec §6.16.20.** Add a "**Generating image**" bullet (`ImagePlaceholder`,
  `image-placeholder`): frame, colour field, icon (`image` 20, `faint`), caption copy, ARIA, sizing
  by ratio (Global Constraints); and to the Image bullet: "Before the bitmap loads the frame keeps
  the producing call's ratio when known (`ratio`), else 16:9." Extend
  `States:` with `generating`, `generating-several`, `generating-wide`, and the size table with:

  ```
  | image-placeholder | generating | width | layout.inline-image |
  | image-placeholder | generating | border-radius | radius.md |
  | image-placeholder | generating | background-color | color.panel |
  | tool-line | generating | font-size | type.small |
  ```
- [ ] **Step 4: Fixture and reference blocks.** Add `FILE_FIXTURE.generating`; add three
  `<section data-ref-block="file-outputs-generating…" style="width:752px" data-pad>` blocks to
  `file-outputs.html`; render them in `conversation.js` `fileOutputs` (zh copy: 正在生成图片,
  正在生成图片 1/2 · 3:4, `generating-wide` = a 16:9 placeholder above the existing chart image
  figure); draw the rest pose in `reference.css` (`r-img-gen` frame with the three radial fields at
  their static position, `image` icon centred), tokens only.
- [ ] **Step 5: Client extensions spec §7.1 row.**
  `| \`image-placeholder\` | a generating image's placeholder | design \`conversation/files.tsx\` | \`aria-busy\` |`
- [ ] **Step 6: Look at it locally.** Run `pnpm --filter @capybara-hq/web reference:render` and open
  the three new PNGs (look only; never commit them, Task 5 renders them in CI).
  Expected: three blocks per theme, frames 360 wide, 1:1 / 3:4 / 16:9.
- [ ] **Step 7: Commit.**

```bash
git add docs/design/spec.md docs/design/reference/src packages/design/src/fixtures/conversation.ts \
  docs/superpowers/specs/2026-11-09-client-extensions-design.md
git commit -m "docs(design): spec and reference for the generating image placeholder"
```

---

### Task 2: Design component, motion token and SDK part

**Files:**
- Modify: `docs/design/tokens.json` (`motion`, `:124`) then generated `packages/design/src/styles/tokens.css`
- Modify: `packages/design/src/conversation/files.tsx` (`ImageOutput` `:201-270`, new `ImagePlaceholder`, `INLINE_IMAGE_RATIOS`)
- Modify: `packages/design/src/conversation/index.ts` (exports `:66-80`)
- Modify: `packages/design/src/styles/conversation.css` (after `.cb-image-frame` `:1399-1410`)
- Modify: `packages/design/src/i18n.ts` (zh `:415`, en `:998`)
- Modify: `packages/plugin-sdk/src/ui-parts.ts`, `packages/plugin-sdk/test/ui-parts.test.ts`
- Generated: `packages/design/src/ui-parts.generated.ts`, `packages/plugin-client/src/ui-parts.generated.ts`, `docs/guide/ui-parts.md`, `packages/plugin-sdk/api/plugin-sdk.api.md`
- Test: `packages/design/test/files.test.tsx`, `packages/design/test/ui-parts.test.tsx`
- Create: `tools/checks/test/image-ratios.test.ts`, `.changeset/image-placeholder-part.md`

**Interfaces:**
- Produces (from `@capybara-hq/design`):
  - `export const INLINE_IMAGE_RATIOS = ["1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16"] as const;`
  - `export type ImageRatio = (typeof INLINE_IMAGE_RATIOS)[number];`
  - `export const isImageRatio = (v: unknown): v is ImageRatio`
  - `ImageOutput({ …existing, ratio?: ImageRatio })`
  - `ImagePlaceholder({ ratio, index, count }: { ratio: ImageRatio | null; index: number; count: number }): JSX.Element`
    — `index` 0-based, shown as `index + 1`; the count shows only when `count > 1`.

- [ ] **Step 1: Write the failing tests.**
  In `packages/design/test/files.test.tsx`:
  - `ImagePlaceholder: role, busy and label` — render `ratio="16:9" index={1} count={3}` in en:
    `getByRole("img", { name: "Generating image 2/3, 16:9" })` has `aria-busy="true"`,
    `data-cap-part="image-placeholder"`, `data-ratio="16:9"`; caption text
    `"Generating image 2/3 · 16:9"`. Same in zh: name `"正在生成图片 2/3，16:9"`.
  - `ImagePlaceholder: one image, unknown ratio` — `ratio={null} index={0} count={1}`: name
    `"Generating image"`, `data-ratio="1:1"`, caption has no ` · `.
  - `ImageOutput: ratio sets the pre-load box until load` — `ratio="3:4"`: the `image-frame` part
    has `data-ratio="3:4"`; after `fireEvent.load(img)` it has `data-loaded="true"` and no
    `data-ratio`. Without `ratio`: no `data-ratio` before load.
  - `every ratio has a box` — read `src/styles/conversation.css`; for each of `INLINE_IMAGE_RATIOS`
    expect a selector containing `[data-ratio="<r>"]` with `aspect-ratio: <a> / <b>`; expect the
    `@keyframes cb-image-flow` block to start with `0%,\s*100%\s*{\s*transform:\s*none`.
  In `packages/design/test/ui-parts.test.tsx`: the rendered `ImagePlaceholder`'s part token is in
  `UI_PART_NAMES`.
  In `packages/plugin-sdk/test/ui-parts.test.ts`: length `30`;
  `uiPart("image-placeholder")?.states` equals `["aria-busy"]`.
  In `tools/checks/test/image-ratios.test.ts` (`ratios match the SDK`):
  `expect([...INLINE_IMAGE_RATIOS]).toEqual([...IMAGE_ASPECT_RATIOS])`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run packages/design/test/files.test.tsx packages/design/test/ui-parts.test.tsx packages/plugin-sdk/test/ui-parts.test.ts tools/checks/test/image-ratios.test.ts`
  Expected: FAIL (`ImagePlaceholder` / `INLINE_IMAGE_RATIOS` not exported, length 29).
- [ ] **Step 3: Token.** Add `"flow": "6000ms"` to `tokens.json` `motion`; run `pnpm gen:tokens`.
  Expected: `--cb-motion-flow: 6000ms;` in `tokens.css`; the SDK theme-tokens file unchanged.
- [ ] **Step 4: SDK part.** Append the `image-placeholder` entry (Global Constraints) to
  `UI_PART_NAMES` and `UI_PARTS`; run `pnpm gen:ui-parts` and `pnpm gen:sdk-api`.
- [ ] **Step 5: Component, CSS, copy.** In `files.tsx`: the ratio list and guard; `ImageOutput`
  sets `data-ratio={dims ? undefined : ratio}` on the frame; `ImagePlaceholder` renders
  `<figure className="cb-image-output">` holding a frame `div.cb-image-placeholder`
  (`data-part="image-placeholder"`, literal `data-cap-part="image-placeholder"`, `role="img"`,
  `aria-busy="true"`, `aria-label`, `data-ratio={ratio ?? "1:1"}`) with
  `<Icon name="image" size={20} />` (faint, `aria-hidden`), and the caption
  `figcaption.cb-tool-line[data-part="tool-line"][aria-hidden="true"]` (the label in the tool
  line's own `muted`, the ratio ` · 16:9` in `cb-faint`). In `conversation.css`: one rule per
  ratio for both `.cb-image-frame:not([data-loaded="true"])[data-ratio="…"]` and
  `.cb-image-placeholder[data-ratio="…"]` (the existing 16:9 fallback stays for frames without
  `data-ratio`); `.cb-image-placeholder` (the `.cb-image-frame` box values, `display: grid`,
  `place-items: center`, `isolation: isolate`); its `::before` (`inset: -50%`, three
  `radial-gradient`s per Global Constraints, `z-index: -1`, `will-change: transform`,
  `animation: cb-image-flow var(--cb-motion-flow) ease-in-out infinite alternate`);
  `@keyframes cb-image-flow` with `0%, 100% { transform: none; }` and two intermediate poses
  (translate within ±12 %, rotate within ±20deg). Add the three i18n keys in zh and en.
  Export `ImagePlaceholder`, `INLINE_IMAGE_RATIOS`, `type ImageRatio`, `isImageRatio` from
  `conversation/index.ts`.
- [ ] **Step 6: Run the tests and checks.**
  Run: the Step 2 command, then `pnpm check:ui-parts && pnpm check:tokens && pnpm check:i18n && pnpm check:sdk-api && pnpm check:web-ui`
  Expected: PASS.
- [ ] **Step 7: Changeset** `.changeset/image-placeholder-part.md`:

  ```
  ---
  "@capybara-hq/plugin-sdk": patch
  "@capybara-hq/plugin-client": patch
  "@capybara-hq/design": patch
  ---

  New UI part `image-placeholder` (`aria-busy`): the placeholder the conversation draws while an
  image is being generated. The design package adds `ImagePlaceholder` and an `ImageOutput.ratio`
  pre-load hint.
  ```
  Run: `pnpm check:sdk-api-changeset` — Expected: PASS.
- [ ] **Step 8: Commit.**

```bash
git add docs/design/tokens.json packages/design packages/plugin-sdk packages/plugin-client \
  docs/guide/ui-parts.md tools/checks/test/image-ratios.test.ts .changeset/image-placeholder-part.md
git commit -m "feat(design): generating image placeholder and the image-placeholder part"
```

---

### Task 3: Timeline image slots and the thread

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` (header comment `:33-35`; entry type `:394`; `groupFiles` `:768-769`; `artifact_created` `:1267-1285`; `withExtras` `:1686-1702`; a `GENERATE_IMAGE_TOOL` constant beside `AGENT_TOOL` `:417`)
- Modify: `apps/web/src/components/conversation/Thread.tsx` (`files()` `:624-656`, `case "files"` `:874-875`)
- Test: `apps/web/test/timeline.test.ts`
- Create: `apps/web/test/chat-image-progress.test.tsx`, `.changeset/inline-image-progress.md`

**Interfaces:**
- Consumes: `isInlineImageType`, `isImageRatio`, `type ImageRatio`, `ImagePlaceholder`,
  `ImageOutput.ratio` from `@capybara-hq/design`.
- Produces:

  ```ts
  export const GENERATE_IMAGE_TOOL = "GenerateImage";
  export type ImageSlot =
    | { kind: "image"; file: FileRef; ratio: ImageRatio | null }
    | { kind: "generating"; key: string; callId: string; ratio: ImageRatio | null;
        index: number; count: number };
  // TimelineEntry member replacing { kind: "files"; key; files }:
  | { kind: "files"; key: string; images: ImageSlot[]; others: FileRef[] }
  ```
  Placeholder `key` = `<row.id>:<index>`; `index` 0-based within the call, `count` = `want`.

- [ ] **Step 1: Write the failing tests** (recorded-log style, existing helpers `calls`, `started`,
  `result`, `ev`, plus a local `image(seq, callId, id)` making an `artifact_created` with
  `contentType: "image/png"`). Each builds with `buildTimeline(events, [], new Map(), "en")`:
  - `a pending GenerateImage call has no placeholder` — call logged, no `tool_call_started`: no
    `files` entry.
  - `a running call gives one slot per requested image` — `n: 3, aspect_ratio: "16:9"`, started:
    `files.images` = three `generating` slots, `index` 0,1,2, `count` 3, `ratio "16:9"`, keys
    `r1:<id>:0` …; `others` empty.
  - `a lone running call emits the entry` — the group's only content is that call (no file
    anywhere in the log): the entry exists, key `<group>:files`.
  - `images replace their placeholders` — then three `image` events: same entry key, `images` =
    three `image` slots with `ratio "16:9"` in log order.
  - `failed, hook-denied and aborted calls drop the placeholders` — a `tool_result` with
    `isError: true` and no artifacts; a `hook_denied` (`tool.preExecute`, the callId); a
    `run_aborted` after `tool_call_started`: no `files` entry in each.
  - `invalid n and ratio fall back` — `n` in `[2.5, "2", 0, 5, undefined]` → one slot;
    `aspect_ratio: "21:9"` → `ratio: null`.
  - `out-of-order calls keep call order` — one group with calls A (`n: 2`) then B (`n: 1`), both
    started; B's image logged first: `images` = [A gen 0, A gen 1, B image]; then A's images:
    [A image, A image, B image].
  - `a Deliver in the same group` — `Deliver` of a png and a csv between two `GenerateImage`
    calls: the png slot sits at the Deliver row's position with `ratio: null`; the csv is in
    `others`.
  - `images survive a later tool error` — artifacts then `tool_result` `isError: true`: the
    images stay, no placeholder.
  - `a waiting call shows no placeholder` — a `question_asked` naming the started call (sets the
    row's `waiting`, `timeline.ts:1477`): no slots.
  - Update the existing test `artifact_created lands after the group of its call…` (`:305-329`)
    to read `files.others[0]`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run apps/web/test/timeline.test.ts`
  Expected: FAIL (`images` undefined).
- [ ] **Step 3: Implement.** `groupFiles` keeps `{ callKey: string; file: FileRef }` per file. In
  the `withExtras` pass (it runs after the "Calls of a run that ended without a result" pass —
  keep it there, see Review Focus 1), for each `tools` entry walk `entry.rows` in order: a row's
  inline images become `image` slots (ratio = `isImageRatio(input.aspect_ratio)` when the row's
  `toolKey` is `GENERATE_IMAGE_TOOL`, else `null`), then, when the row is that tool, `status ===
  "running"` and no `waiting`, `max(0, want - have)` `generating` slots with indexes `have …
  want-1`; non-image files go to `others` in log order. Emit the entry when `images` or `others`
  is non-empty, and include "any running `GenerateImage` row" in the early-return guard. A file of
  an unknown call stays a standalone entry `{ images: inline ? [{ kind: "image", file, ratio: null }] : [], others: inline ? [] : [file] }`.
  `want` = `n` when `Number.isInteger(n) && n >= 1 && n <= 4`, else 1. Update the header comment
  (call order for images, placeholders while a `GenerateImage` call runs).
- [ ] **Step 4: Run the timeline tests.**
  Run: `pnpm exec vitest run apps/web/test/timeline.test.ts apps/web/test/timeline-waiter.test.ts apps/web/test/timeline-background.test.ts apps/web/test/timeline-interjections.test.ts`
  Expected: PASS.

- [ ] **Step 5: Write the failing thread test** `apps/web/test/chat-image-progress.test.tsx`, on
  `renderChatRoute` and the emitting `FakeEventSource` of `test/support/conversation.ts`
  (as `agent-map.test.tsx` uses them). Log: user message, `run_started`, an assistant message
  with a `GenerateImage` call `{ prompt: "p", n: 2, aspect_ratio: "3:4" }`, `tool_call_started`.
  - `placeholders, then images in place` — two `getAllByRole("img", { name: /Generating image/ })`;
    remember the `Stack` holding them (`placeholder.closest("figure").parentElement`). Emit the
    two `artifact_created` events (png) on the stream: no placeholder remains; the two images
    (`getByRole("img", { name: <file name> })`) are in figures that are children 0 and 1 of the
    same `Stack` node (`toBe` the remembered element); each `[data-part="image-frame"]` has
    `data-ratio="3:4"` (jsdom never loads the bitmap).
  - `no box in a box` — `findNestedBoxes(container)` from `@capybara-hq/design/reference` is empty
    in both states.
  - `a failed call removes them` — emit a `tool_result` with `isError: true`: no `Generating image`
    img remains.
- [ ] **Step 6: Run it to see it fail.**
  Run: `pnpm exec vitest run apps/web/test/chat-image-progress.test.tsx`
  Expected: FAIL (no placeholder drawn).
- [ ] **Step 7: Implement `files(e)`** taking the entry: `images` mapped in order to
  `ImageOutput` (`key={slot.file.id}`, `ratio` when non-null, the existing src / open / download
  props) or `ImagePlaceholder` (`key={slot.key}`, `ratio`, `index`, `count`), then `others` to
  `FileOutputs` exactly as today. No classification or ordering in the page.
- [ ] **Step 8: Run tests and checks.**
  Run: `pnpm exec vitest run apps/web/test/timeline.test.ts apps/web/test/chat-image-progress.test.tsx apps/web/test/chat-files.test.tsx apps/web/test/conversation-page.test.tsx && pnpm typecheck && pnpm check:web-ui && pnpm lint`
  Expected: PASS.
- [ ] **Step 9: Changeset** `.changeset/inline-image-progress.md`:

  ```
  ---
  "@capybara-hq/web": patch
  "@capybara-hq/capybara": patch
  ---

  While GenerateImage runs, the conversation shows one placeholder per requested image, shaped by
  the requested aspect ratio, and the images replace them in place.
  ```
- [ ] **Step 10: Commit.**

```bash
git add apps/web/src/lib/timeline.ts apps/web/src/components/conversation/Thread.tsx \
  apps/web/test/timeline.test.ts apps/web/test/chat-image-progress.test.tsx \
  .changeset/inline-image-progress.md
git commit -m "feat(web): draw generating image placeholders in the conversation"
```

---

### Task 4: Catalog blocks

**Files:**
- Modify: `apps/web/src/dev/catalog/conversation-blocks.tsx` (`fileOutputsBlocks` `:971-992`; `ChartOutput` `:930-968`)

**Interfaces:**
- Consumes: `ImagePlaceholder`, `ImageOutput` (Task 2); `FILE_FIXTURE.generating` (Task 1).

- [ ] **Step 1: Add the blocks** `file-outputs-generating` (one 1:1 `ImagePlaceholder`,
  `count` 1), `file-outputs-generating-several` (two 3:4, indexes 0 and 1 of 2, in a
  `Stack gap={8}`), `file-outputs-generating-wide` (a 16:9 placeholder above the chart
  `ImageOutput` with `ratio="16:9"`, in a `Stack gap={8}`), each a `Block` with the reference id.
  Give the placeholder no extra wrapper box (one box is enough).
- [ ] **Step 2: Checks.**
  Run: `pnpm check:web-ui && pnpm --filter @capybara-hq/web typecheck`
  Expected: PASS.
- [ ] **Step 3: Commit.**

```bash
git add apps/web/src/dev/catalog/conversation-blocks.tsx
git commit -m "feat(web): catalog blocks for the generating image placeholder"
```

---

### Task 5: Visual acceptance and baselines (controller)

Run by the controller after waves 1–2 are reviewed and the branch is pushed with its PR.

- [ ] **Step 1: Branch gate.** Run `pnpm verify` (or `CAPYBARA_TEST_WORKERS=4 pnpm verify`) and
  `pnpm check:english-comments --base origin/main`. Expected: PASS.
- [ ] **Step 2: Compare.** In the Linux Playwright image `mcr.microsoft.com/playwright:v1.64.1-noble`
  against a local `next start`: `COMPARE=file-outputs pnpm --filter @capybara-hq/web compare`.
  Dispatch a blind image-reviewing subagent with only the `apps/web/compare-out/*-{dark,light}.{ref,impl}.png`
  paths of the `file-outputs-generating*` blocks and the writing-web-ui instruction text. Fix every
  severe and moderate difference (back to Task 1 or 2 files) and repeat; list the minor ones in the
  PR. `file-outputs` is already in `apps/web/visual/accepted.ts`, so
  `pnpm --filter @capybara-hq/web visual fidelity` must pass with the new size-table rows and states.
- [ ] **Step 3: Reference PNGs.** Trigger the `reference-update` workflow (`workflow_dispatch`,
  input `branch` = the PR branch); pull its commit of the new `docs/design/reference/*.png`.
- [ ] **Step 4: Screenshot baselines.** Trigger the `visual-update` workflow on the PR branch
  (input `branch`); pull its commit; attach the diff images to the PR (animations are disabled
  there, so the frames show the rest pose). Never commit local `*-darwin.png`.
- [ ] **Step 5: CI green** (`ci-ok`, `issue-linked`).
