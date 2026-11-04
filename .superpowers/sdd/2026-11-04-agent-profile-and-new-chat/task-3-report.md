# Task 3 report: kernel prompt files

Status: DONE. Commit `3beed5bc feat(kernel): prompt files, joined into the versioned instructions`, pushed to `fix/rc2-acceptance`.

## What was built

- `packages/kernel/src/agents/instruction-files.ts`, which holds:
  - `InstructionFile`;
  - `AGENTS_MD`, `INSTRUCTION_FILE_LIMITS`, `INSTRUCTION_FILE_NAME_RE` (`/^[^/\\]{1,64}\.md$/`) and `AGENTS_MD_STARTER`;
  - `joinInstructionFiles`, `readInstructionFiles` and `InstructionFileSchema`;
  - `InstructionFilesSchema`: 1–20 files, unique names, a joined length of at most 100 000;
  - `AgentDefinitionInput`, which is `AgentDefinition` with `instructions` optional;
  - `deriveInstructions(def, current | null)`.
- `definition.ts`: `instructionFiles: InstructionFilesSchema.optional()`. It has no default, so old definitions stay unchanged and gain no version from it.
- `errors.ts`: `"agent.instructions_mismatch": 400`.
- `agents.controller.ts`: the request definitions (create and update) make `instructions` optional, with no default, so the kernel can tell whether the client actually sent it.
- `agents.service.ts`:
  - `create` derives with `current = null`.
  - `updateIn` derives inside the transaction, against the current version's normalized definition. It derives before the skill, pinned and sub-agent checks, the canonical compare and the insert.
  - `checkModels` / `checkTools` accept `AgentDefinitionInput`.
- `.changeset/agent-prompt-files.md` (kernel patch).

### Exact join rule

- One file gives exactly its `content`.
- Several files give, for each file in order, `` `# ${name}\n\n${content}` ``, joined with `"\n\n"`.

### Save rule (`deriveInstructions`)

- **`instructionFiles` given:** `instructions` becomes the join. If an `instructions` is also given and differs from the join, the save is 400 `agent.instructions_mismatch`.
- **Only `instructions` given:** the definition is stored as given, with no `instructionFiles`. This is old clients and today's web.
- **Neither given, on create:** the definition gets `instructionFiles: [{ AGENTS.md, AGENTS_MD_STARTER }]` and `instructions = AGENTS_MD_STARTER`.
- **Neither given, on update:** the current version's `instructions` and `instructionFiles` are kept. This is my call, see the concerns below.

Limit violations come from zod as 400 `validation_failed`.

### `AGENTS_MD_STARTER` (copy for PR review)

```
You are an assistant for this team. Help people get their work done accurately and efficiently.

- Tone: clear, friendly and concise. Use plain language, keep answers short, and add detail when asked.
- When a request is unclear or missing key details, ask one short clarifying question before acting.
  If you go ahead anyway, say what you assumed.
- If you don't know something or can't do it, say so instead of guessing.
```

### Readers left unchanged

None of these was touched, and all of them keep reading `instructions`:

- `build.ts`;
- `runtime/subagents/definition.ts`. Its general-purpose copy lists fields explicitly, so `instructionFiles` never enters `subagent_started.definition`;
- `evals/runs.controller.ts` and `step-replay.ts`;
- `reconstruct.ts`.

## TDD evidence

- **RED 1** (`pnpm exec vitest run packages/kernel/test/agents/instruction-files.test.ts`): the import failed because `instruction-files.ts` did not exist yet. Output: "Test Files 1 failed, Tests no tests".
- **RED 2**: I added the module and ran the same command before wiring the schema and the service. Result: `Tests 5 failed | 3 passed (8)`. The pure join and read tests passed. Every HTTP test failed:
  - the save test, with `expected undefined to deeply equal [ { name: 'AGENTS.md', … }, … ]`;
  - the mismatch test, with `expected 201 to be 400`;
  - the limits test, on the duplicate-names case, with `expected 201 to be 400`;
  - the starter test, with `expected undefined …`;
  - the model-visible test, because the system prompt differed.
- **GREEN** (same command): `Tests 9 passed (9)`, after adding the "update given neither" test.

## New test titles (`packages/kernel/test/agents/instruction-files.test.ts`)

- `one AGENTS.md joins to exactly its content`
- `several files join with # name headers in order` (exact string written in the test)
- `an old definition reads as one AGENTS.md`
- `saving instructionFiles stores the join as instructions; a matching instructions is accepted`
- `a mismatching instructions is 400 agent.instructions_mismatch` (create and patch; no version)
- `limits: duplicate names, 21 files, 100 001 characters, zero files, a name without .md`. Each of these is a 400. The test also covers:
  - two 50 000-character files whose joined headers push the total over the limit;
  - `a/b.md`;
  - a 65-character stem;
  - 20 files, which is accepted.
- `a new agent with no prompt gets the AGENTS.md starter; a request with only instructions keeps working`
- `an update given neither field keeps the current prompt; one AGENTS.md keeps an old agent's text`
- `instructions stays the model-visible field`. It saves two files over HTTP, reads the stored definition and runs `buildModelRequest`. `system` must equal `` `${BEHAVIOR_RULES}\n\n${joinInstructionFiles(files)}` ``.

## Zero-drift runs

Command: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts packages/kernel/test/runtime/context`

- Before the change: Test Files 9 passed, Tests 97 passed.
- After the change: Test Files 9 passed, Tests 97 passed.
- No fixture was edited.

## Other runs

- `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/evals packages/kernel/test/agents packages/kernel/test/tools/rename-compat.test.ts`: 60 files passed; 1371 tests passed, 1 skipped.
- One intermediate failure came first, in `pinned-skills.test.ts`: "a definition without skills.pinned saves without a new version on an unrelated edit". That test creates the agent without `instructions` (so it gets the starter), then PATCHes without them. Before I changed the rule, that PATCH reset the prompt to `""` and wrote version 2. That failure is why an update given neither now keeps the current prompt. The test file was not edited.
- `pnpm check`: all checks passed.
- `pnpm typecheck`: exit 0.
- `pnpm exec biome check packages/kernel`: 0 errors. The 9 warnings are in files I did not touch.

## Files changed

- `packages/kernel/src/agents/instruction-files.ts` (new)
- `packages/kernel/src/agents/definition.ts`
- `packages/kernel/src/agents/agents.controller.ts`
- `packages/kernel/src/agents/agents.service.ts`
- `packages/kernel/src/errors.ts`
- `packages/kernel/test/agents/instruction-files.test.ts` (new)
- `.changeset/agent-prompt-files.md` (new)

## Self-review and concerns

1. **Update given neither keeps the current prompt.** Before this change it meant `instructions: ""`. This is a behavior change for clients that omitted `instructions` to clear it. Such a client now has to send `instructions: ""` or `instructionFiles`. It also fits Task 7's per-section saves. Please confirm.
2. **The starter is model-visible.** It applies only to API creates that omit both fields. Every existing service-level and web create still sends `instructions`, so they behave as before. Today's web sends `instructions: ""` for an empty prompt, so the web gets no starter until Task 7 sends `instructionFiles`. Task 7 should prefill AGENTS.md with the same text, or simply omit the prompt on create.
3. **Interim data loss on web edits (corrected in fix round 1).** The form used to spread `existing.definition` and then override `instructions`. For an agent with `instructionFiles`, that spread sent both fields, so a prompt edit was refused with 400 `agent.instructions_mismatch`. The form now leaves `instructionFiles` out. The save succeeds and the kernel stores `instructions` without files, so the agent reads back as one AGENTS.md holding the joined text, which is accepted until Task 7. The model-visible text is whatever the person typed.
4. **The agent view is unchanged.** An old definition has no `instructionFiles` in GET. The web must mirror `readInstructionFiles` (Task 7 already says "Old agents show one AGENTS.md").
5. **Mismatch on update is checked late.** It is checked inside the update transaction, after the model and tool checks. It is still a 400 with nothing written.
6. **Saving one AGENTS.md onto an old agent creates a new version.** The `instructions` text is identical, but the definition gains `instructionFiles`. That is expected, and there is no model-visible change.
7. **AGENTS.md is not updated.** The plan leaves the AGENTS.md "Runtime" bullet to a later task.

---

# Fix round 1

Commit `2e913b0f fix(kernel,web): prompt files stay out of sub-agent events; the form edits any agent`, pushed.

## Findings and what changed

1. **Sub-agent event shape** (`runtime/subagents/definition.ts`, `orgAgentDefinition`): the destructure now also drops `instructionFiles`. An org agent dispatched as a sub-agent therefore freezes a `subagent_started.definition` without them, and its `instructions` is the join.
2. **Web form** (`apps/web/src/components/AgentForm.tsx` `save()`): the spread of `existing.definition` leaves out `instructionFiles`, so the form sends `instructions` only. Note 3 above is corrected.
3. **File names**:
   - They are refused when they contain control or format characters. The check reuses the kernel's shared `CONTROL_OR_HIDDEN_RE` (`packages/kernel/src/text.ts`), the rule conversation titles use. Its coverage:
     - it covers Cc and Cf, including bidi marks, zero-width characters and BOM;
     - ZWNJ and ZWJ are allowed, as in titles.
   - Uniqueness is now checked case-insensitively (`toLowerCase`).
   - I chose `CONTROL_OR_HIDDEN_RE` over the SDK's `hasControlChars` because `hasControlChars` covers only C0 and C1 control characters, not bidi or format characters.
4. **Eval candidate** (`evals/step-replay.ts`): a new helper, `withInstructions(def, instructions)`, drops `instructionFiles` when a candidate overrides `instructions`. It is used for both the candidate definition and `subagentVersion`.

## New test titles

- `packages/kernel/test/runtime/subagents/definition.test.ts`: `an org agent saved with prompt files dispatches with their join and no instructionFiles`
- `packages/kernel/test/evals/step-replay.test.ts`: `an instructions override drops the prompt files it no longer matches`
- `packages/kernel/test/agents/instruction-files.test.ts`:
  - `file names refuse control, bidi and format characters`, covering:
    - BEL, newline, U+202E, U+200B and U+FEFF, each a 400;
    - a name with ZWNJ, which is accepted;
  - `file names are unique ignoring case`, where `AGENTS.md` with `agents.md` is a 400.
- `apps/web/test/agent-form.test.tsx`: `editing the prompt of an agent saved with prompt files sends instructions only`

## TDD evidence

- **RED, kernel:** I temporarily restored the three kernel source files from HEAD and ran the three kernel test files: `Tests 4 failed | 42 passed (46)`. All four new kernel tests failed.
- **RED, web:** `-t "prompt files"` failed with `AssertionError: expected { name: 'Echo', …(8) } to not have property "instructionFiles"`.
- **GREEN, the three kernel test files:** `Tests 46 passed (46)`.
- **GREEN, `apps/web/test/agent-form.test.tsx`:** `Tests 27 passed (27)`.
- **GREEN, `pnpm exec vitest run packages/kernel/test/agents packages/kernel/test/runtime packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts apps/web/test/agent-form.test.tsx`:** `Test Files 61 passed (61)`; `Tests 1403 passed | 1 skipped (1404)`.
- **Zero-drift** (reconstruct, rename-compat, runtime/context): `Test Files 9 passed`, `Tests 97 passed`. The fixtures are unchanged.
- **`pnpm check`:** all checks passed. This includes `check:web-ui`.
- **`pnpm typecheck`:** passes. A first run failed with TS2339 on the destructure; the fix was to type it as `Record<string, unknown>`.
- **`biome check packages/kernel apps/web`:** 0 errors. The 9 warnings are the pre-existing ones.

## Files changed in round 1

- `packages/kernel/src/agents/instruction-files.ts`
- `packages/kernel/src/runtime/subagents/definition.ts`
- `packages/kernel/src/evals/step-replay.ts`
- `packages/kernel/test/agents/instruction-files.test.ts`
- `packages/kernel/test/runtime/subagents/definition.test.ts`
- `packages/kernel/test/evals/step-replay.test.ts`
- `apps/web/src/components/AgentForm.tsx`
- `apps/web/test/agent-form.test.tsx`

## Concerns

- **The pull ran in the wrong order.** `git pull --rebase` before the commit refused to run because the tree had uncommitted changes. I committed first and pushed, and the push was a fast-forward from `3beed5bc`, so nothing landed from the other machine in between.
- **No web changeset.** The web change is an interim fix, and the kernel changeset already covers the kernel side. `@capybara-hq/web` is private, but it is in the image tag's fixed group, so add one if you want this fix to bump the tag on its own.

---

# Fix round 2

Commit `ac0cb752 fix(kernel): a save with the same joined text keeps the prompt files`, pushed.

## Change

The fix is in `deriveInstructions` (`packages/kernel/src/agents/instruction-files.ts`). It applies when a save sends `instructions` but no `instructionFiles`:

- **The text equals the join of the current version's `instructionFiles`:** the current files are kept. An unrelated form save therefore writes no version on its own, and the file structure survives.
- **The text differs:** the files are dropped and the new `instructions` is stored, as before.

## New tests (`packages/kernel/test/agents/instruction-files.test.ts`)

- `an unrelated save sending the joined text keeps the files; a changed text drops them`. It runs three saves:
  - the same definition without files: still version 1, files kept;
  - a save that only changes the tools: version 2, files kept, `instructions` equals the join;
  - a save with new text: version 3, `instructions` is the new text, no `instructionFiles`.
- `file names refuse control, bidi and format characters` now also accepts `工作流程.md` alongside `AGENTS.md` (201, name stored as given).

## Evidence

- **RED:** I ran the test file with HEAD's `instruction-files.ts` restored. The new save test failed with `Tests 1 failed | 11 passed (12)` and `AssertionError: expected 2 to be 1`.
- **GREEN:** `Tests 12 passed (12)`.
- **Full run** (`pnpm exec vitest run packages/kernel/test/agents packages/kernel/test/runtime packages/kernel/test/evals packages/kernel/test/tools/rename-compat.test.ts apps/web/test/agent-form.test.tsx`): `Test Files 61 passed (61)`; `Tests 1404 passed | 1 skipped (1405)`.
- **Zero-drift** (reconstruct, rename-compat, runtime/context): 9 files passed, 97 tests passed, with the fixtures unchanged.
- **`pnpm check`:** all checks passed.
- **`pnpm typecheck`:** exit 0.
- **`biome check packages/kernel apps/web`:** 0 errors. The 9 warnings are the pre-existing ones.
- **Order:** commit, then `pull --rebase` (already up to date), then push.

## Concern

A client that deliberately re-sends exactly the joined text in order to flatten the files into one AGENTS.md cannot do that by sending `instructions` alone. It has to send `instructionFiles`. That fits the ruling.
