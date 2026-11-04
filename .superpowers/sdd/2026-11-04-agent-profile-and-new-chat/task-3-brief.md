### Task 3: Kernel prompt files

**Files:**
- Create: `packages/kernel/src/agents/instruction-files.ts`.
- Modify:
  - `packages/kernel/src/agents/definition.ts` (`instructionFiles` in `AgentDefinitionSchema`)
  - `agents.service.ts` (derive on create and update)
- Test:
  - `packages/kernel/test/agents/instruction-files.test.ts`
  - the zero-drift fixtures (`reconstruct.test.ts`, `rename-compat.test.ts`) must stay green, unchanged.

**Interfaces:**
- Produces:
  - `type InstructionFile = { name: string; content: string }`.
  - `joinInstructionFiles(files: InstructionFile[]): string`. Rule: one file gives exactly its content. Several files give, for each file in order, `# <name>\n\n<content>`, joined by `\n\n`.
  - `readInstructionFiles(def): InstructionFile[]`. It returns `def.instructionFiles`, or `[{ name: "AGENTS.md", content: def.instructions }]` when the definition has none.
  - On save: when `instructionFiles` is given, `instructions` is set to the join. A request that gives both, with a differing `instructions`, is 400 `agent.instructions_mismatch`.
  - Validation: names unique, matching `/^[^/\\]{1,64}\.md$/`; 1–20 files; a joined total of at most 100 000 characters.
  - A new agent with no prompt gets `[{ name: "AGENTS.md", content: AGENTS_MD_STARTER }]`. `AGENTS_MD_STARTER` is an English starter of a few lines covering role, tone and what to ask when unclear; its copy is reviewed in the PR.

- [ ] **Step 1: Write failing tests.**
  - `"one AGENTS.md joins to exactly its content"`.
  - `"several files join with # name headers in order"`, with the exact expected string written in the test.
  - `"an old definition reads as one AGENTS.md"`.
  - `"a mismatching instructions is 400 agent.instructions_mismatch"`.
  - `"limits: duplicate names, 21 files, 100 001 characters, zero files, a name without .md"`: each case gets a 400.
  - `"instructions stays the model-visible field"`: build a model request for an agent saved with two files, and assert the system prompt equals `joinInstructionFiles(files)`.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Do not change `build.ts`, the sub-agent definition copy, the evals or `reconstruct.ts`: they keep reading `instructions`.
- [ ] **Step 4:** Run the new tests, `pnpm exec vitest run packages/kernel/test/runtime packages/kernel/test/evals` (zero-drift) and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): prompt files, joined into the versioned instructions`.

