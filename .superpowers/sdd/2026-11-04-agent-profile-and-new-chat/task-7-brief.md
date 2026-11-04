### Task 7: Agent page: Prompt files and the other sections

**Files:**
- Create: `apps/web/src/components/agent/{PromptSection.tsx,ModelSection.tsx,ToolsSection.tsx,SkillsSection.tsx,SubagentsSection.tsx,ChannelsSection.tsx}`.
- Modify: `apps/web/src/components/AgentForm.tsx`. Move its section bodies into the new files; it remains only as the create form of Task 8, or is deleted if Task 8 doesn't need it.
- Test: `apps/web/test/agent-page-sections.test.tsx`, plus the moved assertions from `apps/web/test/agent-form.test.tsx`.

**Interfaces:**
- Consumes: Task 6's `AgentPage`, `useSectionDraft` and `AGENT_SECTIONS`, and Task 3's rules (mirrored for client hints only; the kernel is the judge).
- Produces:
  - **Prompt**: the file list on the left, each file's editor on the right; add, rename, delete (not the last one), and reorder.
    - It shows the joined character count against 100 000 and the file count against 20.
    - Save sends `instructionFiles` with `expectedVersion`.
    - Old agents show one `AGENTS.md`.
  - **Model, Tools, Skills, Sub-agents, Channels**: today's form parts, each with its own Save sending only its fields with `expectedVersion`. Rules that depend on visibility read the saved agent's visibility.

- [ ] **Step 1: Write failing tests.**
  - `"prompt: add WORKFLOW.md, reorder, save sends instructionFiles in order"`.
  - `"prompt: the last file can't be deleted"`.
  - `"prompt: a duplicate name is refused before save"`.
  - `"each section's save sends only its fields"`: assert the PATCH bodies.
  - `"skills writePolicy shows only for a saved private agent"`.
  - `"a stale expectedVersion shows the reload action"`.
  - Every existing `agent-form.test.tsx` behaviour keeps an equivalent test, with the moved test names listed in the commit body.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm exec vitest run apps/web/test`, `pnpm check:web-ui` and the typecheck. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): prompt files and the agent sections with their own saves`.

