### Task 4: Design: pixel-animal presets and Avatar

**Files:**
- Create:
  - `packages/design/src/display/avatar-presets.ts`
  - `packages/design/src/display/avatar.tsx`
- Modify:
  - `docs/design/tokens.json` (avatar palettes, with contrast pairs), then run `pnpm gen:tokens`
  - `docs/design/spec.md`: §3 gets the avatar rule, and a new §6.30 Avatar with its state list and size table
  - the design i18n (preset names)
  - `/dev/ui` reference blocks, the reference HTML and `accepted.ts`
- Test: `packages/design/test/avatar.test.tsx`.

**Interfaces:**
- Produces:
  - `AVATAR_PRESETS: Record<PresetId, { bitmap: string[]; palette: Record<string, string>; ground: string }>`. Palette values are token names, so there are no literals.
  - `type AvatarValue = { kind: "preset"; id: PresetId } | { kind: "image"; src: string } | null`.
  - `Avatar({ value, name, size }: { value: AvatarValue; name: string; size: 16 | 22 | 28 | 40 | 64 })`:
    - a preset draws its bitmap with `crispEdges` on its ground;
    - an image draws an `<img>`, falling back to the initial on error;
    - `null` draws the initial square as today's.
  - `AvatarPicker({ value, onChange, onUpload? })`: the 10 presets plus an upload tile. With no `onUpload`, the tile is disabled, with a reason prop.
- Bitmaps: draw the 10 animals in the logo's style (spec §3). The first-pass drawings are reviewed by the user in the PR through `/dev/ui/reference/avatar`.

- [ ] **Step 1: Write failing tests.**
  - `"all 10 presets render with their ground"`.
  - `"null draws the initial"`.
  - `"an image that fails to load falls back to the initial"`.
  - `"sizes 16/22/28/40/64 set the box"`.
  - `"the picker selects a preset and calls onChange"`.
  - `"the upload tile is disabled with its reason when onUpload is absent"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/avatar.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm gen:tokens` and `pnpm check:tokens`.
- [ ] **Step 4:** Run `pnpm exec vitest run packages/design/test` and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): pixel-animal avatar presets and the Avatar component`.

