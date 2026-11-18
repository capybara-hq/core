# Inline progress for GenerateImage in the web conversation

Status: draft for maintainer review (2026-11-18). Follows the image generation design
(`2026-11-17-image-generation-design.md`). Web and design system only.

## Intent

While the builtin `GenerateImage` tool runs, the conversation shows nothing but a running tool row;
the images then appear below the tool group and push the stream down. The maintainer wants an
in-place placeholder instead: a frame per requested image, shaped by the call's `aspect_ratio`,
filled with a slowly flowing colour field, which the arriving images replace at the same position.
A theme plugin restyles it through the existing client CSS mechanism (a `UI_PARTS` name), not a
new slot.

## Goals

- One placeholder per requested image (`n`, default 1) of a running `GenerateImage` call, drawn
  where that call's images will be drawn, as large as `ImageOutput` will draw them.
- The images replace their placeholders in place: same entry, same index, same box until the
  bitmap's natural size is known.
- Tokens only, both themes, a static rest pose under `prefers-reduced-motion`, no layout shift
  from the placeholder itself.
- Works the same after a reload mid-run, with history paging and in a sub-agent's thread.
- Restylable by theme plugins: `data-cap-part="image-placeholder"`.

## Non-goals

- Any kernel, event or tool contract change: no progress events, no partial images, no estimated
  time. The model's real progress is unknown; the placeholder says "working", not "how far".
- Placeholders for other tools that deliver files (`Deliver`, extension tools).
- Channels (IM): their cards are unchanged.
- A new extension slot or a replaceable component for the placeholder.
- Showing the placeholder in the parent conversation for a sub-agent's call (the parent shows the
  sub-agent row; the child's thread shows the placeholder).

## Facts this design builds on (origin/main, 2026-11-18)

- **The tool.** `GENERATE_IMAGE_SPEC` (`packages/kernel/src/tools/builtins/image/generate.ts:72`)
  takes `prompt`, `aspect_ratio` (enum `IMAGE_ASPECT_RATIOS` = `1:1 4:3 3:4 3:2 2:3 16:9 9:16`,
  `packages/plugin-sdk/src/model.ts:41`; absent = the model's default size), `n` (1..4, schema
  maximum; the kernel refuses `n` above `min(imageMaxPerCall, model.maxImages)` before any model
  call, `packages/kernel/src/models/images.ts:297-300`), `reference_images`, `name`, `file_path`.
  The model picks the closest size it supports to the ratio (`pickImageSize`, `images.ts:318`), so
  the output ratio is near, not always equal, to the requested one.
- **Delivery.** All images of a call are stored with `storeArtifacts`
  (`generate.ts:284-288`), which writes every `artifact_created` event of the call in **one**
  `eventLog.append` (`packages/kernel/src/tools/builtins/artifacts.ts:50-92`, one transaction): a
  reader sees all of a call's images or none. A late answer after an abort stores nothing
  (`generate.ts:263-264`). `file_path` copies happen after the artifacts are logged, so a call can
  have its images and still end with a tool error.
- **Call lifecycle in the log.** `assistant_message` carries the complete `tool_call` input; policy,
  approval and `tool.preExecute` hooks run before `tool_call_started`
  (`packages/kernel/src/tools/pipeline.ts:1168`, `:1210`, `:1224`); then `artifact_created`, then
  `tool_result`. A run that ends without a call's result leaves the call without one.
- **No tool-input streaming in the web.** Drafts carry only `text` and `thinking`
  (`apps/web/src/lib/stream.ts:22-33`, `TimelineDraft` `apps/web/src/lib/timeline.ts:407`); a tool
  row exists only once its `assistant_message` is logged, so `aspect_ratio` and `n` are always
  parsed when a row (and a placeholder) is first drawn.
- **Timeline.** `buildEventTimeline` (`timeline.ts:719`) is the one pure builder. A call's row is
  `pending` at its `assistant_message` (`timeline.ts:1083-1112`), `running` at
  `tool_call_started` (`:1116-1124`), done or failed at `tool_result` (`:1127`), failed on a
  `tool.preExecute` `hook_denied` (`:1255-1263`), and `cancelled` when its run closed without a
  result (`:1617-1622`). `artifact_created` of a known call is collected per tool group
  (`groupFiles`, `:1267-1285`) and emitted as one `{ kind: "files", key: "<group>:files" }` entry
  right after the group (`:1686-1702`, header comment `:33-35`); files are in log order.
- **Thread.** `files()` (`apps/web/src/components/conversation/Thread.tsx:624-656`) splits an
  entry into inline images (`isInlineImageType`), each an `ImageOutput` in a `Stack gap={8}`, and
  the rest as one `FileOutputs` grid below them. `SubagentPanel` renders a child's thread with the
  same `Thread` (`SubagentPanel.tsx:177`).
- **ImageOutput** (`packages/design/src/conversation/files.tsx:196-270`, spec
  `docs/design/spec.md` §6.16.20 `:2105-2125`): a frame `layout.inline-image` (360) wide,
  `max-width: 100%`, `panel` ground, radius `md`, a caption tool line below. Until the bitmap loads
  the frame keeps a fixed **16:9** box (`packages/design/src/styles/conversation.css:1407-1410`),
  then takes the natural ratio.
- **Parts.** `UI_PARTS` (`packages/plugin-sdk/src/ui-parts.ts`) is a literal catalog
  `{ name, version, owner, states, description }`; `states` is the ARIA set of `UiPartState`
  (`aria-busy` among them). `check:ui-parts` pins each `data-cap-part` literal to its owner files;
  `pnpm gen:ui-parts` writes `packages/design/src/ui-parts.generated.ts`,
  `packages/plugin-client/src/ui-parts.generated.ts` and `docs/guide/ui-parts.md`. `data-cap-state`
  exists only on the shell element (`run=`, `theme=`, `motion=`; client extensions spec §7.3), not
  per element. `UI_PART_NAMES` is in the SDK's public API report
  (`packages/plugin-sdk/api/plugin-sdk.api.md:4261`).
- **Design rules in the way.** Spec §3 (`docs/design/spec.md:222`): "Apart from agent avatars: no
  illustrations, gradients, frosted glass or emoji." Motion tokens are design-only
  (`docs/design/tokens.json:124`; themes override only `color`, `shadow`, `radius`,
  `packages/kernel/src/themes/render-css.ts:17-22`). The global reduced-motion rule ends every
  animation at its last keyframe (`packages/design/src/styles/base.css:43-50`). Visual baselines
  run with `animations: "disabled"` (`apps/web/playwright.visual.config.ts:19`).

## Design

### 1. When a call has placeholders

A call contributes placeholders exactly when all of these hold:

- its tool key is `GenerateImage` (a timeline constant beside `AGENT_TOOL`);
- its row is `running` (it has `tool_call_started` and no `tool_result`, its run is open, no hook
  denied it) and not `waiting`;
- fewer of its images are known than it asked for.

The count is `max(0, want - have)`, where `want` is the input `n` when it is an integer 1..4, else
1, and `have` is the number of the call's `artifact_created` files that are inline images. Since a
call's artifacts are logged in one append, `have` is 0 or all in practice; the subtraction keeps
the rule correct if that ever changes. A call that has its images shows them whatever its status
(today's behavior: a `file_path` failure after delivery keeps the images).

The ratio is the input `aspect_ratio` when it is one of `IMAGE_ASPECT_RATIOS`, else `null` (the
model's default size, unknown to the web), drawn as 1:1. `ImageRatio` is a design type
(`INLINE_IMAGE_RATIOS` in `packages/design/src/conversation/files.tsx`), a copy of the SDK list,
since neither the design package nor the web may import the SDK; a `tools/checks` test keeps the
two lists equal.

Nothing is drawn while the call is `pending` (policy, approval, hooks): no money is being spent
and the call may never run. A denied approval, a hook denial, an early refusal (`n` above the
model's cap, no image model) and an abort all end with no `running` row or a `failed` /
`cancelled` one, so the placeholders disappear and the row shows why, as today.

### 2. Where it sits: one ordered image list per tool group

The `files` entry of a group becomes:

```
{ kind: "files"; key: "<group>:files"; images: ImageSlot[]; others: FileRef[] }
ImageSlot =
  | { kind: "image"; file: FileRef; ratio: ImageRatio | null }
  | { kind: "generating"; key: string; callId: string; ratio: ImageRatio | null;
      index: number; count: number }
```

- The builder (not the page) classifies files with the design's `isInlineImageType`; `others`
  keeps today's log order and goes to `FileOutputs` as before.
- `images` is ordered by **the call's position in the group** (the row order), then log order
  within a call. Each call's slots are its images followed by its remaining placeholders. So when
  a call's images arrive they take exactly the indexes its placeholders held, even when another
  call of the same group (a parallel `GenerateImage`, a `Deliver`) finished first.
- The entry is emitted when a group has any image, other file or placeholder, so it exists from
  the first placeholder on, with the same key it will keep: React keeps the element and only the
  slot children change. Placeholder slot keys are `<callKey>:<index>`.
- `ratio` on an image slot is the producing call's ratio for `GenerateImage` files, else `null`;
  it is the pre-load hint of §3.
- Files of a call the builder does not know (its `assistant_message` is on an earlier, unloaded
  history page) stay a standalone `files` entry as today; such a call has no placeholder either.

Change to today: inline images of one group were in log order; they are now in call order. For
sequential calls the two are the same.

### 3. Sizing: no jump on the swap

- The placeholder frame is the `ImageOutput` frame: `layout.inline-image` wide, `max-width: 100%`,
  radius `md`, with `aspect-ratio` from its ratio (1:1 when `null`). A 9:16 placeholder is 640 high
  at full width, as a 9:16 image is today.
- It has the same caption tool line below the frame (same element and type, so the same height):
  "正在生成图片" / "Generating image", or "正在生成图片 2/3" / "Generating image 2/3" when the call
  asked for more than one, followed in `faint` by " · 16:9" when the ratio is known.
- `ImageOutput` gains an optional `ratio` (`ImageRatio`): before the bitmap loads, the frame uses
  that ratio instead of the fixed 16:9 (`data-ratio` attribute, one CSS rule per ratio: no inline
  style). After the load it takes the natural ratio as today. The swap is therefore placeholder
  box -> same box -> natural box; the last step moves only by the model's rounding to its nearest
  size (e.g. 1792×1024 for 16:9 is 1.75 against 1.78: about 3 px at 360 wide).
- Files that are not from `GenerateImage` keep the 16:9 pre-load box.

### 4. The visual

A new design component `ImagePlaceholder` (`packages/design/src/conversation/files.tsx`, exported
from the conversation index), spec §6.16.20 "Generating image":

- The frame on the `panel` ground, clipped to radius `md`, holding an oversized layer (a pseudo
  element) with three soft radial fields: `accent` at about 35 %, `accent-hover` at about 25 % and
  `ink` at about 8 %, each `color-mix(in oklab, <token> N%, var(--cb-panel))` and fading to
  transparent. The layer drifts slowly (translate and rotate only, compositor-friendly; one loop
  per `motion.flow`, a new design motion token of 6000 ms, `ease-in-out`, `alternate`), so the
  colours flow without strobing. Centred on top, an `image` icon (20) in `faint`.
- Light and dark both come from the tokens; a theme that changes `accent` or `panel` restyles it
  with no extra work.
- **Reduced motion:** the keyframes start and end on the same rest pose, so the global rule
  (animations end at their last keyframe) leaves a still, centred colour field. The shell's
  `motion=reduced` token and `@media (prefers-reduced-motion: reduce)` are available to themes.
- **No layout shift:** the frame's size is fixed by width and `aspect-ratio` from the first paint;
  the animation never touches layout properties.
- **Accessibility:** `role="img"`, `aria-busy="true"`, `aria-label` the caption text ("正在生成图片
  2/3，16:9" / "Generating image 2/3, 16:9"). No live region: the running tool row already
  announces the work.
- **Spec exception:** §3's "no gradients" gains a second exception beside agent avatars: "the
  generating image placeholder (§6.16.20), built from `accent`, `accent-hover`, `ink` and `panel`
  only." See open question 1.

### 5. Theme restyling

- `UI_PARTS` gains `image-placeholder` (version 1, owner
  `packages/design/src/conversation/files.tsx`, states `aria-busy`, description en "A generating
  image's placeholder in the conversation." / zh "对话中正在生成的图片的占位框。"); `pnpm
  gen:ui-parts` regenerates the three copies; the frame carries `data-cap-part="image-placeholder"`.
- Plugin CSS selects `[data-cap-part~="image-placeholder"]` (and its `::before` / `::after`, its
  icon), and may combine it with the shell's `[data-cap-state~="motion=reduced"]` or
  `[data-cap-state~="theme=…"]`. The client extensions spec §7.1 table gains the row.
- No per-element `data-cap-state`: the placeholder exists only while it is generating, so
  `aria-busy="true"` is its whole state.

### 6. Copy (design i18n, zh and en)

| Key | zh | en |
|---|---|---|
| `files.generating` | 正在生成图片 | Generating image |
| `files.generatingOf` | 正在生成图片 {index}/{count} | Generating image {index}/{count} |
| `files.generatingRatio` | {label}，{ratio} | {label}, {ratio} |

`files.generatingRatio` builds the `aria-label` when the ratio is known.

No 智能体 / agent wording is involved.

### 7. Where the code changes

- `apps/web/src/lib/timeline.ts`: the `files` entry shape of §2, the placeholder rule of §1, the
  header comment.
- `apps/web/src/components/conversation/Thread.tsx` `files()`: maps `images` to `ImageOutput`
  (with `ratio`) and `ImagePlaceholder`, `others` to `FileOutputs`. No styles.
- `packages/design`: `ImagePlaceholder`, `ImageOutput.ratio`, CSS in `styles/conversation.css`,
  i18n keys, `motion.flow` in `docs/design/tokens.json` (`pnpm gen:tokens`).
- `packages/plugin-sdk/src/ui-parts.ts` plus generated copies; spec texts below.
- `docs/design/spec.md` §3 exception, §2.5 motion list (`motion.flow`), §6.16.20 text, states and
  size table; reference blocks in `docs/design/reference/src/`; the client extensions spec §7.1
  row.

## Failure and edge cases

| Case | What the thread shows |
|---|---|
| Call waits for approval / policy / hooks | Pending row, no placeholder. |
| Approval denied, hook denied, early refusal | Failed row with its reason; no placeholder ever, or it disappears. |
| Model refusal or failure, timeout | Failed row; placeholders disappear (no error frame). |
| Run aborted mid-call | Row `cancelled`; placeholders disappear; nothing is stored. |
| Kernel restart mid-call | The resumed run records the call's result as unknown (a `tool_result` error); placeholders disappear. |
| Images stored, then `file_path` copy fails | Images shown (they replaced the placeholders); the row shows the error. |
| `n` above the model's cap | Refused before the model call: a brief placeholder at most, then a failed row. |
| `n` invalid or absent; `aspect_ratio` absent or unknown | One placeholder / 1:1, no ratio in the caption. |
| Output ratio differs slightly from the request | Box keeps the requested ratio until the bitmap loads, then the natural ratio (a few px). |
| Two `GenerateImage` calls in one group, second finishes first | Each call keeps its own slots (call order); nothing moves above the first call's placeholders. |
| A `Deliver` in the same group | Its image (if any) takes its own call's slot; other files go to the grid below, as today. |
| Page reload mid-run | The builder is pure over the log: a `running` call redraws its placeholders. |
| History paging | The running call is in the last page; if its `assistant_message` is on an unloaded page, no placeholder and its images render as a standalone entry (today's fallback). |
| Sub-agent's call | The child's thread (`SubagentPanel` uses `Thread`) shows it; the parent shows the sub-agent row. |
| Several placeholders, slow devices | Transform-only animation on one layer per frame; reduced motion stops it. |

## Testing

- **Timeline unit tests** (`apps/web/test/timeline.test.ts`, recorded-log style): pending call has
  no placeholder; `running` call with `n: 3, aspect_ratio: "16:9"` gives three slots with index and
  ratio; artifacts arrive -> the same indexes hold images with the call's ratio, entry key
  unchanged; failed / cancelled / hook-denied calls drop them; two parallel calls finishing out of
  order keep call order; invalid `n` / ratio fall back; a `Deliver` image in the same group; a call
  with images and a later tool error keeps its images.
- **Design jsdom** (`packages/design/test/files.test.tsx`): `ImagePlaceholder` aria (`role`,
  `aria-busy`, label in zh and en), `data-ratio` per ratio, caption with and without count;
  `ImageOutput.ratio` sets the pre-load box and drops it after load.
- **Web jsdom** (`apps/web/test/chat-image-progress.test.tsx`, a new file on the
  emitting `FakeEventSource` of `test/support/conversation.ts`): rerendering the thread from the running log
  to the delivered log keeps the files entry's DOM node and puts each image at its placeholder's
  index; `findNestedBoxes` finds no box in a box.
- **Visual**: catalog blocks and reference blocks for the new `file-outputs` states
  `generating` (one 1:1, light and dark), `generating-several` (2 × 3:4 with captions) and
  `generating-wide` (16:9 beside a finished image in the same entry); the size table rows (frame
  width `layout.inline-image`, radius `md`, ground `panel`, caption `type.small`) measured by
  `fidelity.spec.ts`; reference PNGs through the `reference-update` workflow and screenshot
  baselines through the `visual-update` workflow (animations are disabled
  there, so the frame is the rest pose); compare reviewed blind per the writing-web-ui flow.
- **Checks**: `check:ui-parts`, `check:tokens`, `check:i18n`, `check:web-ui`, `check:sdk-api`,
  `check:sdk-api-changeset`.

## Rollout

One PR: design component and spec, web timeline and thread, SDK part. Changesets:
`@capybara-hq/plugin-sdk` (patch: a new part name, additive), `@capybara-hq/plugin-client` (patch:
its generated parts copy), `@capybara-hq/design` and `@capybara-hq/web` (patch, private, versioned
like the earlier parts round), `@capybara-hq/capybara` (the image carries the web). No kernel change,
no migration, no config. The theme-cyberpunk plugin may add a rule for the new part afterwards in
capybara-hq/plugins; nothing breaks without it.

## Open questions (with recommendations)

1. **The §3 "no gradients" rule.** The flowing colour field is a gradient. *Recommendation:* add
   one named exception for this placeholder (built only from `accent`, `accent-hover`, `ink`,
   `panel`), like agent avatars; nothing else may cite it.
2. **New colour tokens or existing ones?** Dedicated `generate-*` tokens would be theme-overridable
   only by growing the SDK's theme token set. *Recommendation:* existing tokens via `color-mix`; a
   theme already restyles it through `accent`, and through the part for anything further.
3. **Failure look.** Keep a frame with an error, or remove it? *Recommendation:* remove; the tool
   row already carries the error and its detail, and a dead frame would be a second error UI.
4. **Image order inside a group.** *Recommendation:* call order (needed for a true in-place swap
   with parallel calls); other files keep log order.
5. **Show during an approval wait?** *Recommendation:* no, only from `tool_call_started`: nothing
   runs before, and the approval card is the thing to look at.
6. **Unknown ratio (no `aspect_ratio`).** *Recommendation:* 1:1 (the common default size of image
   models), no ratio in the caption.
7. **Also expose the finished image as a part (`image-output`)?** *Recommendation:* not in this
   change; a theme that wants matching frames can ask for it separately.
8. **Elapsed time in the placeholder?** *Recommendation:* no; the running tool row right above
   shows it.

## AGENTS.md rules touched

- **Web UI.** `apps/web` writes no styles: the placeholder and the ratio hint are design
  components; the timeline stays the one builder (the page does not order or classify files).
- **Extension UI / client CSS.** A new `UI_PARTS` entry with its literal `data-cap-part` in its
  owner file (`check:ui-parts`); no new slot, no new `data-cap-state` token.
- **SDK public API.** `UI_PART_NAMES` grows: `pnpm gen:sdk-api` and a changeset bumping
  `@capybara-hq/plugin-sdk` (and `@capybara-hq/plugin-client` for its generated copy).
- **Language / i18n.** Two new design messages in zh and en; no 企业, no Latin "agent".
- **Runtime and replay.** Untouched: nothing model-visible changes, no new events.
- No new AGENTS.md rule.
