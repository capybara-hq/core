# Agent profile, agent page, new conversation page, background section

Status: approved (2026-11-04, from rc2 acceptance; builder check done)
Order of work: part 1 → 2 → 3 → 4. Each part ships on its own and depends only on the parts
before it.

## 0. Why

The new conversation page (`/chat`) works: it offers the agent, model and effort pickers. It
looks thin next to the pages the user compared it with, Claude's home page and Octok's new
conversation page (screenshots 2026-11-04):

- It has no greeting.
- It gives no sense of who you are talking to.
- It offers no starting points.

Agents have nothing to show for themselves: no avatar, no description, no quick actions. Their
edit page is one long form with a single save. The conversation's background section shows only
sub-agents.

## 1. Decisions taken with the user (2026-11-04)

| # | Decision |
|---|---|
| U1 | The new conversation page follows direction B (Octok-like): a greeting, a row of agents, the selected agent's quick actions, then the composer. The quick actions are visually quiet. |
| U2 | Agents get an **avatar**. The platform provides a set of about 10 **pixel animals** in the capybara logo's style, each coloured after the animal (black bear black, elephant grey, …) on a soft matching ground. People can also upload their own. |
| U3 | Creating an agent requires an avatar, and a random preset is preselected. Existing agents without one show their initial. |
| U4 | Agents get a **description**, not a "role". |
| U5 | Agents get up to **9 quick actions**: a title and a body. The body can be long, a whole work procedure. Clicking one puts the body into the composer. |
| U6 | The design rule "no illustrations" is relaxed for agent avatars: appropriate images and colour are wanted. |
| U7 | The agent page has a left section nav (like Octok's, in our design language). Each section saves on its own. It holds only what exists today; knowledge bases and scheduled tasks come later. |
| U8 | The system prompt is a list of **named files**. A new agent starts with one `AGENTS.md`. People can add more files. No other names are suggested. |
| U9 | Creating an agent asks only for what is necessary. The rest is filled in later on the agent page. |
| U10 | Greetings change with the time of day, with a typing effect, in the tone of "夜猫子，干点啥？" / "今天我们推进什么？" / "下午好，<name>". The copy table in §4.1 was accepted. |
| U11 | The conversation's **background** section groups the agent's background Bash tasks and its dispatched sub-agents. A sub-agent's own background tasks show under it. |
| U12 | Planned, not designed here: agents that know and change themselves within the current person's permissions (save a procedure as a skill card, rename itself, change its avatar, install a plugin), offered as an internal MCP endpoint or a tool set. Design part 1 so this can be added later, but don't build it now. |

## 2. Part 1: the agent profile

### 2.1 Fields

The profile has three fields: `avatar`, `description` and `quickActions`.

- **avatar**
  - Either `{ kind: "preset", id }`, where `id` is one of the 10 preset ids,
  - or `{ kind: "upload", ref }`, an object-store key under the kernel's `kernel/<orgId>/` prefix.
  - `null` only for agents created before this change. Those draw their initial, as today.
- **description**: plain text, at most 500 characters (my call), may be empty.
- **quickActions**: at most 9 entries of `{ title, body }`.
  - `title`: 1–40 characters.
  - `body`: 1–20 000 characters.
  - Order is kept.
  - The title and body limits are my call.

### 2.2 Where they live (my call)

- The profile is **display data, not model-visible**. It is stored outside `agent_versions`, so
  changing it creates no agent version and touches no replay.
  - It goes in new columns on `capybara.agents` or a 1:1 `agent_profiles` table; builder's choice.
  - Migrations are expand-only and idempotent, as the repo rules require.
- It is read with the agent (`GET …/agents`, `GET …/agents/:id`) and written through its own
  endpoint, e.g. `PATCH …/agents/:id/profile`. The permission is the same as editing the agent
  today.
- Every change writes an audit row with the actor and the channel (`web`). U12 will add
  `agent`. The endpoint is the one an agent's future self-management tool will call, under the
  person's permission.
- Future, U12: if the agent's own name, description or avatar ever becomes model-visible, it
  enters the log with its own `DriftReason`, per the replay rules. Nothing in this design makes
  them model-visible.

### 2.3 Avatars

- **Presets**: 10 pixel animals.
  - They are drawn like the logo (§3 of the design spec): a bitmap, `crispEdges`, solid
    squares.
  - Each has its own palette and a soft ground colour.
  - Each has an id and a localized name.
  - Draft list, to be drawn and reviewed: 水豚 capybara (accent), 黑熊 black bear, 熊猫 panda, 大象 elephant (grey), 狐狸 fox (orange), 猫头鹰 owl, 企鹅 penguin, 兔子 rabbit, 乌龟 turtle, 鲸 whale.
  - They live in `packages/design` as data plus a component, with no image files.
  - The design spec §3 gains a rule: agent avatars may use the animal palettes. Nothing else in
    the UI may.
  - The palettes enter `tokens.json` with contrast checked on both themes.
- **Upload**:
  - Formats: png, jpg or webp, at most 2 MB.
  - It is cropped to a square in the browser before upload.
  - It is stored through `StorageService`.
  - It is served through a kernel route that checks the reader can see the agent.
  - When no object store is configured (`storage.unavailable`), the upload control explains
    that and presets still work.
  - The 2 MB limit and the formats are my call.
- **The `Avatar` component** (design) takes the avatar, the name and a size. It draws the preset,
  the image or the initial. Sizes: 16, 22, 28, 40, 64. It is used in:
  - the new conversation page;
  - the agent picker;
  - the agent list rows;
  - the agent page head;
  - the conversation title bar;
  - the sidebar group titles.

### 2.4 Creating an agent (U3, U9)

- The create form asks for:
  - the avatar: a random preset is preselected, and a person can pick another or upload one;
  - the name, which is required;
  - the model, which defaults to the org default model.
  - Nothing else.
- On create, the prompt is one file `AGENTS.md` holding a short editable starter template
  (copy: builder's draft, reviewed in the PR). The person then lands on the agent page.
- `POST …/agents` accepts the profile with the definition. Agents created through the API
  without an avatar get a random preset, so the create rule holds everywhere (my call).
- The create form's visibility is `private` (my call, builder check B2). It is shown in the form
  so the creator sees it, and it is changed later in Basics.
- **The old `definition.avatarUrl`** (my call, builder check B5): it is versioned, unused by the
  web, and copied by the general-purpose sub-agent. The web stops writing it. An existing
  non-null value is migrated once into the profile as an upload-like external image. Builder's
  choice: copy it into the object store, or keep it as an https reference that the avatar route
  proxies. The field stays in the schema, ignored, so old versions still parse.

## 3. Part 2: the agent page

### 3.1 Layout (my call: reuse the Settings template)

- The page uses the `SettingsPage` template: a sub-nav on the left and the section on the right.
- The head shows the avatar (40), the name, the description (one line) and "开始对话".
- The sub-nav lists the sections; the URL keeps the open section as `/agents/<id>?s=<section>`,
  my call.

### 3.2 Sections, each with its own save (U7)

| Section | Holds | Saved as |
|---|---|---|
| 基本信息 Basics | avatar (change, upload), name, description, visibility and members | name: a new agent version (name is in the definition); avatar, description: profile; visibility and members: as today (the agent row) |
| 快捷操作 Quick actions | up to 9 title + body entries; add, edit, delete, reorder | profile |
| 提示词 Prompt | named `.md` files (§3.3) | a new agent version |
| 模型 Model | model, parameters, fallback | a new agent version |
| 工具 Tools | as today | a new agent version |
| 技能 Skills | as today | a new agent version |
| 子 Agent Sub-agents | as today | a new agent version |
| 渠道 Channels | as today | as today (channel bindings) |

- **Visibility** (my call, builder check B2) lives in Basics, as today. Rules in other sections
  that depend on it (`skills.writePolicy` applies only to private agents, sub-agent
  `dispatchable` rules) read the **saved** visibility, never Basics' draft. A section whose saved
  data a visibility change makes invalid shows the kernel's warning after the Basics save. The
  kernel stays the judge; nothing new is validated in the web.
- **Concurrency** (my call, builder check B4): definition sections send `expectedVersion`, as
  today. Profile saves send the profile's `updatedAt` as `expectedUpdatedAt`. A mismatch is a 409
  with a reload option, so two tabs never silently overwrite each other's quick actions.
- **People who can use but not edit the agent** (my call, builder check B3) see the same section
  nav, read-only, with only these sections:
  - Basics, without the upload and edit controls;
  - Quick actions;
  - Model.
  - The prompt files, tools, skills, sub-agents and channels stay hidden from them, as today's
    read-only view hides the instructions.
- **The head's actions**: "开始对话" for everyone. The owner and admins also get "运行记录" and
  "重新指派负责人", which move into the head's action slot.
- Each section has its own action row (Save, Discard) and its own unsaved state.
- Leaving a section with unsaved changes asks to keep or discard them (my call).
- Saving one section never sends another's draft.
- A save that conflicts with a newer version (another tab or person) is refused, with a reload
  option. If the kernel has no version check on save today, add one: `expectedVersion`, 409.
  My call; the builder confirms what exists.

### 3.3 The prompt files (U8)

- **Shape (my call, builder check B1)**: the definition gains `instructionFiles: { name, content }[]` as
  the authoring form, and the kernel derives `instructions` from it on save (the join below), storing
  both in the version. Everything that reads `instructions` today keeps reading it unchanged:
  `build.ts`, the general-purpose sub-agent copy and its frozen `subagent_started.definition`, an org
  agent dispatched as a sub-agent, eval candidates' `instructions` override (API and wizard),
  `reconstruct.ts` drift comparisons. So no log event changes shape and replay is untouched. A
  definition without `instructionFiles` (every old version) reads as one file `AGENTS.md` holding its
  `instructions`. Saving `instructionFiles` and an `instructions` that disagrees is refused.
- Names are unique and end in `.md`; the default and first file is `AGENTS.md`.
- Up to 20 files, with a total of at most 100 000 characters (today's `instructions` limit).
- Files can be added, renamed, deleted and reordered. At least one file must stay.
- **Model-visible**: the derived `instructions` is the files joined in order. The exact join is
  the builder's to propose and pin in tests, for example each file's content under a `# <name>`
  line with blank lines between. A single `AGENTS.md` file joins to exactly its content, so an
  old agent that is edited without adding files sends the model the same text as before.
- Because `instructions` stays the model-visible field and is versioned as before, the replay
  rules (`.agents/skills/replay-evals`) need no new `DriftReason`. The zero-drift fixture tests
  still run before and after the change.
- The sub-agent inline templates keep their single `instructions` (out of scope).

## 4. Part 3: the new conversation page (U1, U10)

### 4.1 Greeting

- The greeting is the pixel capybara plus one line, picked at random from the current
  time-of-day set by browser local time. It is typed on first paint and shown whole under
  reduced motion. Below it is a line in `muted`: "选一个 agent，或从常用任务开始" / "Pick an
  agent, or start from a common task".
- Copy, accepted (zh; en written to match):

| Hours | Lines |
|---|---|
| 5–11 | 早上好，{name} / 早，今天推进点什么？/ 新的一天，从哪件事开始？ |
| 11–13 | 中午好，{name} / 吃过了吗？有什么要交给我 |
| 13–18 | 下午好，{name} / 下午我们推进什么？/ 接着干？ |
| 18–23 | 晚上好，{name} / 今天收尾还差什么？ |
| 23–5 | 夜猫子，干点啥？/ 还没睡？我陪你 / 夜深了，挑件小事做 |

- The first paint is server-rendered. To avoid a hydration mismatch, pick the line on the
  client and render a stable placeholder of the same height on the server (my call; the
  builder may choose another way that keeps S1, no second frame).

### 4.2 Agents row (my calls on counts)

- The agents a person can start a conversation with, as `Avatar` (22) + name chips.
  - They are ordered by this person's most recent use, then by name.
  - At most 5 show, then "更多 +N".
  - The selected one is highlighted.
- With one agent in the org the row is hidden.
- "更多 +N" opens a panel:
  - a search field (name or description);
  - "最近用过" and "全部 N 个" groups of two-column rows with the avatar (28), the name and the
    description in one line;
  - keyboard navigable;
  - Escape closes it.
- Selecting an agent switches the composer to it and shows its quick actions. The composer no
  longer shows an agent picker on this page; the model and effort pickers stay.

### 4.3 Quick actions (U5, quiet)

- Below the agents row is one line of the selected agent's quick-action titles as `muted`
  `small` text links, with no border, darkening on hover and focus.
- The first 4 show, then a quiet "更多" opens the rest in a small menu.
- Clicking one puts its body into the composer and focuses the composer. If the composer
  already has text, the body replaces it after a confirm-free undo: the previous text is
  restored by Ctrl/⌘+Z. My call; the builder may choose append instead if undo is costly.
- With no quick actions the line is hidden.

## 5. Part 4: the background section (U11)

- The properties panel's "后台" section lists, newest first:
  - the agent's **background Bash tasks**: the command's description, elapsed time, status,
    stop, and open output;
  - its **sub-agents**, as today: description, elapsed time, stop, open;
  - each sub-agent's own background Bash tasks, indented under it.
  - "N 个已完成 ›" keeps today's behaviour, opening the finished ones.
- The section shows when any of these exist.
- **Depends on work in progress elsewhere** (user, 2026-11-04): another machine is renaming the
  builtin tools to Claude Code's names (`Bash`, `Read`, …) and adding a background mode for `Bash`
  (start in background, read output, stop). Part 4 starts once that work is merged into this
  branch, and uses its task model and names. Until then the section stays as today, sub-agents
  only. Parts 1–3 do not depend on it.

## 6. Non-goals

- Knowledge bases, scheduled tasks, roles or titles.
- Agent self-management tools (U12): only kept possible.
- Changing sub-agent templates' instructions.
- Avatars for anything other than agents.

## 7. Open

- Part 4's details are settled against the tool-rename work once it lands: a background Bash
  task's row content, its output view, and how a sub-agent's tasks are read. Nothing else is
  open.
