# Task 4 report: pixel-animal avatar presets and Avatar / AvatarPicker

Status: DONE. Commit `64ffc12a feat(design): pixel-animal avatar presets and the Avatar component`, pushed to `fix/rc2-acceptance` (the remote had not moved since `ac0cb752`, so no rebase was needed).

## What was built

- **Presets** (`packages/design/src/display/avatar-presets.ts`): `AVATAR_PRESET_IDS` (the 10 ids, in picker order), `type PresetId`, `AVATAR_PRESETS: Record<PresetId, { bitmap; palette; ground }>` and `AVATAR_GRID = 12`. Palette values and grounds are typed `TokenName`, so the data holds no colour literals. A bitmap character maps to a token. `.` and `O` (an eye cut-out, as in the logo) are left to the ground.
- **Bitmap size**: 12×12 for all ten. The pixel unit is `round(size / 12)`: 16→1, 22→2, 28→2, 40→3, 64→5. The drawing is centred through the viewBox (`${-off} ${-off} size size`). At 22 the 24 px drawing is clipped 1 px on each side. The bitmaps keep their outer ring mostly ground, so nothing important is lost.
- **`bitmapCells`** (logo.tsx) now takes an optional 4th argument, `cell = "X"`. The logo and the working line are unchanged. Avatar reuses the helper with one path per palette token.
- **`Avatar({ value, name, size })`** (`avatar.tsx`):
  - a preset draws an `<svg shape-rendering="crispEdges">` with one `<path style="fill:var(--cb-<token>)">` per token, on `style="background:var(--cb-<ground>)"`;
  - an image draws `<img alt="">` and falls back to the initial on `error`;
  - `null`, or an unknown preset id, draws the initial square (`initialOf`, `ink` on `selected`, 600, the same look as today's initial tiles);
  - the root carries `data-part="avatar"`, `data-kind`, `data-size` and `data-preset`, and is `aria-hidden`, because the name is always written next to it;
  - CSS sizes it by `data-size`. Radius is `sm`, and `md` at 64. The initial's type is micro / micro / small / h2 / h1.
  - Also exported: `AVATAR_SIZES`, `AvatarSize`, `AvatarValue`, `AVATAR_UPLOAD_ACCEPT = "image/png,image/jpeg,image/webp"`.
- **`AvatarPicker({ value, onChange, onUpload?, uploadOffReason?, label? })`**:
  - The presets are native radios in a `radiogroup` named "头像" / "Avatar", one 48 px tile each (a 40 px avatar, 3 px padding, 1 px border, radius md), `space.2` apart and wrapping.
  - An upload tile follows the presets. It has a dashed `line` border and the `upload` icon, and is named "上传图片" / "Upload image". It opens a hidden file input (`accept` png / jpeg / webp) and calls `onUpload(file)`. Cropping and the 2 MB limit are left to the caller (Task 6).
  - A checked tile is neutral: `selected` ground and a `line-strong` border (spec §2.3). Keyboard focus shows the accent ring.
  - When the value is an image, the upload tile shows it and is the checked tile.
  - Without `onUpload`, the tile is disabled. `uploadOffReason` (default "这里不能上传图片。" / "Uploading is not available here.") is written under the tiles in small muted text and is the tile's `aria-describedby`.
- **Design i18n**: `avatar.label`, `avatar.upload`, `avatar.uploadOff` and `avatar.preset.<id>` in zh and en: 水豚 / Capybara, 黑熊 / Black bear, 熊猫 / Panda, 大象 / Elephant, 狐狸 / Fox, 猫头鹰 / Owl, 企鹅 / Penguin, 兔子 / Rabbit, 乌龟 / Turtle, 鲸 / Whale.
- **Spec**:
  - §2.1 gets a paragraph on the `avatar-*` tokens and their contrast pairs.
  - §3: the "No illustrations" line is replaced by the agent-avatar rule ("Nothing else in the UI may use the animal palettes"), followed by "Apart from agent avatars: no illustrations, gradients, frosted glass or emoji." The dither rule is untouched.
  - New §6.30 "Avatar and AvatarPicker" with states `presets`, `sizes`, `initial`, `picker` and `picker-upload-off`, and a 35-row size table. The table covers each preset's ground colour, all five sizes, the radius, the initial colours and type, the tile size and checked colours, and the disabled upload tile and its reason.
- **Reference set**:
  - `/dev/ui/reference/avatar` blocks (`apps/web/src/dev/catalog/reference-blocks.tsx`), with the route added in `routes.tsx` and `"avatar"` in `visual/accepted.ts`, commented as waiting for the workflows;
  - `docs/design/reference/src/avatar.html`, generated once from the preset data with `bitmapCells`, plus `r-avatar*` rules in `reference.css` and a link from `index.html`;
  - `render.spec.ts` PAGES and a new "Agents" group in `review-page.mjs`.

## Palettes (token: dark / light)

Shared tokens:
- `avatar-black`: #1C1C1A / #1C1C1A
- `avatar-white`: #F2F2EE / #FFFFFF
- `avatar-beak`: #EE8A2A / #EE8A2A (the owl's and penguin's beak and feet)

| Preset | Ground | Main | Other cells |
|---|---|---|---|
| capybara | `avatar-capybara-ground` #3D2213 / #FBE3D2 | `accent` (#FF6A13 / #CC4609) | the eye is a cut-out |
| black-bear | `avatar-black-bear-ground` #9C8468 / #E6D6C1 | `avatar-black` | `avatar-black-bear-snout` #C9A074 / #C49A6C, white eyes |
| panda | `avatar-panda-ground` #5E9168 / #669D71 (bamboo green) | `avatar-black` (ears, patches, nose) | `avatar-white` face |
| elephant | `avatar-elephant-ground` #2A2838 / #E6E3F2 | `avatar-elephant` #9AA0A8 / #757B84 (grey) | `avatar-elephant-ear` #7D838C / #5A6068, black eye, white tusk |
| fox | `avatar-fox-ground` #3A2414 / #FCEBD9 | `avatar-fox` #F07A2E / #D8601A (orange) | `avatar-fox-ear` #8A3E16 / #7A3310, white cheeks, black eyes and nose |
| owl | `avatar-owl-ground` #2E2618 / #EFE6D4 | `avatar-owl` #B07D52 / #875A36 | `avatar-owl-eye` #F5C542, `avatar-owl-belly` #D9B68C, black pupils, beak and feet |
| penguin | `avatar-penguin-ground` #5F8AAD / #6692B6 (icy blue) | `avatar-black` | `avatar-white` belly and eyes, beak and feet |
| rabbit | `avatar-rabbit-ground` #3A2229 / #F8DDE3 | `avatar-rabbit` #B89A84 / #8F725C | `avatar-rabbit-pink` #F2A7B5 (inner ears, nose), white muzzle, black eyes |
| turtle | `avatar-turtle-ground` #2E2A18 / #F2E8C9 (sand) | `avatar-turtle` #5FA548 / #4E8F3A | `avatar-turtle-shell` #3B7330 / #2F5E24, `avatar-turtle-skin` #A8C66C / #9FBF62, black eye |
| whale | `avatar-whale-ground` #16283A / #DCEFF5 | `avatar-whale` #5A92D6 / #3A72B5 | `avatar-whale-belly` #DCEAF5 / #FFFFFF, `avatar-whale-spout` #8EC3E8, black eye |

Contrast pairs, all with a floor of 3 (WCAG 1.4.11, graphics), checked in both themes: each preset's main colour against its ground (10 pairs), plus `avatar-white` against the panda and penguin grounds. The lowest ratios are light elephant 3.38, light fox 3.21, light turtle 3.23 and light panda white 3.17. `pnpm check:tokens` passes.

Drawings: the capybara is the logo's side profile compressed to 12 wide. The black bear (round ears, tan snout), panda (slanted eye patches), fox (pointed ears, white cheeks), owl (ear tufts, yellow eyes, beak, belly) and rabbit (long pink-lined ears) are front faces. The penguin is front, full body. The elephant (ear, tusk, hanging trunk), turtle (patterned shell, head, legs) and whale (spout, raised tail, pale belly) are side views facing right like the capybara. I checked them visually as PIL previews and as Chrome screenshots of `avatar.html` in both themes.

## TDD evidence

RED: `pnpm exec vitest run packages/design/test/avatar.test.tsx` before any implementation.
```
 FAIL  |design| packages/design/test/avatar.test.tsx > Avatar (spec §6.30) > all 10 presets render with their ground
 FAIL  ... > Avatar (spec §6.30) > null draws the initial
 FAIL  ... > Avatar (spec §6.30) > an image that fails to load falls back to the initial
 FAIL  ... > Avatar (spec §6.30) > is decorative: the name beside it is what is read
 FAIL  ... > AvatarPicker (spec §6.30) > the picker selects a preset and calls onChange
 FAIL  ... > AvatarPicker (spec §6.30) > names the presets in English
 FAIL  ... > AvatarPicker (spec §6.30) > the upload tile is disabled with its reason when onUpload is absent
 FAIL  ... > AvatarPicker (spec §6.30) > the upload tile passes the chosen png, jpg or webp to onUpload
 FAIL  ... > AvatarPicker (spec §6.30) > an uploaded image shows on the upload tile and no preset is checked
 FAIL  ... > Avatar (spec §6.30) > sizes 16/22/28/40/64 set the box
      Tests  10 failed (10)
```
(For example, `TypeError: AVATAR_SIZES is not iterable`: nothing was exported yet.)

GREEN: the same command.
```
 Test Files  1 passed (1)
      Tests  10 passed (10)
```

Other runs:
- `pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx`: Test Files 51 passed, Tests 965 passed.
- `pnpm gen:tokens`: wrote tokens.css and tokens.ts.
- `pnpm check:tokens`: passed.
- `pnpm check`: all checks passed.
- `pnpm typecheck`: exit 0.
- `pnpm exec biome check packages/design apps/web`: no errors. It shows 2 warnings, both pre-existing (`conversation-page.css:122` and `templates.css:421`). The one my CSS caused was fixed by using classes.

## Test titles (`packages/design/test/avatar.test.tsx`)

Avatar (spec §6.30):
- all 10 presets render with their ground
- null draws the initial
- an image that fails to load falls back to the initial
- sizes 16/22/28/40/64 set the box
- is decorative: the name beside it is what is read

AvatarPicker (spec §6.30):
- the picker selects a preset and calls onChange
- names the presets in English
- the upload tile is disabled with its reason when onUpload is absent
- the upload tile passes the chosen png, jpg or webp to onUpload
- an uploaded image shows on the upload tile and no preset is checked

## Files changed

New files:
- packages/design/src/display/avatar-presets.ts
- packages/design/src/display/avatar.tsx
- packages/design/test/avatar.test.tsx
- docs/design/reference/src/avatar.html

Modified files:
- docs/design/tokens.json
- packages/design/src/styles/tokens.css (generated)
- packages/design/src/tokens.ts (generated)
- packages/design/src/display/index.ts
- packages/design/src/display/logo.tsx
- packages/design/src/i18n.ts
- packages/design/src/styles/display.css
- docs/design/spec.md
- docs/design/reference/src/reference.css
- docs/design/reference/src/index.html
- apps/web/src/dev/catalog/reference-blocks.tsx
- apps/web/src/dev/catalog/routes.tsx
- apps/web/visual/accepted.ts
- apps/web/reference/render.spec.ts
- apps/web/reference/review-page.mjs

No changeset: `@capybara-hq/design` and `@capybara-hq/web` are private.

## What I could not run

- The Playwright fidelity spec for `avatar` (it needs a Next build, which isn't allowed in this worktree). I did not set up the optional temporary worktree, so the size-table rows are checked only as far as `catalog.test.tsx` goes (every block and part exists) and `spec-tables.test.ts` (valid tokens and states). The measured sizes and colours have not been verified in a browser through `/dev/ui`.
- Reference PNGs and visual baselines: those come from the `reference-update` / `visual-update` workflows, which I did not trigger.
- Instead, I ran the static reference server (`apps/web/reference/serve.mjs`, port 3291) and took Chrome screenshots of `avatar.html` in both themes. Both looked right. The upload icon was blank there only because `fill.js` gets its icons from the renderer's injection.

## Self-review

- Every brief interface is present with the exact names. Beyond the brief: `AVATAR_SIZES`, `AVATAR_GRID`, `AVATAR_UPLOAD_ACCEPT`, the optional `label` and `uploadOffReason` props, and a fallback to the initial for an unknown preset id.
- `onUpload` takes a `File`, not `() => void`. That lets the picker own the file input. Task 6 then crops the file and uploads it.
- No colour literals outside the token pipeline. Colours reach the DOM only as `var(--cb-<token>)` inline styles built from `TokenName`, and `design-color-literal` passes. `apps/web` adds only a component use and writes no styles.
- `bitmapCells` is extended, not copied.
- The /dev/ui blocks are 640 wide, so the 11 picker tiles fit on one row.

## Concerns

- The drawings are a first pass, for the user to review in the PR via `/dev/ui/reference/avatar`. At 16 px the 12×12 bitmaps at unit 1 are recognisable but small. At 22 px the 1 px clip trims the outer ring.
- The capybara uses `accent` directly. That follows the "brand accent" request and the logo, but it is a sixth use of the accent beyond the five roles in §2.3. §3 now names it as an avatar palette.
- Dark-theme grounds for the black-bodied animals (black bear, panda, penguin) are mid-tones, needed to keep 3:1 against black. They look lighter than the deep grounds of the other animals.
- The spec has no `image` state: a fixture image would be needed to measure it. Image rendering and its fallback are covered by the unit tests.
- I wrote scratch files (`red.txt`, `green.txt` and others) into the session scratchpad, which already held files from earlier work. I may have overwritten an older `red.txt` there.

---

## Fix round 1

Commit `fb8a5733 fix(design): avatars at 24 instead of 22; picker role and upload fallback`, pushed. The remote had not moved, so the rebase was a no-op.

### Changes

1. **Size 22 is now 24.**
   - `AVATAR_SIZES` is `[16, 24, 28, 40, 64]`.
   - Each size fits its whole drawing (unit / offset): 16 = 1 / 2, 24 = 2 / 0, 28 = 2 / 2, 40 = 3 / 2, 64 = 5 / 2. Nothing is clipped.
   - CSS: `[data-size="24"]` uses the `small` initial type. The same change is in `display.css` and `reference.css`.
   - Spec §6.30: the size list, the unit list, the sentence on clipping (removed), the initial-type rule ("micro at 16, small at 24 and 28") and the size-table row `avatar[data-size=24] | sizes | width | 24`.
   - The /dev/ui blocks follow `AVATAR_SIZES`. `avatar.html` was regenerated with 24.
2. **Picker role.** `.cb-avatar-picker-group` (`role="radiogroup"`) is now `display: flex; flex-wrap: wrap; gap: space.2` instead of `display: contents`. The same change is in `reference.css`.
3. **Upload fallback.**
   - `Avatar` takes an optional `onImageError`, called after it falls back to the initial.
   - `AvatarPicker` uses it to remember the failed `src`, then shows the `upload` icon on the tile, never an empty initial.
   - Spec §6.30 says so.

### Tests (`packages/design/test/avatar.test.tsx`, now 12)

Changed or new:
- `sizes 16/24/28/40/64 set the box` (was 16/22/…)
- `no art cell of any preset falls outside the box at any size`: parses every path cell of all ten presets at all five sizes against the viewBox; also asserts more than 1000 cells were seen, so it can't pass vacuously
- `an uploaded image that fails to load shows the upload icon on its tile`
- `is decorative: the name beside it is what is read` (now at size 24)

RED, with the new tests run against the old `avatar.tsx` (temporarily stashed by tag and restored):
```
 FAIL  ... > Avatar (spec §6.30) > sizes 16/24/28/40/64 set the box
 FAIL  ... > Avatar (spec §6.30) > no art cell of any preset falls outside the box at any size
 FAIL  ... > AvatarPicker (spec §6.30) > an uploaded image that fails to load shows the upload icon on its tile
      Tests  3 failed | 9 passed (12)
```

GREEN:
- `pnpm exec vitest run packages/design/test apps/web/test/catalog.test.tsx`: Test Files 51 passed, Tests 967 passed.
- `pnpm check`: all checks passed.
- `pnpm typecheck`: exit 0, after fixing the possibly-undefined destructuring in the new test.
- `pnpm exec biome check packages/design apps/web`: no errors; the same 2 pre-existing warnings.

### Notes

- The elephant drawing is unchanged, as ruled.
- Later tasks must use 24, not 22, wherever an avatar was planned at 22.
