# Task 6 report: the agent page by section, with Basics, Quick actions and read-only

Commit: `70b80a7d feat(web): the agent page by section, with basics and quick actions` (pushed to
`fix/rc2-acceptance`; no remote commits came in, so the rebase had nothing to do).

## What was built
- `/agents/<id>?s=<section>` (default `basics`; an unknown section, or one the viewer can't see,
  opens `basics`). `page.tsx` reads `searchParams.s`. `view.tsx` gates the page, reads the agent,
  and draws the `SettingsPage` loading frame: the nav plus the open section's static field shapes.
- `AgentPage`:
  - It uses `SettingsPage` with one nav group listing `sectionsFor(editable)`.
  - The head: the `Avatar` (40), the name and the description, which the template puts at the
    top of the content column. Actions: 开始对话 for everyone (`/chat?agent=<id>`); 运行记录 for
    the owner and admins; 重新指派负责人 for admins only (`agents.manage`), as before.
  - A dirty section holds back nav clicks with a document capture listener. It opens the design
    `Dialog` (继续编辑 / 放弃修改) and then calls `router.push(sectionHref)`.
- **Basics** (`BasicsSection`):
  - Fields: `AvatarPicker`, name, description (≤ 500), visibility (private / org / members), and
    the member checkboxes when visibility is `members`.
  - It keeps two drafts: the profile part and the agent part. One Save sends `PATCH …/profile`
    and `PATCH …/agents/:id` together, with `Promise.allSettled`.
  - The agent PATCH sends the saved definition with only the name changed. It strips
    `instructionFiles` and `avatarUrl` and sends `expectedVersion`.
  - The profile PATCH sends `expectedUpdatedAt`, taken from the profile when the first edit was
    made.
  - A part that succeeds resets. A part that fails keeps its draft and shows its error. A 409
    (`agent.profile_conflict` or `agent.version_conflict`) shows a `Callout` with 重新加载, which
    refetches the agent and resets the section.
  - Warnings the kernel returns show in the section, as a danger `Card` like the form's.
  - Upload: `cropAvatar` center-crops to a square on a canvas, at most 512 px, PNG, falling back
    to WebP if the PNG is over 2 MB. Then `uploadAvatar` runs (inside a `useAppMutation`), and the
    draft becomes `{ kind: "upload", uploadId }` with an object-URL preview. Save writes it.
  - Uploading is off, with a reason, when `attachments/limits.available === false` or an upload
    answers 503 `storage.unavailable`. Presets still save.
- **Quick actions** (`QuickActionsSection`):
  - The design `Repeater` (max 9) with add, remove (with an undo toast) and reorder.
  - Each entry has a title (≤ 40) and a body textarea (≤ 20 000). Empty titles and bodies are
    refused before the save.
  - Save sends `quickActions` through `useUpdateProfile` with `expectedUpdatedAt`. A 409 shows
    the reload callout.
- **Read-only** (anyone `canEditAgent` refuses): the nav lists basics, quick actions and model.
  Basics shows the 只读 notice and key values; quick actions are cards; the model is key values
  with the provider id. There are no edit or upload controls, and nothing is read beyond the
  agent.
- **Prompt, model, tools, skills and sub-agents** (`LegacyFormSection`):
  - Each renders `useAgentForm` with a new `only` argument, so only that section's
    `FormSection`(s) are drawn. Each has its own action row and is remounted after a save or a
    discard.
  - The form opens on the saved agent, so a section's PATCH changes only its own fields. That
    makes per-section saves effectively in place now. The body is still the whole definition
    plus `expectedVersion`.
  - Rules that depend on visibility read the saved visibility, because these sections can't edit
    it.
  - Channels is `AgentChannels` over `channelsQuery`.
- The route table now also prefetches `attachmentLimitsQuery` for editors. Every section's reads
  are prefetched whatever `?s=` is, so switching sections paints at once.
- Design: `PageHeader` has an `avatar?: ReactNode` slot (`data-part="page-header-avatar"`, flex
  none, centered on row 2). There's one line in `docs/design/spec.md` §4.2. No new state was
  added to the state list, so no reference or baseline is needed.
- i18n: `agents.page.*` in zh and en (section names, 开始对话, 重新指派负责人, the leave dialog, 放弃,
  重新加载, avatar and upload copy, description, members, and the quick-action copy).
- Changeset: `.changeset/agent-page-sections.md` (`@capybara-hq/web` patch).

## Component names Task 7 uses (contract)
- `components/agent/sections.ts`:
  - `AGENT_SECTIONS`, `AgentSection` and `READ_ONLY_SECTIONS`;
  - `sectionsFor(editable)`, `sectionOf(s, editable)` and `sectionHref(agentId, s)`;
  - `SECTION_FIELDS` / `READ_ONLY_FIELDS`, the static `FieldShape[]` of each section.
- `components/agent/useSectionDraft.ts`: `useSectionDraft<T>(saved)` returns
  `{ draft, set(partial | fn), dirty, reset() }`. The draft follows `saved` until it is edited.
- `components/agent/frame.tsx`, re-exported from `AgentPage.tsx`:
  - `useAgentPage()` returns `{ orgId, agent, editable, section, header, nav, setDirty }`;
  - `AgentSectionFrame({ actionRow?, dirty?, loading?, children })`. Every section renders inside
    it. It draws the `SettingsPage` and reports `dirty` for the leave guard.
- `components/agent/AgentPage.tsx`: `AgentPage({ orgId, agent, section, editable })`. Its
  `OpenSection` switch is where Task 7 replaces `LegacyFormSection` with `PromptSection`,
  `ModelSection`, `ToolsSection`, `SkillsSection`, `SubagentsSection` and `ChannelsSection`.
- `components/agent/BasicsSection.tsx`: `BasicsSection` and `CONFLICT_CODES` (the 409 codes that
  offer a reload).
- `components/agent/QuickActionsSection.tsx`: `QuickActionsSection` and `QUICK_ACTIONS_MAX`.
- `components/agent/ModelReadOnly.tsx`: `ModelReadOnly`, the read-only model. Task 7's
  `ModelSection` may absorb it.
- `components/agent/LegacyFormSection.tsx`: interim, to be deleted by Task 7.
- `AgentForm`: `useAgentForm(orgId, onDone, data, existing?, only?: AgentFormSection)`, where
  `AgentFormSection = "prompt" | "model" | "tools" | "skills" | "subagents"`.

## TDD evidence
RED: `page.tsx` and `view.tsx` were temporarily set back to HEAD; the new components existed but
weren't wired.
```
pnpm exec vitest run apps/web/test/agent-page.test.tsx
     × the section nav lists the 8 sections and opens ?s=…
     × a non-editor sees only basics, quick actions and model, read-only
     × saving basics sends the profile and the name, and sends no other section's draft
     × when one of basics' two saves fails, the other stays saved and the failed part keeps its draft
     × leaving a dirty section asks to keep or discard
     × a 409 profile conflict shows the reload action
     × quick actions: a 10th cannot be added; reorder; save
     × quick actions: an empty title is refused before the save
     × no object store: the upload tile explains and a preset saves
     × an upload is cropped, uploaded and saved as an upload avatar; a 503 turns uploading off
     × /agents/<id>: an empty cache shows the template's loading state, then the data
 Tests  11 failed | 3 passed (14)
```
Three passed on the old page: the warnings case and the two hydrated-cache cases. The old form
also met them.

GREEN:
- `pnpm exec vitest run apps/web/test/agent-page.test.tsx`: Tests 14 passed (14).
- `pnpm exec vitest run apps/web/test`: Test Files 82 passed (82), Tests 1688 passed (1688).
- `pnpm exec vitest run packages/design`: 876 passed. `pnpm exec vitest run tools/checks`: 249
  passed.
- `pnpm check:web-ui`: passed. `pnpm check:i18n`: passed. `pnpm --filter @capybara-hq/web
  typecheck`: clean. `pnpm exec biome check apps/web`: clean, except 2 existing CSS warnings in
  design. `pnpm check`: all checks passed. commitlint: clean.

## Test titles (apps/web/test/agent-page.test.tsx)
- the section nav lists the 8 sections and opens ?s=…
- a non-editor sees only basics, quick actions and model, read-only
- saving basics sends the profile and the name, and sends no other section's draft
- when one of basics' two saves fails, the other stays saved and the failed part keeps its draft
- the kernel's warnings after a basics save show in the section
- leaving a dirty section asks to keep or discard
- a 409 profile conflict shows the reload action
- quick actions: a 10th cannot be added; reorder; save
- quick actions: an empty title is refused before the save
- no object store: the upload tile explains and a preset saves
- an upload is cropped, uploaded and saved as an upload avatar; a 503 turns uploading off
- /agents/<id>: a first render from the hydrated cache makes no browser read
- /agents/<id>?s=tools: a first render from the hydrated cache makes no browser read
- /agents/<id>: an empty cache shows the template's loading state, then the data

## Tests moved or changed
- Every agent fixture in `agent-form`, `agent-skills`, `agent-subagents` and `roles` gains a
  `profile`: the page reads `agent.profile`, which the kernel always sends.
- `test/support/agents.ts`:
  - `renderEditAgent` takes `section` (it opens `?s=<section>`);
  - `agentFormDefaults` answers `attachments/limits`.
- `agent-form.test.tsx`:
  - The two channels tests open `?s=channels`.
  - "the form, the selected connector's tools and the channels are the first paint" became
    `?s=tools: …`. It now client-navigates to `?s=channels` and checks that there was still no
    browser read.
  - "an empty cache shows the template's loading state" became `?s=tools`. It looks for
    `SettingsPage` with 1 section placeholder, where it used to look for `FormPage` with 6.
  - "saving an agent invalidates the agents list, the agent and readiness" became "saving basics
    invalidates the agents list and the agent: the open agent is read again". The save now stays
    on the page, and readiness is no longer invalidated (renaming doesn't change it).
  - "editing the prompt of an agent saved with prompt files sends instructions only" opens
    `?s=prompt` and waits for the PATCH instead of `router.push("/agents")`.
  - "channels the kernel fails …" opens `?s=channels`.
- `agent-skills.test.tsx`: edit cases open `?s=skills`. The "已删除的组织技能 …" case expects
  `SettingsPage`, checks the head's h1 instead of the name field, and expects no
  `router.push`, because the section save stays on the page.
- `agent-subagents.test.tsx`: edit cases open `?s=subagents`. The assertions are unchanged.
- `roles.test.tsx`:
  - the head's button is `agents.page.reassign` (重新指派负责人);
  - the read-only cases open `?s=model` to check `p / m`;
  - the agents-list cases keep `agents.reassign.action`.
- e2e (not run locally; CI runs it):
  - `query-cache.spec.ts` expects `SettingsPage` for `/agents/<id>`;
  - `skills.spec.ts` opens `?s=skills` for the pinned skills and the agent's own skills.

## Files
- New:
  - `apps/web/src/components/agent/{AgentPage.tsx,frame.tsx,BasicsSection.tsx,QuickActionsSection.tsx,ModelReadOnly.tsx,LegacyFormSection.tsx,sections.ts,useSectionDraft.ts}`
  - `apps/web/src/lib/avatar-crop.ts`
  - `apps/web/test/agent-page.test.tsx`
  - `.changeset/agent-page-sections.md`
- Changed:
  - `apps/web/src/app/(app)/agents/[id]/{page.tsx,view.tsx}`
  - `apps/web/src/components/AgentForm.tsx` (the `only` mode)
  - `apps/web/src/lib/query/routes.ts`
  - `apps/web/messages/{en,zh}.json`
  - `apps/web/test/{agent-form,agent-skills,agent-subagents,roles}.test.tsx`
  - `apps/web/test/support/agents.ts`
  - `apps/web/e2e/{query-cache,skills}.spec.ts`
  - `packages/design/src/shell/page-header.tsx`
  - `packages/design/src/styles/shell.css`
  - `docs/design/spec.md`

## Self-review
- A section save never sends another section's draft:
  - Basics builds its definition from the saved one;
  - form sections remount on the saved agent;
  - a section switch unmounts the old section, after the leave guard.
- The concurrency bases (`expectedUpdatedAt` and `expectedVersion`) are taken when the first
  edit is made. A background refetch therefore can't turn a stale edit into a silent overwrite.
  The bases are cleared after a save or a reload.
- No `window.confirm`, no styles in `apps/web`, no direct kernel reads (the upload is a mutation
  `fn`). The route table entry is updated, and `check:web-ui` passes.
- `AGENT_SECTIONS` and `READ_ONLY_SECTIONS` are exactly the brief's values.

## Concerns
- **Design change outside the brief's file list.** `PageHeader` had no place for the avatar, so
  I added an `avatar` slot and a spec §4.2 line. It adds no new state, so no reference PNG is
  needed. Whether that needs one, as the user decides, is open.
- **The description isn't on a line in the head.** `SettingsPage` moves the header
  `description` to the top of the content column (a template rule), so it shows there rather
  than as a head line.
- **The member picker is new UI.** Basics now always offers `members` visibility, with a
  checkbox list of the org's members (anonymous guests excluded). Before, the option appeared
  only when it was already set through the API. The kernel validates the list.
- **Two action-row choices.** Editable sections always show their action row, with "no unsaved
  changes" and Save disabled when clean. Form sections keep Save enabled when clean, as the old
  form did, so the "unchanged save keeps tool order" test still holds. This differs from the
  settings pages, which show the row only on changes.
- **Section saves don't leave the page.** A save no longer goes to `/agents`; it stays on the
  page.
- **Per-section saves are partial until Task 7.** The not-yet-moved sections send the whole
  saved definition plus that section's edits, which is effectively per section. Task 7 should
  still give each its own save component.
- **The leave guard covers only the section nav.** Sidebar links and a tab close aren't guarded.
- **The loading frame's nav may change.** It assumes members and up may edit, because ownership
  is unknown before the agent loads. A non-owner member therefore sees 8 nav items until the
  agent arrives, then 3.
- **e2e isn't run locally.** The `e2e` specs I changed weren't run here; CI runs them.
- **No rendered view yet.** The dev web wasn't touched. Restart the dev web after pulling the
  design change (noted in Task 4).

## Fix round 1

Commit: `e3df7132 fix(web): the agent page guards every way out and shows its save row only with changes`
(pushed; nothing new on the remote to rebase onto).

### What each finding got
1. **The leave guard covers every way out.**
   - While a section is dirty, `AgentPage` holds back a click on any same-origin `a[href]`
     outside a dialog, using a document capture listener. That covers the section nav, the
     sidebar, the path and the head's links.
   - `guardedHref` (exported) lets the browser handle:
     - modified clicks (meta, ctrl, shift, alt);
     - any button other than the primary one;
     - `target` other than `_self`;
     - `download`;
     - another origin;
     - the URL already open.
   - Discard calls `router.push` on the stored path, search and hash (no locale prefix: the
     locale isn't in the URL).
   - A `beforeunload` listener is registered only while dirty.
   - The leave copy now ends "discard them and leave" (zh: 放弃修改并离开).
   - Back and forward stay uncovered, per the ruling.
2. **The action row shows only with changes.**
   - Basics and Quick actions pass `actionRow` only when dirty, saving, or showing an error.
   - `LegacyFormSection` does the same; `AgentFormView` gains `failed`, for a save error.
   - The "Continue" row after a save with warnings stays.
3. **The profile saves first.** Basics now sends the profile PATCH, then the agent PATCH, one
   after the other. The agent's invalidation refetch therefore reads the new profile.
4. **Readiness.** The agent PATCH also invalidates `readiness()` when it sends `visibility` or
   `memberIds`.
5. **File type.** The file type is checked against `AVATAR_UPLOAD_ACCEPT` before `cropAvatar`.
   Anything else shows `agents.page.uploadType` and uploads nothing.
6. **Fields lock while saving.**
   - Basics disables its name, description, visibility, member checkboxes and picker while
     saving, and the picker while uploading.
   - Quick actions disables its inputs and the `Repeater` while saving.
   - Design: `AvatarPicker` gains `disabled?`, documented in spec §6.30 and covered by a design
     test.

### New test titles (apps/web/test/agent-page.test.tsx)
- a dirty section asks before any in-app link: discard goes to its href, keep stays
- a modified click (new tab) is not intercepted
- beforeunload asks only while the section is dirty
- the save row shows only with changes; a form section keeps Continue after warnings
- a combined save shows the new profile in the head even when the agent refetch is slow
- a visibility change also invalidates the org's readiness
- an upload of another type (gif) says so and uploads nothing
- while basics saves its fields are disabled
- while quick actions save their fields are disabled
- In packages/design/test/avatar.test.tsx: "disabled: every tile is disabled and the value stays
  shown".

### RED and GREEN
RED: `apps/web/src` and `packages/design/src` were set back to the round-0 code.
```
pnpm exec vitest run apps/web/test/agent-page.test.tsx
     × a dirty section asks before any in-app link: discard goes to its href, keep stays
     × beforeunload asks only while the section is dirty
     × the save row shows only with changes; a form section keeps Continue after warnings
     × a combined save shows the new profile in the head even when the agent refetch is slow
     × a visibility change also invalidates the org's readiness
     × an upload of another type (gif) says so and uploads nothing
     × while basics saves its fields are disabled
     × while quick actions save their fields are disabled
      Tests  8 failed | 15 passed (23)
pnpm exec vitest run apps/web/test/agent-page.test.tsx -t "modified click"
     × a modified click (new tab) is not intercepted   (expected true to be false)
```
GREEN:
- `agent-page.test.tsx`: 23 passed.
- `pnpm exec vitest run apps/web/test` plus the design avatar test: 83 files, 1710 tests
  passed.
- `packages/design` + `tools/checks`: 1126 passed.
- `check:web-ui`, `check:i18n`, the web and design typechecks, and biome (2 existing CSS
  warnings): clean.
- `pnpm check`: All checks passed. commitlint: clean.

### Tests changed in this round
Each case below used to save an untouched section. The save row now needs a change, so each
makes an edit first.
- `agent-skills`:
  - "不改动直接保存…" became "a skills save keeps the tool order, merges skills (unknown keys
    kept) and sends expectedVersion". It unticks pdf-tools.
  - The version_conflict cases untick pdf-tools.
  - "deselecting a skill unpins it…" adds brainstorming, which isn't suggested for pinning.
  - "manual_only refusal" pins pdf-tools.
- `agent-subagents`:
  - "an agent without sub-agent settings saves without a subagents block" now saves the Tools
    section (it switches skill_write on) and checks that the definition has no subagents block.
  - The subagents_invalid and validation_failed cases type into an inline-template field.
- `roles`: the "the form" cases check that the name field can be edited, instead of looking
  for the Save button.

### Remaining
- Back and forward are not guarded (ruling).
- The preset tiles have no dimmed look when disabled: the native radios are disabled but no CSS
  was added. It is a visual-only gap, left for the user's design review.

## Fix round 2

Commit: see `git log` (`fix(web): the leave guard ignores in-page hash links`).

- **Fix.** `guardedHref` now returns null when the link's pathname and search equal the current
  URL, whatever the hash. Two kinds of link no longer prompt: the shell's skip link
  (`href="#<mainId>"`) and an anchor on the same page. Discard therefore can't push a bare hash
  and drop the edits.
- **New test:** "a hash-only link, a target=_blank link and a download link are not
  intercepted". It covers `#main`, `<current path>#section`, `target="_blank"` and `download`.
  For each, the click is not default-prevented, no dialog opens and there's no `router.push`;
  the typed name stays.
- **RED** (guard reverted):
  `pnpm exec vitest run apps/web/test/agent-page.test.tsx -t "hash-only"`
  -> `× … <a href="#main" …>: expected true to be false`. 1 failed.
- **GREEN:**
  - `agent-page.test.tsx`: 24 passed.
  - `pnpm exec vitest run apps/web/test`: 82 files, 1698 tests passed.
  - `check:web-ui` passed. Web typecheck: 0 errors. Biome: clean. commitlint: clean.
