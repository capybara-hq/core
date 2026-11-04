# Agent Profile, Agent Page and New Conversation Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agents get an avatar, a description and quick actions; the agent page becomes a sectioned page with per-section saves and named prompt files; the new conversation page gets a time-of-day greeting, an agents row and quiet quick actions.

**Architecture:** The profile (avatar, description, quick actions) is display data outside `agent_versions`, written through its own kernel endpoint with an `updatedAt` check and an audit row. Prompt files are an authoring form in the versioned definition from which the kernel derives the model-visible `instructions`, so nothing that reads `instructions` changes. The design package owns the pixel-animal presets, `Avatar`, the greeting, the agents row and its panel; the web wires them through the query layer.

**Tech Stack:** NestJS + Kysely (kernel), PostgreSQL migrations, Next 16.4 + React 19.3 + TanStack Query 5 (web), `packages/design`, vitest, Playwright (visual).

**Spec:** `docs/superpowers/specs/2026-11-04-agent-profile-and-new-chat-design.md` (parts 1–3; part 4 waits for the tool-rename work and is not in this plan).

> **Note (2026-11-04):** the migrations were renumbered after main's `0063_tool_keys_claude_code`; `0066_agent_profiles` below is now `0067_agent_profiles`.

## Global Constraints

- Work on `fix/rc2-acceptance`, in `.claude/worktrees/fix-rc2-acceptance`. Another machine also pushes to it, so run `git pull --rebase origin fix/rc2-acceptance` before every commit.
- Repo rules come from `AGENTS.md`:
  - kernel conventions: `@Inject`, `@Transactional`, `createZodDto` plus `@ZBody`/`@ZParam`, `afterCommit`, and no enqueue inside a transaction;
  - migrations are `NNNN_<snake>.sql`, expand-only, `IF NOT EXISTS`;
  - `apps/web` writes no styles;
  - UI text is i18n in zh and en;
  - code comments and test titles are in English.
- Profile limits:
  - `description` is at most 500 characters and may be empty;
  - `quickActions` holds at most 9 entries;
  - a quick action's `title` is 1–40 characters and its `body` is 1–20 000 characters.
- Presets: exactly 10, with ids `capybara`, `black-bear`, `panda`, `elephant`, `fox`, `owl`, `penguin`, `rabbit`, `turtle`, `whale`.
- Upload: png, jpg or webp, at most 2 MB, cropped square in the browser.
- Prompt files: names unique and ending in `.md`; the default and first file is `AGENTS.md`; at most 20 files; a total of at most 100 000 characters; at least one file.
- The profile is never model-visible, and a profile change creates no agent version.
- The definition keeps `instructions` as the model-visible field, derived from `instructionFiles` on save. Old versions read as one `AGENTS.md`.
- New conversation page:
  - the agents row shows at most 5 agents, then "更多 +N";
  - it is hidden when there is one usable agent;
  - quick actions show the first 4 titles, then "更多".
- Greeting copy (zh) is the spec §4.1 table, verbatim; en matches it in tone.
- Visual baselines and reference PNGs come only from the `visual-update` / `reference-update` workflows. Do not trigger them; the user decides.
- Commits use Conventional Commits, with body lines ≤ 100 characters, each ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. An existing agent with no avatar (`avatar: null`) shows its initial in every place an `Avatar` is used. Pinned in Task 4 (component) and Task 10 (adoption).
2. With no object store configured, upload explains why it is off and presets still save. Pinned in Task 2 (503 `storage.unavailable`) and Task 6 (UI).
3. Two tabs edit quick actions. The second save gets 409 and offers a reload, never a silent overwrite. Pinned in Task 1 and Task 6.
4. Clicking a quick action while the composer has text replaces it, and ⌘/Ctrl+Z restores the previous text. Pinned in Task 9.
5. The greeting at hour boundaries: 23:00–04:59 wraps midnight, and 05:00, 11:00, 13:00 and 18:00 each open a new bucket. Pinned in Task 8 (`greetingBucket` unit test).

---

## File map

| Path | Responsibility |
|---|---|
| `packages/kernel/src/migrations/0066_agent_profiles.sql` | profile columns on `capybara.agents` |
| `packages/kernel/src/agents/profile.ts` | profile schema (zod), preset ids, random preset, read/write mapping |
| `packages/kernel/src/agents/agent-profile.service.ts` | `updateProfile`, avatar upload and serve, audit |
| `packages/kernel/src/agents/agents.controller.ts` | `PATCH :agentId/profile`, `POST :agentId/avatar/uploads`, `GET :agentId/avatar` |
| `packages/kernel/src/agents/instruction-files.ts` | `joinInstructionFiles`, `readInstructionFiles`, validation |
| `packages/design/src/display/avatar.tsx`, `avatar-presets.ts` | presets (bitmaps and palettes) and `Avatar` |
| `packages/design/src/conversation/greeting.tsx`, `agent-row.tsx` | the greeting, the agents row and panel, quick-action links |
| `apps/web/src/lib/query/agents.ts` (extend), `apps/web/src/lib/agents.ts` (extend) | profile types, queries, mutations, avatar upload |
| `apps/web/src/app/(app)/agents/[id]/` and `components/agent/*` (new folder) | the sectioned agent page, one file per section |
| `apps/web/src/lib/greeting.ts` | `greetingBucket(hour)`, `pickGreeting` |
| `apps/web/src/components/conversation/NewConversation.tsx` | wiring of the new page |

---

### Task 1: Kernel profile storage and API

**Files:**
- Create:
  - `packages/kernel/src/migrations/0066_agent_profiles.sql`
  - `packages/kernel/src/agents/profile.ts`
  - `packages/kernel/src/agents/agent-profile.service.ts`
- Modify:
  - `packages/kernel/src/agents/agents.controller.ts`
  - `packages/kernel/src/agents/agents.service.ts` (create: profile and random preset)
  - `packages/kernel/src/agents/agents.module.ts`
  - the error codes registry
- Test: `packages/kernel/test/agents/profile.test.ts`

**Interfaces:**
- Produces:
  - `type AgentAvatar = { kind: "preset"; id: PresetId } | { kind: "upload"; uploadId: string } | { kind: "external"; url: string } | null`. The `external` kind exists only for migrated `definition.avatarUrl` values.
  - `interface AgentProfile { avatar: AgentAvatar; description: string; quickActions: { title: string; body: string }[]; updatedAt: string }`
  - The agent view (`GET …/agents`, `GET …/agents/:agentId`, and create's answer) gains `profile: AgentProfile`.
  - `PATCH /api/v1/orgs/:orgId/agents/:agentId/profile` with body `{ avatar?, description?, quickActions?, expectedUpdatedAt: string }`. It answers `{ profile }`, or 409 `agent.profile_conflict`.
  - `POST …/agents` accepts optional `profile`. Without an avatar, the agent gets `randomPreset()`.
  - `PRESET_IDS: readonly PresetId[]` and `randomPreset(): PresetId`.
- Permission: the same check as `PATCH :agentId` today.
- Audit action: `agent.profile_updated`, with `{ fields: string[], channel: "web" | "api" }`. The channel is `api` for service tokens and `web` for sessions.

- [ ] **Step 1: Write failing tests.**
  - `"create without a profile gets a random preset avatar"`: the answer's `profile.avatar.kind === "preset"` and its `id` is in `PRESET_IDS`.
  - `"profile changes create no agent version"`: after a PATCH, `currentVersion` is unchanged.
  - `"profile limits"`: these get 400 `validation_failed`:
    - a `description` of 501 characters;
    - 10 quick actions;
    - a title of 41 characters;
    - a body of 20 001 characters;
    - an unknown preset id.
  - `"a stale expectedUpdatedAt is 409 agent.profile_conflict"`.
  - `"a profile change writes agent.profile_updated with the fields"`.
  - `"an existing definition.avatarUrl migrates once to an external avatar"`: run the migration on a seeded row, then check `profile.avatar` equals `{ kind: "external", url }`.
  - `"old agents read profile.avatar null, description '' and quickActions []"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/kernel/test/agents/profile.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Migration**: on `capybara.agents`, add the nullable columns `profile_avatar jsonb`, `profile_description text NOT NULL DEFAULT ''`, `profile_quick_actions jsonb NOT NULL DEFAULT '[]'` and `profile_updated_at timestamptz NOT NULL DEFAULT now()`. Then backfill `profile_avatar` from the current version's `definition->>'avatarUrl'` where that is not null, as an `external` avatar.
  - Register `agent.profile_conflict` in the error codes.
  - The web stops writing `avatarUrl`; Task 5 does that. The schema keeps it.
- [ ] **Step 4:** Run the test (expected: PASS), then `pnpm exec vitest run packages/kernel/test/agents` (expected: no regressions), then `pnpm check:kernel-conventions`.
- [ ] **Step 5:** Commit `feat(kernel): agent profiles (avatar, description, quick actions) outside the versions`.

### Task 2: Kernel avatar upload and serving

**Files:**
- Modify: `agent-profile.service.ts`, `agents.controller.ts`.
- Test: `packages/kernel/test/agents/avatar.test.ts` (with the `fake-object-store` fixture extension).

**Interfaces:**
- Consumes: Task 1's `AgentAvatar` and `updateProfile`, and `AttachmentsService.create(orgId, accountId, { name, contentType, size }, kind)` as `SkillsService.createUpload` uses it.
- Produces:
  - `POST …/agents/:agentId/avatar/uploads` with body `{ name, contentType: "image/png" | "image/jpeg" | "image/webp", size ≤ 2_097_152 }`. It answers `CreatedAttachment`, the same presigned-upload shape as skills and chat attachments, with kind `agent-avatar`.
  - A profile PATCH accepts `avatar: { kind: "upload", uploadId }`. It finalizes the upload if needed, checks that the uploader is the actor and that the content type is an image, and marks the upload used.
  - `GET …/agents/:agentId/avatar`:
    - for an `upload` avatar: a 302 to a short-lived `presignGet`;
    - for an `external` avatar: a 302 to its URL;
    - otherwise, or when the reader can't see the agent: 404.
  - With no object store, both upload routes answer 503 `storage.unavailable`. Presets still save.

- [ ] **Step 1: Write failing tests.**
  - `"upload registers an image attachment"`.
  - `"a non-image or 2 MB + 1 upload is 400"`.
  - `"saving an upload avatar consumes the upload; a second agent can't reuse it"`.
  - `"GET avatar redirects for a reader who can see the agent and is 404 otherwise"`.
  - `"without an object store the upload is 503 storage.unavailable and a preset still saves"`.
- [ ] **Step 2:** Run the test file. Expected: FAIL.
- [ ] **Step 3:** Implement, following the skills upload's comments for the finalize and consume semantics.
- [ ] **Step 4:** Run the test file and `packages/kernel/test/agents`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kernel): agent avatar uploads and the avatar route`.

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

### Task 4: Design: pixel-animal presets and Avatar

**Files:**
- Create:
  - `packages/design/src/display/avatar-presets.ts`
  - `packages/design/src/display/avatar.tsx`
- Modify:
  - `docs/design/tokens.json` (avatar palettes, with contrast pairs), then run `pnpm gen:tokens`
  - `docs/design/spec.md`: §3 gets the avatar rule, and a new §6.30 Avatar with its state list and size table
  - the design i18n (preset names)
  - `/dev/ui` reference blocks, the reference HTML and `accepted.ts`
- Test: `packages/design/test/avatar.test.tsx`.

**Interfaces:**
- Produces:
  - `AVATAR_PRESETS: Record<PresetId, { bitmap: string[]; palette: Record<string, string>; ground: string }>`. Palette values are token names, so there are no literals.
  - `type AvatarValue = { kind: "preset"; id: PresetId } | { kind: "image"; src: string } | null`.
  - `Avatar({ value, name, size }: { value: AvatarValue; name: string; size: 16 | 22 | 28 | 40 | 64 })`:
    - a preset draws its bitmap with `crispEdges` on its ground;
    - an image draws an `<img>`, falling back to the initial on error;
    - `null` draws the initial square as today's.
  - `AvatarPicker({ value, onChange, onUpload? })`: the 10 presets plus an upload tile. With no `onUpload`, the tile is disabled, with a reason prop.
- Bitmaps: draw the 10 animals in the logo's style (spec §3). The first-pass drawings are reviewed by the user in the PR through `/dev/ui/reference/avatar`.

- [ ] **Step 1: Write failing tests.**
  - `"all 10 presets render with their ground"`.
  - `"null draws the initial"`.
  - `"an image that fails to load falls back to the initial"`.
  - `"sizes 16/22/28/40/64 set the box"`.
  - `"the picker selects a preset and calls onChange"`.
  - `"the upload tile is disabled with its reason when onUpload is absent"`.
- [ ] **Step 2:** Run `pnpm exec vitest run packages/design/test/avatar.test.tsx`. Expected: FAIL.
- [ ] **Step 3:** Implement, then run `pnpm gen:tokens` and `pnpm check:tokens`.
- [ ] **Step 4:** Run `pnpm exec vitest run packages/design/test` and `pnpm check`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(design): pixel-animal avatar presets and the Avatar component`.

### Task 5: Web query layer for profiles

**Files:**
- Modify:
  - `apps/web/src/lib/agents.ts` (types, `updateAgentProfile`, `createAvatarUpload`)
  - `apps/web/src/lib/query/agents.ts` (`profile` on the agent queries, `useUpdateProfile`)
  - the agent create and update callers (stop sending `avatarUrl`)
- Test: `apps/web/test/agent-profile-lib.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–2's routes.
- Produces:
  - `Agent.profile: AgentProfile`, with the same shape as the kernel's.
  - `avatarValue(agent, orgId): AvatarValue`. It maps `upload`/`external` to `{ kind: "image", src: "/api/v1/orgs/<org>/agents/<id>/avatar?v=<updatedAt>" }`.
  - `useUpdateProfile(orgId, agentId)`: a mutation that sends `expectedUpdatedAt`. It sets the agent queries from the answer; on a 409 it surfaces `agent.profile_conflict`.
  - `uploadAvatar(orgId, agentId, file: Blob): Promise<{ uploadId: string }>`, which uses the existing attachment upload helper.
  - i18n for `agent.profile_conflict`, `agent.instructions_mismatch` and `storage.unavailable`.
- [ ] **Step 1:** Write failing tests: `"avatarValue maps presets, uploads and null"`, `"a 409 surfaces agent.profile_conflict"`, `"a profile update sets the cached agent without a refetch"`.
- [ ] **Step 2:** Run them. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them. Expected: PASS. Then run `pnpm check:web-ui`.
- [ ] **Step 5:** Commit `feat(web): agent profile reads, saves and avatar uploads`.

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

### Task 8: Create flow and greeting logic

**Files:**
- Modify:
  - `apps/web/src/app/(app)/agents/new/view.tsx`
  - `apps/web/src/components/AgentForm.tsx` (or its replacement)
- Create: `apps/web/src/lib/greeting.ts`.
- Modify: the messages (greeting copy and create-form strings).
- Test:
  - `apps/web/test/agent-create.test.tsx`
  - `apps/web/test/greeting.test.ts`

**Interfaces:**
- Produces:
  - The create form has:
    - `AvatarPicker`, with a random preset preselected via a client `randomPreset` mirror (the presets list comes from the design package);
    - the name (required);
    - the model (defaults to the org default);
    - visibility, shown as `private` and changeable.
    - Creating answers with a redirect to `/agents/<id>?s=prompt`.
  - `type GreetingBucket = "morning" | "noon" | "afternoon" | "evening" | "night"`.
  - `greetingBucket(hour: number): GreetingBucket`. Bounds: 5–10 morning, 11–12 noon, 13–17 afternoon, 18–22 evening, 23–4 night.
  - `pickGreeting(bucket, name, random = Math.random): string`. It picks from the i18n arrays `chat.greeting.<bucket>`. The zh entries are the spec §4.1 table, verbatim, with `{name}`.

- [ ] **Step 1: Write failing tests.**
  - `"create sends the preset, name, model and private, then lands on ?s=prompt"`.
  - `"create without a name is refused"`.
  - `"greetingBucket bounds"`: assert 4→night, 5→morning, 10→morning, 11→noon, 12→noon, 13→afternoon, 17→afternoon, 18→evening, 22→evening, 23→night and 0→night.
  - `"pickGreeting fills {name} and stays in the bucket"`.
- [ ] **Step 2:** Run the tests. Expected: FAIL. **Step 3:** Implement. **Step 4:** Run them, then `pnpm check:i18n`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(web): a short agent create form and time-of-day greetings`.

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
