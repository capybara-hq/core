# Task 8 report: create flow and greeting logic

Status: DONE_WITH_CONCERNS. Commits: f9869e43 (feat), a27690b8 (biome format of the messages). Pushed.

## Built
- `components/AgentForm.tsx`: create form only (avatar picker with a random preset drawn after mount, name, model, visibility `private`). Sends neither `instructions` nor `instructionFiles`, and no tools, so the kernel's AGENTS.md starter and default tools apply.
- Upload path: create with the preselected preset, then `uploadAvatar`, then `updateAgentProfile` with `{kind:"upload", uploadId}` and `expectedUpdatedAt` from the create answer. Failure after create: the agent still exists and we push `/agents/<id>?s=basics&avatar=failed`. `BasicsSection` reads that query on mount and shows `agents.page.createUploadFailed`. Success redirects to `/agents/<id>?s=prompt`.
- `lib/agents.ts`: `randomPreset` (client mirror, from design `AVATAR_PRESET_IDS`), `AgentCreateDefinition`, `createAgent` takes `profile`; removed dead `DEFAULT_BUILTIN_TOOLS`.
- `agents/new/view.tsx`: always redirects as above (the setup-layout `/chat?agent=` special case is gone), cancel goes to `/agents`.
- `lib/routes.ts`: `/agents/new` also prefetches attachment limits (upload-off state with no browser read).
- `lib/greeting.ts`: `GreetingBucket`, `greetingBucket`, `pickGreeting(bucket, name, random?, lines?)` (default lines are zh).
- Messages: `chat.greeting.<bucket>` arrays plus `chat.greeting.sub` (zh verbatim from the spec, en to match); `agents.page.createUploadFailed`; `agents.form.basicSectionHint` rewritten; removed unused `form.instructionsLabel` / `instructionsHelp`.

## TDD
- RED: `pnpm exec vitest run apps/web/test/greeting.test.ts` with `greeting.ts` moved away: "Test Files 1 failed, no tests" (import of `../src/lib/greeting` unresolved). The create test was written against the new form and first run after the implementation; the old form could not satisfy it (it had no avatar picker or tools-free body), so the RED for it is by construction rather than a captured run.
- GREEN: `pnpm exec vitest run apps/web/test/agent-create.test.tsx apps/web/test/greeting.test.ts`: 2 files, 9 tests passed.
- Full: `pnpm exec vitest run apps/web/test tools/checks`: 106 files, 1946 tests passed. `check:web-ui`, `check:i18n`, web typecheck, `biome check apps/web`: all clean.

## Test titles
agent-create.test.tsx:
- create sends the preset, name, model and private, then lands on ?s=prompt
- create without a name is refused
- the form is a FormPage with one section and no more, in zh too
- an upload creates with the preset, uploads, saves the profile, then lands on ?s=prompt
- a failed upload after the create still lands on the agent, at Basics with the error
- picking a preset after an upload drops the upload

greeting.test.ts:
- greetingBucket bounds
- pickGreeting fills {name} and stays in the bucket
- the greeting copy has the same shape in zh and en

## Removed tests (create form no longer has these fields)
- agent-form.test.tsx: whole "新建 Agent 页（FormPage）" describe (model select + definition body with tools, setup-layout lands on /chat, Enter-submit with instructions textarea, focus/disabled save, empty-name Enter, warnings + Continue). The still-applicable ones (empty name, disabled save, FormPage template, model select, save posts) are re-done in agent-create.test.tsx. The warnings/Continue flow is gone: no fallback, so the kernel returns none. The `/agents/new` SSR test lost its connector/skill checkbox assertions.
- agent-skills.test.tsx: the "新建 agent：选择组织技能" describe (5 tests, zh/en) and the create-based pinned test "selecting a suggested skill ticks pinned by default..." (zh/en). The edit-side skills tests remain.
- connectors.test.tsx: "新建 agent：工具选择与策略收紧" (zh/en). Tool policies are covered by the Tools section tests.
- model-params.test.tsx: the "AgentForm 模型参数" describe (4 tests: model switch drops keys, tier drop, fallback params, validation_failed details). `ModelParams` unit tests stay.
- app-layout.test.tsx: not removed, only a stub route added for attachments/limits.

## Files
apps/web: src/components/AgentForm.tsx, src/app/(app)/agents/new/view.tsx, src/components/agent/BasicsSection.tsx, src/lib/agents.ts, src/lib/query/routes.ts, src/lib/greeting.ts (new), messages/{en,zh}.json; tests agent-create (new), greeting (new), agent-form, agent-skills, connectors, model-params, app-layout.

## Self-review
- No styles added; all copy in zh and en; comments in English.
- SSR: the random preset is drawn in an effect to avoid a hydration mismatch; the first paint has no preset checked.

## Concerns
1. The model defaults to the first available model: no org default model exists in the web API.
2. FormPage's create focus lands on the first field, which is now the avatar group, not the name.
3. `useUpdateProfile(orgId, agentId)` needs the agent id up front, so the create flow calls `updateAgentProfile` directly inside `useAppMutation` instead.
4. The failure notice travels as `?avatar=failed` and is read with `window.location` in an effect (no `useSearchParams`, which the test mocks lack).
5. `pickGreeting` takes the locale's lines as an optional 4th parameter (Task 10 should pass `t.raw`); the default imports zh.json.
6. No changeset added (web is in the `fixed` image-tag group; the controller may want one).

## Fix round 1
1. Model-section coverage re-homed to `/agents/ag1?s=model` in `model-params.test.tsx` (assert PATCH bodies, strict `toEqual` on the param maps):
   - switching the main model re-renders the params and drops keys the new model does not declare or allow; the save sends modelParams
   - switching to a model that no longer declares the tier drops the old value; a model without params has no params section
   - the fallback model has its own params; removing the fallback clears fallbackParams
   - the fallback params the person sets are saved with the fallback
   - validation_failed details show beside their fields (zh / en)
   RED: temporarily replaced `keepDeclared(...)` in `ModelSection.tsx` with the unfiltered values: 3 failed | 9 passed (the three param tests; the first version with `toMatchObject` stayed green, so assertions were tightened to `toEqual`). Earlier run with the details mapping disabled: the two validation_failed tests failed. GREEN after restoring: `Tests 12 passed (12)`.
2. `pickGreeting(bucket, name, lines, random = Math.random)`: `lines` is the required `chat.greeting` object (`GreetingLines`, by bucket); the zh.json import is gone from the lib; tests updated (3 pass).
3. One-line comment in `AgentForm.tsx`; note added under spec §2.4.
4. Create focus goes to the name (microtask after FormPage's own focus effect); test "the form is a FormPage with one section and no more, name focused, in zh too".
5. `?avatar=failed` is cleared with `router.replace('/agents/<id>?s=basics')` after the notice shows. Tests in agent-page.test.tsx: "landing from a create with a failed avatar upload shows the notice once and clears the query", "without the avatar query Basics shows no upload notice and does not navigate".
6. Changeset `.changeset/agent-create-short-form.md` (`@capybara-hq/web` patch).
Checks: `apps/web/test` 85 files / 1705 tests pass; check:web-ui, check:i18n, typecheck, biome, `pnpm check` all pass.
