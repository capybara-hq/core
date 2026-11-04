### Task 6: Agent page: layout, Basics, Quick actions, read-only

**Files:**
- Create:
  - `apps/web/src/components/agent/{AgentPage.tsx,BasicsSection.tsx,QuickActionsSection.tsx,sections.ts,useSectionDraft.ts}`
- Modify:
  - `apps/web/src/app/(app)/agents/[id]/{page.tsx,view.tsx}` (and its route entry in `lib/query/routes.ts`)
  - the messages
- Test: `apps/web/test/agent-page.test.tsx`.

**Interfaces:**
- Consumes: Task 5 and Task 4's `Avatar` and `AvatarPicker`.
- Produces:
  - `AGENT_SECTIONS = ["basics", "quick-actions", "prompt", "model", "tools", "skills", "subagents", "channels"] as const`.
  - `READ_ONLY_SECTIONS = ["basics", "quick-actions", "model"]`.
  - The URL `/agents/<id>?s=<section>`, default `basics`.
  - `useSectionDraft<T>(saved: T)` returns `{ draft, set, dirty, reset }`.
  - The page uses `SettingsPage`. Its head shows the `Avatar` (40), the name, a one-line description, and the actions: 开始对话 for everyone; 运行记录 and 重新指派负责人 for the owner and admins.
  - Leaving a dirty section opens a confirm dialog (keep editing or discard) using the existing design `Dialog`. No browser `confirm()`.
  - **Basics**:
    - avatar, name and description;
    - visibility and members, moved from today's form;
    - Save sends the profile through `useUpdateProfile`;
    - name and visibility go through the existing agent PATCH with `expectedVersion`;
    - one Save button, two requests;
    - when the kernel answers with warnings, they show in the section.
  - **Quick actions**: up to 9 entries of title + body (a textarea); add, delete, reorder (up/down buttons). Save goes through the profile.
  - **People who can't edit** see only `READ_ONLY_SECTIONS`, read-only, with no upload or edit controls.

- [ ] **Step 1: Write failing tests.**
  - `"the section nav lists the 8 sections and opens ?s=…"`.
  - `"a non-editor sees only basics, quick actions and model, read-only"`.
  - `"saving basics sends the profile and the name, and sends no other section's draft"`.
  - `"leaving a dirty section asks to keep or discard"`.
  - `"a 409 profile conflict shows the reload action"`.
  - `"quick actions: a 10th cannot be added; reorder; save"`.
  - `"no object store: the upload tile explains and a preset saves"`.
  - Also: the hydrated first render makes no browser read, and an empty cache shows the template's loading state. This is the web query-cache recipe.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them (expected: PASS), then `pnpm check:web-ui` and `pnpm --filter @capybara-hq/web typecheck`.
- [ ] **Step 5:** Commit `feat(web): the agent page by section, with basics and quick actions`.

