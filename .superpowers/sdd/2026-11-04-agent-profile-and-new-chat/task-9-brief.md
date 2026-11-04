### Task 9: Design: greeting, agents row and panel, quick-action links

**Files:**
- Create: `packages/design/src/conversation/{greeting.tsx,agent-row.tsx}`.
- Modify:
  - `packages/design/src/templates/conversation-page.tsx` (new-conversation slot props)
  - `docs/design/spec.md` §6.16: new §6.16.25 Greeting, §6.16.26 Agent row, and §6.16.27 Quick actions, each with its state list and size table
  - `/dev/ui` blocks, the reference HTML and `accepted.ts`
- Test: `packages/design/test/new-conversation.test.tsx`.

**Interfaces:**
- Consumes: Task 4's `Avatar`.
- Produces:
  - **`Greeting({ text, sub })`**:
    - the pixel capybara (unit 2) plus the typed text;
    - typing runs at 40 ms per character, once on mount;
    - under reduced motion the whole text shows at once;
    - the caret is `accent`;
    - a server render shows a same-height placeholder with no text.
  - **`AgentRow({ agents, selected, onSelect, max = 5, moreLabel })`**:
    - `agents` are `{ id, name, description, avatar: AvatarValue }[]`;
    - chips show the `Avatar` (22) and the name;
    - "更多 +N" opens `AgentPanel`.
  - **`AgentPanel({ agents, recent, onSelect, onClose })`**:
    - a search over name and description;
    - groups "最近用过" and "全部 N 个";
    - two-column rows with the `Avatar` (28), the name and a one-line description;
    - arrows and Enter select; Escape closes.
    - It is a popover anchored under the row (my call: the design's existing popover primitive).
  - **`QuickActions({ items, onPick, max = 4, moreLabel })`**: `muted` `small` text links with no border, `ink` on hover and focus. Overflow goes into a small menu.

- [ ] **Step 1: Write failing tests.**
  - `"greeting types once and shows whole under reduced motion"`.
  - `"agent row shows 5 then 更多 +N; the panel searches by name and description"`.
  - `"panel keyboard: arrows, Enter selects, Escape closes"`.
  - `"quick actions show 4 then 更多 and call onPick"`.
  - `"one agent: the row renders nothing"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run `pnpm exec vitest run packages/design/test` and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): greeting, agent row and quick actions for a new conversation`.

