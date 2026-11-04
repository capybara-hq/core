### Task 10: Web: the new conversation page and avatars everywhere

**Files:**
- Modify:
  - `apps/web/src/components/conversation/{NewConversation.tsx,ComposerBar.tsx}`
  - `apps/web/src/components/AgentList.tsx`
  - the title bar agent name in `ConversationView.tsx`
  - the sidebar group titles in `components/shell/conversations.tsx`
- Test:
  - `apps/web/test/new-conversation-page.test.tsx`
  - updates to `conversation-page.test.tsx`
- Create: `apps/web/e2e/new-conversation-page.spec.ts`.

**Interfaces:**
- Consumes: Tasks 5, 8 and 9.
- Produces:
  - The page renders, in order:
    - `Greeting` with `pickGreeting(greetingBucket(new Date().getHours()), me.displayName)`, picked after mount;
    - `AgentRow` over the usable agents, ordered by this person's most recent conversation per agent (from the cached conversation groups, falling back to name order);
    - `QuickActions` of the selected agent;
    - the composer without an agent picker.
  - Selecting an agent switches the composer's agent and the quick actions.
  - Picking a quick action replaces the composer text with its body and focuses the composer. The previous text is kept as one undo step, so ⌘/Ctrl+Z restores it (`execCommand("insertText")` keeps the native undo stack, or a local undo buffer for the next ⌘Z; the builder picks one and tests it).
  - `Avatar` is used in `AgentList` rows (28), the conversation title bar next to the agent name (16), and the sidebar group titles (16).

- [ ] **Step 1: Write failing tests.**
  - `"the page shows a greeting for the bucket, the agents row and the first agent's quick actions"`.
  - `"selecting another agent switches the quick actions and the composer's agent"`.
  - `"one usable agent: no row"`.
  - `"picking a quick action fills the composer; ⌘Z restores the previous text"`.
  - `"an agent with avatar null shows its initial in the row, list, title bar and sidebar"`.
  - The e2e checks that the page shows the greeting text, that clicking a quick action fills the composer, and that sending works (`model-fake`).
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm exec vitest run apps/web/test packages/design/test`, `pnpm check`, the typecheck and biome. Expected: PASS. The e2e is not run locally (environment notes in the query-cache plan); CI runs it.
- [ ] **Step 5:** Add changesets:
  - `@capybara-hq/kernel`, minor: agent profiles, avatar routes, prompt files;
  - `@capybara-hq/web`, patch.
- [ ] **Step 6:** Update the docs:
  - the `.agents/skills/writing-web-ui/SKILL.md` line listing the conversation page components;
  - the AGENTS.md "Runtime" bullet on prompt files: `instructions` is derived from `instructionFiles`.
- [ ] **Step 7:** Commit `feat(web): the new conversation page with greeting, agents and quick actions; avatars everywhere`, then push.
