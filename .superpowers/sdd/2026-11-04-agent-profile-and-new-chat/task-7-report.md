# Task 7 report: prompt files and the agent sections with their own saves

Commit: `9be36787 feat(web): prompt files and the agent sections with their own saves`. It is
pushed to `fix/rc2-acceptance`. Both `pull --rebase` runs found nothing new on the remote, so the
tool-rename work hadn't touched these files.

## What was built
- **`PromptSection`** (`?s=prompt`):
  - Layout: `Grid columns="form"`. The left side is a `Repeater variant="rows"` with `min=1` and
    `max=20`; each row's body is a ghost button that opens that file. The right side is a `Card`
    titled with the open file's name, holding the name field and a code `Textarea`.
  - Add creates `untitled.md` (then `untitled-2.md`, and so on) and opens it. Remove goes
    through the repeater's undo toast, and the last file's Remove is disabled. Reorder uses the
    move buttons, drag, or Alt+↑/↓.
  - Under the list it shows the counts: `{chars} / 100,000 characters · {files} / 20 files`,
    in the fail tone when over the limit.
  - An old agent without `instructionFiles` shows one `AGENTS.md` holding its `instructions`.
  - Save sends `{ ...saved definition without instructions/instructionFiles/avatarUrl,
    instructionFiles }` plus `expectedVersion`. It never sends `instructions`.
  - Client hints are checked before the save:
    - names compared case-insensitively;
    - names must match `/^[^/\\]{1,64}\.md$/`, with no control, bidi or format characters;
    - the joined total must be ≤ 100 000.
  - A name problem shows as soon as the name differs from every saved name, or after a save
    attempt. A save with problems is refused and sends nothing.
- **`lib/instruction-files.ts`** mirrors the kernel: `readInstructionFiles`,
  `joinInstructionFiles`, `fileNameProblems`, `newFileName` and `INSTRUCTION_FILE_LIMITS`.
- **`ModelSection`, `ToolsSection`, `SkillsSection`, `SubagentsSection`**:
  - Each keeps a `useSectionDraft` draft. Typed edits survive a refetch, and a clean section
    follows the saved agent.
  - Each sends `savedDefinition(agent)` with only its own fields changed:
    - Model: model, fallback and params.
    - Tools: `tools` and `toolPolicies`. References it doesn't switch stay in their saved order:
      plugin tools, connectors picked by name, and the `agent` tool.
    - Skills: `skills`, merged with the saved block.
    - Sub-agents: only the `agent` tool ref, plus `subagents`.
  - Shared machinery (`definition-save.tsx`):
    - `useDefinitionSave` sends `expectedVersion` taken at the first edit, invalidates the
      agents list and the agent, and `reload` refetches the agent and resets the section.
    - `SaveFeedback` shows the warnings card, and on a 409 a reload `Callout`, or else a
      `FormError`.
    - `useSectionActionRow` shows the row only with changes, while saving, or after a failure.
    - `WithFormData` covers loading and error.
  - The Skills `writePolicy` switch and the sub-agents "shared more widely" rule read the saved
    `agent.visibility`.
  - `useSubagentsForm` now keeps its state in a `useSectionDraft`. It takes an `onEdit` callback
    and returns `dirty` and `reset`.
- **`ChannelsSection`**: moved over unchanged. It has no save of its own.
- **`ModelReadOnly`** is still used: `ModelSection` renders it for viewers who can't edit.
- `AgentPage`'s `OpenSection` is now an exhaustive switch. `LegacyFormSection.tsx` is deleted.
- Helpers in `definition-parts.ts`: `savedDefinition`, `encodeModel`/`decodeModel`,
  `replaceToolRefs`, `BUILTIN_SET` and `sameJson`. Basics' `definitionWithName` now uses
  `savedDefinition`.
- `lib/agents.ts`:
  - `AgentDefinitionInput.instructionFiles?` added.
  - New `AgentDefinitionSave` type: either `instructions` or `instructionFiles`, never both.
  - `updateAgent` input gains `memberIds`, which Basics already sent.
- i18n: `agents.page.prompt.*` in zh and en.
- Changeset: `.changeset/agent-page-prompt-files.md` (web patch).

## What happened to `AgentForm.tsx`
I kept it, as the `/agents/new` create form only, because Task 8 modifies "AgentForm.tsx (or its
replacement)" and `/agents/new` still needs a form now.
- I removed the `existing` and `only` arguments and every edit-only path (preserving saved tools
  and skills, `expectedVersion`, `OwnSkills`, the `members` option, the prompt-only mode).
- `useAgentFormData` and `AgentFormData`/`AgentFormState` moved to
  `components/agent/form-data.ts`. The sections and `/agents/new` import them from there.
- `AgentFormLoading` lost its unused `channels` prop.

## TDD evidence
RED: `pnpm exec vitest run apps/web/test/agent-page-sections.test.tsx`, with the new test file
against the old code:
```
     × prompt: an old agent without instructionFiles shows one AGENTS.md holding its instructions
     × prompt: add WORKFLOW.md, reorder, save sends instructionFiles in order
     × prompt: the last file can't be deleted
     × prompt: a duplicate name is refused before save
     × prompt: the counts show the joined characters against 100 000 and the files against 20
     × prompt: editing an agent saved with prompt files sends instructionFiles only
     × a stale expectedVersion shows the reload action
     × typed edits survive a refetch; a clean section shows the newer saved version
     × a section save shows the kernel's warnings in the section and the row goes
     × /agents/<id>?s=tools: the section, the selected connector's tools and the channels are the first paint
 Test Files  1 failed (1)
      Tests  10 failed | 11 passed (21)
```
11 tests already passed on the old code:
- the moved tests;
- "each section's save sends only its fields";
- "an unrelated section's save keeps the prompt files…";
- "skills writePolicy shows only for a saved private agent".

They passed because `LegacyFormSection` already opened on the saved agent. They now pin that
behaviour on the new components.

GREEN:
- `pnpm exec vitest run apps/web/test/agent-page-sections.test.tsx`: 21 passed (21).
- `pnpm exec vitest run apps/web/test`: 83 files, 1709 tests passed.
- `pnpm check:web-ui`: passed.
- `pnpm check:i18n`: passed.
- `pnpm --filter @capybara-hq/web typecheck`: 0 errors.
- `pnpm exec biome check apps/web .changeset`: clean.
- `pnpm check`: all checks passed.
- commitlint: clean, with no body line over 100 characters.

## New test titles (apps/web/test/agent-page-sections.test.tsx)
- prompt: an old agent without instructionFiles shows one AGENTS.md holding its instructions
- prompt: add WORKFLOW.md, reorder, save sends instructionFiles in order
- prompt: the last file can't be deleted
- prompt: a duplicate name is refused before save
- prompt: the counts show the joined characters against 100 000 and the files against 20
- prompt: editing an agent saved with prompt files sends instructionFiles only
- each section's save sends only its fields
  - It asserts the exact PATCH bodies for model, tools, skills and sub-agents.
  - Each body is the saved definition minus `instructionFiles`, plus that section's fields and
    `expectedVersion`, with no `visibility`.
- an unrelated section's save keeps the prompt files: their join goes as instructions
  - The web side only asserts the body. The "keeps the files, no new version" half is the
    kernel's `instruction-files.test.ts` "an unrelated save sending the joined text keeps the
    files; a changed text drops them", which checks `currentVersion` stays 1.
- skills writePolicy shows only for a saved private agent
- a stale expectedVersion shows the reload action
- typed edits survive a refetch; a clean section shows the newer saved version
- a section save shows the kernel's warnings in the section and the row goes

## Moved tests (from agent-form.test.tsx to agent-page-sections.test.tsx)
- lists only this agent's connections; 接入渠道 presets the agent and the way back
- members see the list read-only: no connect button, no links
- /agents/<id>: channels the kernel fails show the section's own error to an admin
- /agents/<id>?s=tools: the section, the selected connector's tools and the channels are the
  first paint (it was "the form, …"; it now also client-navigates to `?s=prompt`)
- /agents/<id>: someone who may not change it reads only the agent (read-only view)
- /agents/<id>: an agent the kernel does not find is the not-found state in the shell
- /agents/<id>: a first render from the hydrated cache makes no browser read
- /agents/<id>?s=tools: an empty cache shows the template's loading state, then the data
- saving basics invalidates the agents list and the agent: the open agent is read again
- "editing the prompt of an agent saved with prompt files sends instructions only" is now
  "prompt: editing an agent saved with prompt files sends instructionFiles only". The behaviour
  changed on purpose, per controller note 1.

The `/agents` and `/agents/new` cases stay in `agent-form.test.tsx`, because the create form
remains. `agent-skills`, `agent-subagents`, `roles` and `model-params` run unchanged against the
new sections and pass.

Changed in `agent-page.test.tsx`:
- "the save row shows only with changes; a form section keeps Continue after warnings" became
  "…; a definition section shows warnings and drops the row".
- Definition sections now behave like Basics: the warnings card stays, the draft resets, and
  there is no Continue button.

## Files
- New:
  - `apps/web/src/components/agent/{PromptSection,ModelSection,ToolsSection,SkillsSection,SubagentsSection,ChannelsSection}.tsx`
  - `apps/web/src/components/agent/{definition-save.tsx,definition-parts.ts,form-data.ts}`
  - `apps/web/src/lib/instruction-files.ts`
  - `apps/web/test/agent-page-sections.test.tsx`
  - `.changeset/agent-page-prompt-files.md`
- Changed:
  - `apps/web/src/components/{AgentForm.tsx,AgentSubagents.tsx}`
  - `apps/web/src/components/agent/{AgentPage.tsx,BasicsSection.tsx}`
  - `apps/web/src/lib/agents.ts`
  - `apps/web/src/app/(app)/agents/new/view.tsx`
  - `apps/web/messages/{en,zh}.json`
  - `apps/web/test/{agent-form,agent-page}.test.tsx`
- Deleted: `apps/web/src/components/agent/LegacyFormSection.tsx`

## Self-review
- No section sends another section's draft. Every body starts from the saved definition and
  never from Basics' draft. Only Prompt sends `instructionFiles`, and it never sends
  `instructions` alongside them.
- `expectedVersion` is the version at the first edit. A refetch while dirty keeps the typed
  edits, and the save then gets a 409 with a reload. The test checks the body carries version 1
  after the cache moved to version 2.
- The action row follows T5 in every section. The leave guard gets `dirty` from each section.
- There are no styles in `apps/web`, all copy is i18n'd in zh and en, and `check:web-ui` passes.

## Concerns
- **Prompt layout.** I didn't use a `FormSection`, because its 240 px head column would leave
  the editor about 300 px wide. The section is a `Grid columns="form"` instead (a 220 px list,
  then the editor `Card`), with a muted hint line on top.
  - There is no h2 section title; the nav marks "Prompt" as active.
  - The loading skeleton (`SECTION_FIELDS.prompt`) is still a single textarea inside a form
    section, so the shapes don't match exactly.
  - In the 220 px list column, the move up, move down and remove buttons leave about 90 px for
    the file name, so long names may be cramped.
  - The `form` grid has no narrow breakpoint.
  - This needs your design review. No screenshots or baselines were made, and none were run.
- **Name hints are live.** Typing a new name shows "invalid" while the field is momentarily
  empty or doesn't end in `.md` yet. This is deliberate immediate feedback; the save refuses
  either way.
- **After a save, the open file is kept by position.** Saved files are re-keyed by index.
- **Warnings no longer show a Continue button.** A definition-section save that returns
  warnings keeps the danger card and resets the draft, like Basics.
- e2e specs were not run locally. None of them edit the prompt on the agent page.

## Fix round 1

Commit: `fcb74476 fix(web,design): the prompt section in its own titled card, one column on
phones`. It is pushed; the rebase found nothing new on the remote.

### What each ruling got
1. **Titled section.**
   - The Prompt content now sits in `FormSection id="prompt"`, titled 提示词 / Prompt.
   - Its description is a single line: "The files go to the model in this order. Write them in
     English." In zh: 这些文件按顺序拼接后交给模型。请用英文写。
   - The warnings and errors stay above the section, as in the other sections.
2. **One column on phones.** I added a new `Grid columns="list-detail"`: a 220 px list beside a
   flexible detail, top-aligned, collapsing to one column below 640 px with the list on top.
   - I added a variant rather than changing `form`. `form` is used about 20 times in the
     `/dev/ui` catalog as label/content rows, and a collapse there would change pages this fix
     doesn't own.
   - Documented in spec §4.3 (the phone list) and §5.8 (a new "List + editor" bullet).
   - A related Repeater fix: rows variant put the first row's handle and actions 24 px lower
     (`space.6`), to clear FieldRow labels. That misaligned the label-less file rows. A rule
     using `:not(:has(.cb-field-head))` now keeps them on the row's own line, documented in spec
     §6.26. The file buttons take the default control height so they share the actions' line.
3. **Skeleton shape.**
   - `FieldShape` gains `control: "list-editor"`, with `options` for the list rows (default 1)
     and `rows` for the textarea (default 16).
   - It draws the same `list-detail` grid:
     - left (gap 8): the rows Repeater's own markup with `control.default` row slots, a dense
       88 px add slot, and a small count line;
     - right: the `Card` frame with a 45% title slot, a name field placeholder with its help
       line, and a 16-row textarea with its help line (gap 12).
   - `SECTION_FIELDS.prompt` is `[{ control: "list-editor", options: 1, rows: 16 }]`.
   - The new `SECTION_DESCRIPTIONS` map and the `loadingSection` helper pass the known
     description to both loading frames: `AgentSectionFrame`, and the route's
     `AgentPageLoading`. The skeleton therefore shows the real title and description.
   - No new state list was added, so no new reference or baseline is needed.
4. **Name hints.**
   - A file's name problems show after its name field is left (blur) or after a save attempt.
     Typing in a name hides that file's problems until the field is left again.
   - `fileNameProblems` now flags every file sharing a name, ignoring case, not only the later
     one.

### Tests
- Web, new:
  - "prompt: name errors show on blur or on save, not while typing"
  - "prompt: a titled section whose loading frame has the loaded shape"
- Web, changed: "prompt: a duplicate name is refused before save" now shows the invalid-name
  error after the save click, not mid-typing.
- Design, new:
  - "list-editor shape: list rows, add and count beside a titled editor card (name, 16-line
    textarea)" in `templates-loading.test.tsx`
  - "the list-detail grid collapses to one column below 640; label-less rows keep their ends on
    their line": reads `controls.css` and `repeater.css`.
  - "Grid list-detail: the list and detail columns" in `layout.test.tsx`
- RED: I put the round-0 web files back (`PromptSection`, `sections.ts`, `frame.tsx`,
  `instruction-files.ts`, `view.tsx`) and ran
  `pnpm exec vitest run apps/web/test/agent-page-sections.test.tsx`:
  - × prompt: name errors show on blur or on save, not while typing
  - × prompt: a titled section whose loading frame has the loaded shape
  - Tests: 2 failed | 21 passed (23).
- GREEN:
  - `pnpm exec vitest run apps/web/test packages/design/test`: 133 files, 2591 tests passed.
  - `check:web-ui` and `check:i18n` passed.
  - The web and design typechecks: 0 errors.
  - Biome: clean, apart from 2 warnings that were already there, in
    `conversation-page.css` and `templates.css`.
  - `pnpm check`: all checks passed. commitlint: clean.

### Files
- Design:
  - `packages/design/src/layout/index.tsx`
  - `packages/design/src/styles/{controls.css,repeater.css}`
  - `packages/design/src/templates/frame.tsx`
  - `packages/design/test/{templates-loading,layout}.test.tsx`
  - `docs/design/spec.md`
- Web:
  - `apps/web/src/components/agent/{PromptSection.tsx,sections.ts,frame.tsx}`
  - `apps/web/src/app/(app)/agents/[id]/view.tsx`
  - `apps/web/src/lib/instruction-files.ts`
  - `apps/web/messages/{en,zh}.json`
  - `apps/web/test/agent-page-sections.test.tsx`

### Remaining concerns
- **The editor is still narrow on desktop.** Inside a `FormSection` the field card is about 550
  px, so the editor column is about 300 px beside the 220 px list. This follows the ruling, but
  the design review should look at it.
- **Not checked visually.** I ran no visual or skeleton-alignment spec and made no screenshots.
  The `:has()` rule and the 640 px collapse were checked only by CSS-text tests.

## Fix round 2

Commit: `73c36e79 fix(design,web): a stacked form section gives the prompt editor the full
width`. It is pushed; the rebase found nothing new on the remote.

### What changed
- **Design: a new `FormSection` prop, `layout?: "columns" | "stacked"`** (default `columns`).
  - Stacked renders `data-layout="stacked"`: the head (title over description) sits above the
    fields card, `space.3` apart, and the card spans the full content width.
  - Below 960 px every section was already stacked, so narrow layouts don't change.
  - The loading frame takes the same layout, so the skeleton keeps the loaded boxes:
    `LoadingFormSection` accepts the prop and `SettingsPage.loading.sections[]` gains `layout`.
  - The type `FormSectionLayout` is exported.
  - Spec §5.3 adds a "Stacked sections" bullet: when to use it (only for content that needs the
    width, such as an editor), its narrow behaviour, and the loading counterpart.
  - Spec §5.8's "List + editor" bullet now says it is a stacked section.
- **No new state list entry or `/dev/ui` block.** Stacked is a prop of the section, like
  `flush`, which also has none; the `template-form` state list stays `page` and `loading`. If
  fidelity should cover it, a `stacked` state and reference block can still be added.
- **Existing sections are unchanged.** The default renders no `data-layout`, and the 240 px
  two-column rule is untouched. The design test checks both, and the full design and web suites
  pass without change.
- **Web.**
  - The Prompt section uses `layout="stacked"`.
  - `SECTION_LAYOUTS` in `sections.ts` holds `{ prompt: "stacked" }`.
  - `loadingSection` passes the layout to both loading frames (`AgentSectionFrame` and the
    route's `AgentPageLoading`).

### Tests
- Design, new: "FormSection layout: columns by default, stacked puts the head above a full-width
  card, loading too". It covers the default and stacked attributes, the head-then-card order,
  the `SettingsPage` loading sections, and both CSS rules.
- Web, changed: "prompt: a titled section whose loading frame has the loaded shape" now asserts
  three things:
  - the loaded section is stacked;
  - no other section on the page is stacked;
  - the loading section around the list-editor skeleton is stacked.
- RED: with the round-1 versions of `PromptSection`, `sections.ts` and `frame.tsx` put back,
  that test fails (1 failed | 22 passed).
- GREEN:
  - `pnpm exec vitest run apps/web/test packages/design/test`: 133 files, 2592 tests passed.
  - `check:web-ui` and `check:i18n` passed.
  - The web and design typechecks: 0 errors.
  - Biome: only the 2 existing CSS warnings.
  - `pnpm check`: all checks passed. commitlint: clean.

### Files
- `packages/design/src/templates/{form-page.tsx,settings-page.tsx,index.ts}`
- `packages/design/src/styles/templates.css`
- `packages/design/test/templates-loading.test.tsx`
- `docs/design/spec.md`
- `apps/web/src/components/agent/{PromptSection.tsx,sections.ts,frame.tsx}`
- `apps/web/test/agent-page-sections.test.tsx`

### Remaining concerns
- **Widths not checked visually.** I ran no visual or skeleton-alignment spec. The editor
  should now be about 600 px wide (the full content width less the 220 px list), but I
  haven't confirmed that.
