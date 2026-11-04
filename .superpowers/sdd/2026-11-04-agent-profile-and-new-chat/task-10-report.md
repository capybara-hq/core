# Task 10 report: the new conversation page and avatars everywhere

Status: DONE. Commit `7765b32f` (`feat(web): the new conversation page with greeting, agents and
quick actions; avatars everywhere`), pushed to `fix/rc2-acceptance`.

## What was built

### The new conversation page (`/chat`, `NewConversation.tsx`)

Top to bottom it shows:
- `Greeting`;
- `AgentRow`;
- `QuickActions`;
- the composer.

The instant-send flow is unchanged: the pending bubble, the working line, the cache seed and
`sentAt`.

- **Greeting**
  - It is picked in a mount `useEffect` with `pickGreeting(greetingBucket(new Date().getHours()), me.account.displayName, t.raw("greeting"))`.
  - The server render and the first client render pass `text={null}`, so `Greeting` draws its same-height placeholder and nothing mismatches at hydration.
  - The sub line is `chat.greeting.sub`.
- **Agent order**: the new exported `orderAgents(agents, groups, locale)`.
  - It ranks agents by the cached conversation groups. The groups are per agent and most recent first.
  - The remaining agents follow by name (`localeCompare` in the page locale).
  - It returns `recent`: the usable agent ids that have a recent conversation, in order. These are passed to `AgentRow`.
  - The default agent rule is unchanged: `?agent=`, then the most recent, then the first.
- **Selecting an agent**
  - It sets the agent, so the composer's placeholder, the skills and the quick actions follow.
  - It focuses the composer through the new `ComposerControl.focus()`.
  - Design fix in `AgentRow`: a pick in the panel sets a flag, and `RP.Content onCloseAutoFocus` calls `preventDefault()`. Radix therefore no longer moves the focus back to 「更多」 after a selection; Escape still returns it.
- **Quick actions**
  - They are mapped to `{ id: String(i), title }`, and the body is looked up in `onPick`.
  - The line is keyed by agent, and the design returns `null` when there are none, so the line is hidden.
  - The row hides itself when there is at most one usable agent; that was already in the design.
- **No agent picker**: `ComposerBar`'s `pickers.agent` is now optional, and the new page omits it.

### Quick-action fill with undo (`ComposerBar.tsx`)

I chose a local one-step undo buffer.
- React sets the value of a controlled textarea, and the browser does not put that change on its undo stack.
- `execCommand` is deprecated and jsdom can't verify it.

How it works:
- New `control?: Ref<ComposerControl>` prop, filled with `useImperativeHandle`. `ComposerControl` has `fill(text)` and `focus()`.
- `fill` remembers `{ before, text }`, sets the text and focuses the textarea.
- The next ⌘Z or Ctrl+Z (`isUndoKey`, exported) restores `before` with `preventDefault`, but only while the text is still the filled text. Then the buffer is cleared.
- Any edit (`onChange`) also clears the buffer, so later ⌘Z presses are the browser's own.

### Avatars

Small design additions; apps/web writes no styles:
- **`ObjectRow`**: `mark.avatar?: AvatarValue` draws `Avatar` 28 centred in the mark's 36 px place, on no ground (`data-kind="avatar"`). `AgentList` passes `avatarValue(agent, agent.orgId)`.
- **`TitleBarProps.path` segments**: an optional `avatar` leads the segment with `Avatar` 16, then `space.1`, then the name. The name now carries the ellipsis.
  - `ConversationView` adds `avatarValue(agent)` to the agent segment.
  - The agent comes from the cached agents query it already reads.
- **`SidebarGroup.agentAvatar?: AvatarValue`**: `Avatar` 16 before the group name.
  - `useConversationGroups` reads the agents cache only, with `useQuery({ ...agentsQuery(orgId), enabled: false })`, so there is no new read.
  - A group whose agent is not cached gets `null`, which shows the initial of its name.
- Agents with `avatar: null` show their initial everywhere; the `Avatar` component already does this.

### Design spec

- §6.16.1 (the title bar path avatar).
- The sidebar groups bullet.
- §6.17 (`mark.avatar`).
- §6.16.26 (focus after a panel pick).

No new states or size-table rows, so the fidelity lists are unchanged.

## TDD evidence

RED (before any implementation):
```
$ pnpm exec vitest run apps/web/test/new-conversation-page.test.tsx
     × the page shows a greeting for the bucket, the agents row and the first agent's quick actions
     × selecting another agent switches the quick actions and the composer's agent
     × one usable agent: no row
     × picking a quick action fills the composer; ⌘Z restores the previous text
     × an agent with avatar null shows its initial in the row, list, title bar and sidebar
 Test Files  1 failed (1)
      Tests  5 failed (5)
```

GREEN:
```
$ pnpm exec vitest run apps/web/test/new-conversation-page.test.tsx
      Tests  5 passed (5)
$ pnpm exec vitest run apps/web/test packages/design/test
 Test Files  137 passed (137)
      Tests  2614 passed (2614)
$ pnpm check       -> All checks passed
$ pnpm typecheck   -> clean
$ pnpm exec biome check apps/web packages/design -> 0 errors (the 2 earlier CSS
  noDescendingSpecificity warnings, conversation-page.css / templates.css:426, untouched)
$ commitlint on the commit message -> clean
```

## Test titles

New file `apps/web/test/new-conversation-page.test.tsx`. The clock is faked for `Date` only at 09:00 local, and `Math.random` returns 0.

- **"the page shows a greeting for the bucket, the agents row and the first agent's quick actions"**
  - The greeting is "Good morning, Grant", with the sub line.
  - The chips run Beta, Alpha (recent), then Delta, Epsilon, Eta (by name), then "More +2"; Beta is pressed.
  - Quick actions: Plan, Review, Draft, Polish, then More.
  - The composer has no agent picker.
  - The DOM order is greeting, row, quick actions, composer.
- **"selecting another agent switches the quick actions and the composer's agent"**
  - A chip changes the quick actions and the placeholder, and focuses the composer.
  - A pick in the panel (Gamma, no quick actions) hides the line. The focus is on the composer and still there after Radix's deferred close.
  - The send posts `agentId` of the selected agent.
- **"one usable agent: no row"**
- **"picking a quick action fills the composer; ⌘Z restores the previous text"**
  - Fill, then ⌘Z restores the old text.
  - A second ⌘Z is not intercepted.
  - Ctrl+Z works too.
  - An edit after a fill leaves ⌘Z to the browser.
- **"an agent with avatar null shows its initial in the row, list, title bar and sidebar"**
  - Row chip (24) and a preset in the row.
  - `/agents` row (28).
  - The title bar link (16).
  - Sidebar group heads (16): an initial, a preset, and the uncached `gone agent`, which shows "G". The agents query is never fetched.

Updated in `conversation-page.test.tsx`:
- "the title bar path is <org slug> / <agent> / before the title; the agent links to its page with its avatar". Avatar 16 shows "E"; the path text is otherwise unchanged.
- "?agent= picks the agent; …": the pressed chip replaces the name heading.
- "without ?agent= the agent most recently talked to is picked, and the agents row changes it". This was the agent-picker menu.
- "with a model and an agent the composer shows as before": checks the chip and the composer.

Fixtures given a `profile`, because the kernel always sends one:
- `test/support/conversation.ts` (`PROFILE`, avatar null);
- `pages.test.tsx` (`agentRow`);
- `app-layout.test.tsx`.

## Files

New:
- apps/web/test/new-conversation-page.test.tsx
- apps/web/e2e/new-conversation-page.spec.ts
- .changeset/new-conversation-page.md

Modified:
- apps/web/src/components/conversation/{NewConversation.tsx,ComposerBar.tsx,ConversationView.tsx}
- apps/web/src/components/AgentList.tsx
- apps/web/src/components/shell/conversations.tsx
- apps/web/test/{conversation-page.test.tsx,pages.test.tsx,app-layout.test.tsx,support/conversation.ts}
- apps/web/e2e/{conversation-send.spec.ts,conversation-capabilities.spec.ts,support/chat.ts}: they waited on the old `new-conversation-body h2` agent-name heading. They now wait on the composer placeholder ("想让 {agent} 做什么？").
- packages/design/src/conversation/{agent-row.tsx,title-bar.tsx}
- packages/design/src/display/object-list.tsx
- packages/design/src/shell/sidebar-conversations.tsx
- packages/design/src/styles/{conversation-page.css,templates.css}
- docs/design/spec.md
- .changeset/{agent-profiles.md,agent-prompt-files.md}
- AGENTS.md
- .agents/skills/writing-web-ui/SKILL.md

## Changesets and docs

- `.changeset/agent-profiles.md` and `agent-prompt-files.md` were `patch` and are now `minor` for `@capybara-hq/kernel`, per the plan. `agent-profiles.md` also names the avatar upload and serve routes.
- New `.changeset/new-conversation-page.md`: a `@capybara-hq/web` patch covering the greeting, the agents row, the quick actions with undo, and the avatars in the list, title bar and sidebar.
- The `writing-web-ui` SKILL.md conversation-page row now says that `/chat` passes `newConversation` with `Greeting`, `AgentRow` and `QuickActions`, and that the composer has no agent picker.
- AGENTS.md "Runtime" bullet gains: "An agent's `instructions` is derived from its `instructionFiles` on save."

## Not run

- **The e2e `apps/web/e2e/new-conversation-page.spec.ts` was not run locally**: there are no Playwright browsers, and it collides with the user's dev web.
  - It is written to check: the greeting line (any bucket, by the heading's sr-only copy), a quick action filling the composer and focusing it, then a send echoed by model-fake.
  - The three e2e files edited for the removed heading were not run either. CI runs them.
- Visual, fidelity and reference specs, Next builds and the visual-update / reference-update workflows were not run or triggered.
  - Screenshot baselines will differ where avatars now appear (agent list, sidebar groups, title bar) and on the new-conversation state.
- No SSR-specific test asserts that the server HTML has the greeting placeholder. The guarantee is structural: the line is set only in `useEffect`, and Task 9's tests pin the placeholder rendering.

## Self-review

- **Focus after selection**: tested on both the chip and the panel paths. The panel test waits past Radix's `setTimeout(0)` unmount auto-focus.
- **Undo**: it intercepts only while the text equals the filled text and only once, so the native undo is otherwise untouched. The skill chip and attachments are not part of the undo; only the text is replaced, as the brief says.
- **Reads**:
  - The new page reads nothing new: agents, groups and models were already cached for `/chat`.
  - The sidebar uses `enabled: false`, which is the pattern ComposerBar already uses.
  - The title bar reuses its existing agents query.
- **`orderAgents`**: sorts with `localeCompare` in the page locale and skips groups whose agent is not usable.

## Concerns

1. On pages other than `/chat*` and `/agents`, the agents query may not be in the cache, so sidebar groups show initials there. They switch to the preset once some page caches the agents. This follows the "no new read" rule, but it can flicker from initial to animal on first navigation.
2. `AgentRow` (design) now prevents Radix's close auto-focus after a pick. A future caller whose `onSelect` moves the focus nowhere leaves it on the body, not on 「更多」.
3. `ObjectRow mark.avatar` keeps the 36 px column with a transparent ground around a 28 avatar, to keep the skeleton and row alignment. Say so if the avatar should fill the mark instead.
