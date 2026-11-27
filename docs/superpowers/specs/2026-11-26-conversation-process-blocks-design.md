# Conversation process blocks design: one process per answer, cards by who must act, channel progress

Status: approved by the maintainer (2026-11-26); decisions in §10. Mockup:
[2026-11-26-conversation-process-blocks-mockup.html](2026-11-26-conversation-process-blocks-mockup.html)
(open locally; switches for variant, run state and theme; the "飞书适配" variant shows channels).

## Intent

A run today reads as a stack of equal-weight lines: "思考了 4 秒", "已使用 5 个工具", a narration
paragraph, "思考了 2 秒", another group, and so on. Three things cause it:

1. **No visual hierarchy.** Tool lines are 12–13 px mono with the tool name in `ink` 700; the
   answer is 15 px prose in `ink`. The weights are too close, so process and answer read alike.
2. **No kind signal.** A shell command, a skill, a memory write and a connector call look the
   same; the only cue is the name.
3. **Fragmentation.** Groups end at prose (§6.16.8), so every narration paragraph the model writes
   between tool calls ("先读一下说明，再逐页识别。") cuts the process into another group, and
   narration is drawn as prose, at the same level as the final answer.

Channels have the same problem in a worse form: the outbound delivery sends every step's text as
its own message (`finalize` in `packages/kernel/src/channels/outbound.ts`), so narration becomes
a burst of notifying IM messages, while the work in between (thinking, tools, todos) is invisible.

## Goals

1. **One process block per answer.** In a run, everything before the answer (thinking, tool calls,
   narration) is one block; outside it are only the things a person must see: blocking cards,
   pending actions, deliverables and the answer.
2. **Icons by kind** on every process line, monochrome, colour only for status.
3. **A clear hierarchy**: the answer at full weight, the process one clear step lighter.
4. **Cards as their own layer**, routed by one rule (does it wait for a person, must a person see
   it) instead of per-card special cases; todos pinned and always current.
5. **Channels**: one progress card per run, edited in place; narration never sent as messages;
   notifications only for what needs a person.

## Non-goals

- No change to the event log, replay or the history sent to the model: this is display only (no
  `DriftReason`, zero-drift fixtures untouched).
- No change to how approvals, questions and connects are decided or to their cards' content.
- Sub-agent groups keep their own block (§6.16.15); the agent map is unchanged.
- No per-kind colours, no brand icons in core (an extension's own icon is used where it has one).

## 1. The process block

### 1.1 What goes in

A process block holds, in log order, the thinking rows, tool calls and **narration** of one stretch
of a run that ends in an answer. Narration is decided from the log, with no lookahead and no model
cooperation:

- **Narration**: the text of an `assistant_message` whose content also has a `tool_call` block.
- **Answer**: the text of an `assistant_message` with no `tool_call` block (the run's last step,
  or a step after which the run waits for the person).

The same rule is used by the web timeline and the channel delivery, so both agree on every log.

While a step streams, its text is drawn as prose; when the step's first tool call arrives the text
moves into the block (a `motion.expand` collapse; an instant move under reduced motion).

### 1.2 What ends a block

A block ends at: an answer, a user message (including a queued message delivered mid-run), a
sub-agent group, the end of the run (finished, stopped, failed). Mid-run events that are dividers
today, a model fallback (`model_switched`) and a compaction, become rail rows instead of
dividers when they fall inside a block. Blocking cards (§3) do **not** end a block: they are drawn
after it, and the block continues when the run resumes.

The parallel calls of one model step are one rail step (a burst), not one row per call.

This replaces §6.16.8's "groups end at prose": the tool group survives as the unit inside a block
only where it is still useful (a burst of parallel calls).

### 1.3 Anatomy

- **Head** (one tool line, `row.dense`, never wraps, ellipsis before the status words):
  - Running: `spinner` (accent) + "正在运行 · <current step label>" / "Running · <label>" (a
    command by its description when it has one, never the raw command line; several commands
    running side by side: "<first description> 等 n 个命令" / "<first> and n−1 more commands";
    while the planning row stands, no label: "正在运行" / "Running") + the
    elapsed time at the end (`faint`, tabular): the run's working time from its `run_started`
    (waits for a person left out, as the status bar and the finished head count it), on the run's
    latest block only.
  - Waiting for a person: `hand` in `accent` + "等待你批准" (or the existing waiting words,
    `waitingFor` aware: "等待 张三 批准") + the step label.
  - Finished: up to six **kind chips** (20 px circles, `panel` ground, `line-soft` border, 11 px
    icon, overlapping by 5 px, in first-use order) + "已处理 2 分 43 秒 · 待办 4/4 · 思考 4 次 ·
    12 个工具" / "Worked for 2m 43s · Todos 4/4 · Thought 4 times · 12 tools" (the pinned card's title
    and `UiView.badge`, when the run has a pinned card; this todo count is for the web head only,
    the channel progress card's finished meta has none, §6.2) + the error dot and
    count (§2.4) + chevron. Per-kind counts are not in the head (too long for compact); the chips
    carry the kinds.
  - Stopped / failed: the head keeps the summary and adds "已停止" / "Stopped" in `muted` or the
    failure word in `fail`; the block stays open on its last four steps.
- **Rail** (when open): one row per step, a 20 px gutter holding the step's icon on a 1 px `line`
  rule that runs from the first to the last icon; the line itself no longer repeats the icon.
  Narration rows have a 5 px `line-strong` dot in the gutter and their text in `prose-small`
  `muted`. Thinking and tool rows expand in place exactly as today (thinking text, IN / OUT, diff).
- **Spinners** (maintainer decision 2026-11-27): only in two places: (a) the head while the run
  is live; (b) each of several concurrent sibling items (each running command of a parallel
  group), to tell running from done. A rail node always shows the step's kind icon (lightbulb,
  terminal, file, …) and never turns into a spinner; a single live step has no spinner of its
  own and states its status in words: "正在思考 · 6 秒" / "Thinking · 6s", a running tool line
  its label and its time. A parallel group's title is text only: "正在运行 2 个命令 · 已完成 0 个"
  / "Running 2 commands · 0 done", "已运行 2 个命令" once done; every running row shows its time
  from its start (a queued call from when it was logged). The one animated node is the planning
  row's capybara, below.
- **Planning row** (maintainer decision 2026-11-27): while the run is live and no step is (the
  model plans the next one), the rail's last row is the capybara (the working line's animation as
  the node icon) and its rotating caption; when a step starts, that row becomes the step in place
  (same height), and when the model plans again the row is appended at the tail again. There is
  no separate working line under the block: the block stands from the run's start (head and
  planning row; a message this view sent before its run is logged gets such a block after its
  bubble), and the row goes when the run ends, as the block collapses. It is the rail's last edge.
- **Thinking**: live, "正在思考 · N 秒" with the text's last three lines (rendered Markdown,
  `prose-small` `muted`, the top line fading); ended, "思考了 N 秒" collapsed, opening the whole
  text as rendered Markdown. Narration is rendered Markdown at the same compact style.
- **Command rows**: "Bash <description>" only; the command and the exit code are in the
  expanded detail; a non-zero exit code is named on the row in `fail`.
- **Default state**: open while running or waiting; collapsed when the run finishes. While
  running, the rail shows only the last four steps; earlier ones fold into a "前 N 步" /
  "N earlier steps" row that opens them.
- **Long runs**: the rail is windowed (only the rows near the viewport are mounted; spacers keep
  its height and rule; #925), with no paging. With a task list in play (a pinned card whose `text`
  is a Markdown task list) the rail is sectioned under the item that was current when each step
  ran (the first unchecked item of the latest list before the step); a section header per item,
  closed once the run's latest list has the item done (#924).
- Earlier blocks of a run that a queued message split show "已处理" / "Worked" without a time; the
  working time sits on the run's last block.
- The head's pinned summary (the pinned card's title and badge): the title is the card
  contribution's, the badge its view's from the view cache when the card has been drawn, else the
  badge the tool recorded on its result (`ToolResult.card.badge`, pinned only), so a finished head
  shows it after a reload without reading every old card (Execution ruling 11, amended).

## 2. Icons

By kind (`ToolKind` plus the non-tool rows), lucide, 14 px on lines, 11 px in chips:

| Row | Icon | In the set |
|---|---|---|
| Thinking | `lightbulb` | new |
| Command (`Bash`, background tasks) | `terminal` | new |
| Read | `file-text` | yes |
| Edit / Write | `square-pen` | yes |
| Search (Grep, Glob, tool search) | `search` | yes |
| Web (WebSearch, WebFetch) | `globe` | yes |
| Skill | `skills` | yes |
| Connector tool | the connector's icon, else `connector` | yes |
| Extension tool | the extension's icon, else `extension` | yes |
| Memory (the memory plugin's tools) | the plugin's icon (an extension tool) | — |
| Todo (pinned card rows), `TaskList` | `list-checks` | yes |
| Sub-agent | `agent` | yes |
| Model fallback / compaction (rail rows) | `refresh` / `archive` | yes |

Icons are `faint`; a live or waiting row keeps its kind icon (§1.3 Spinners: the head spins, a
live row says its state in words; superseded 2026-11-27: a live row's icon used to become the
`spinner` and a waiting one the `hand`). The error dot (§2.4) stays the only failure mark. The two new icons go
through `gen:icons` from `lucide-static`. The kernel's tool info gives the web each tool's icon
(`ToolInfo.icon`, §8): a builtin by key and kind, an extension tool its catalog item's icon when it
has one.

## 3. Hierarchy

| Tier | Type | Colour |
|---|---|---|
| Answer | `prose` 15/26, prose font | `ink` |
| Process line | `small` 12/16, mono | name 600 `muted` (was `ink` 700), arguments and notes `faint` |
| Process text (thinking, narration) | `prose-small` 13/20, prose font | `muted` |
| Icons | 14 px | `faint`; status colours only |

Spacing carries the rest: process rows sit `space.1` apart; a block sits `space.5` from the
answer and from cards. No frame around the block (one box rule: the only boxes are the expanded
tool box and the cards).

## 4. Cards: a separate layer

The timeline decides a card's place by what the person has to do with it, not by which call made
it. Four classes:

| Class | Members | Place |
|---|---|---|
| **Blocking** | approval, question, connect, device code, secure input, person fields | Outside the block, right after it. The block head turns to the waiting words in `accent`. Once decided, the card shrinks into a rail row ("已允许 · 你" / "Allowed · you") |
| **Must see, non-blocking** | handoff link cards, reveals (initial password, invitation link), delivered files, edit summaries ("变更 3 个文件 +40 −12") | Lifted out of the block **as soon as they appear** (also while running). Merged by class: all handoffs and reveals of a turn in one pending entry, all handoffs of a turn in one list card ("2 项需要你处理 · 不阻塞，我已继续" / "2 things need you · not blocking, I carried on"), files in one grid. The originating call keeps its rail row |
| **State** | todo (and any card declared pinned, §5) | Pinned under the block head, latest version only, updated in place; earlier versions are just rail rows. When the run finishes it folds into the head (its title and badge, "待办 4/4"); when the run stops or fails, the card stays outside the block (the kernel cannot tell whether items are left, the card shows it) |
| **Process** | network facts, diffs, command output | Stay in the rail under their call |

A pinned card is a list: the latest card per (extension, view), drawn together under the head.
When the run stops or fails, the pinned cards stand outside the block. A device-code card folds
into the rail once its call ended (the code was used or expired), a sub-agent wait once it ended
(a later wait replaced it, or the child no longer waits; a connection once the child ended), each
as a one-line rail row; until then they stay outside (#926).

Order outside the block is fixed: block → blocking cards → pending actions → files and edits →
answer.

## 5. Extension cards: `ToolResult.card.placement`

Extension cards (`ToolResult.card`, §6.16.16) get a declared place:

```ts
card?: {
  view: string;
  key?: string;
  placement?: "output" | "pinned" | "process";
  /** Pinned only: the card as Markdown (at most 2000 characters), for channels. */
  text?: string;
  /** Pinned only: the card's state (its view's badge, at most 32 characters), for the head. */
  badge?: string;
};
```

- `output` (default): the must-see class, lifted after the block.
- `pinned`: the state class. For one extension and view, only the latest card of the run is drawn
  (pinned under the head; several views give several pinned cards); older ones become rail rows.
  After a stopped or failed run the pinned cards stand outside the block. `text` is what channels show for it (§6.2): the kernel never renders
  an extension view server side. The todo plugin uses both (its checklist as Markdown).
- `process`: stays in the rail under its call.

This is a public SDK change: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`;
the todo plugin (capybara-hq/plugins) sets `placement: "pinned"` in the same release.

## 6. Channels

### 6.1 Today

Measured on the scenario in the mockup (12-page invoice batch, 18 steps):

- 7 messages, each notifying: 2 narrations, 2 handoff cards, the answer, 2 files.
- Nothing between the narrations shows that work is going on.
- The todo list never reaches the channel (only `handoff` tool results are delivered).

### 6.2 Design

| Content | Channels with `features.edit` | Channels without |
|---|---|---|
| Process (thinking, tools, narration, todo) | **One progress card per run**: sent once (notifies), then edited in place at the streaming draft's interval, immediately on a state change (a todo item done, a wait for a person). Body: status and elapsed time, the status line (the latest narration, §10.1), the pinned card's
`text`, the last three steps as text lines, pending actions as links, "在网页查看完整过程" / "See the full process on the web". On finish it is edited down to one summary line with the same link (its meta has no todo count: the kernel cannot read a pinned card's counts, so it shows the time and the tool count) | No progress card. One "已开始处理" / "Working on it" message at the start, then one milestone message (the pinned card's `text`) each time a pinned card changes, at most one
a minute |
| Blocking cards | New messages (they must notify), as today | Same |
| Handoffs, reveals | Listed in the progress card while running; after the answer, one merged "需要你处理（N）" card | One merged card after the answer |
| Files | Native file messages after the answer, as today | Same |
| Answer | A new message (edits do not notify) | Same |

Narration is never sent as its own message when a progress card is in use (rule §1.1). Thinking is never sent (unchanged).
With a progress card (`detailed` or `brief` on an edit channel) the streaming draft is not used: a
step's streamed text shows as the card's status line, and the answer is sent whole when its step
ends, as one notifying message. The card's elapsed time is refreshed only when its content changes, not on a timer. With `off`
nothing changes from today's delivery: the streaming draft and the narration messages stay (the
escape hatch).
Without card support (`cards: false`) every card falls back through `renderCardAsText` as today.
Channel cards use no icons: text only, colour only on the head status strip.

A per-connection setting **过程显示 / Process** (`detailed` | `brief` | `off`; default `detailed`
in direct chats, `brief` in group chats): `brief` sends only the finished summary line, pending
actions and the answer; `off` sends no progress card and keeps today's delivery exactly. In the web, the Default option
of the setting saves NULL (direct chats detailed, group chats brief).

### 6.3 Contract and data

- `ChannelCard` gains `{ kind: "progress"; … }` (status, elapsed, todo items, recent steps,
  pending links, web link, finished summary). A plugin that renders it natively declares
  `features.progress`; any other channel gets its `renderCardAsText` Markdown as a text message,
  edited in place the same way (Execution ruling 12). Public SDK change (same changeset as §5).
- The progress card is a second editable message per run besides the streaming draft:
  `channel_deliveries` records its message id and run (one expand-only migration; the table's RLS
  policy already covers new columns). Edits use the existing idempotency keys; an edit the
  platform rejects (message too old) falls back to a new message, as the draft does.
- All state lives in PG, read by whichever replica holds the delivery lease; no in-process timers
  beyond the delivery job's existing draft throttle.

## 7. Other cases

- **Interrupts**: a queued message delivered mid-run ends the block at the user bubble; the run's
  next steps start a new block.
- **Background tasks** still running when the turn ends: the head adds "1 个后台任务仍在运行" /
  "1 background task still running"; its completion is announced in the right panel's background
  tasks, never by reopening a finished block.
- **Unattended runs** (scheduled tasks, channel-started conversations opened later on the web):
  same default (collapsed, outputs first).
- **Copy and share**: copying an answer never includes the process; a shared snapshot shows blocks
  collapsed.
- **Accessibility**: the head is the live region, announcing step changes at most every few
  seconds, never per row; the block opens from the keyboard; chips have accessible names (kind).
- **Replay and reconnects**: blocks are derived from the log, so old conversations, reconnects and
  the trajectory viewer render the same way.
- **Compact / touch**: the head stays one line, `touch.hit` high; the rail keeps its 20 px gutter.

## 8. Implementation outline

1. **Design package**: `ProcessBlock` (head, chips, rail, fold row), icons, the lighter tool line
   tier, `PendingActions` (merged handoffs), pinned card frame; reference pages and size tables in
   the design spec (§6.16.5, §6.16.8, §6.16.9 updated, a new §6.16.x Process block).
2. **Web timeline** (`apps/web/src/lib/timeline.ts`): narration rule, block grouping, the card
   classes and their order, pinned cards; `ConversationPage` draws the new entries.
3. **SDK**: `ToolResult.card.placement`, `ChannelCard` `progress`; API report and changeset.
4. **Kernel channels**: narration suppression, the progress card lifecycle, the migration, the
   connection setting; fake-im tests and a dual-replica test for the progress message.
5. **Plugins** (capybara-hq/plugins): the todo plugin's `placement: "pinned"`; channel plugins
   render `progress` (lark, slack, telegram).

Steps 1–2 ship alone; 3–5 follow together.

## 9. Testing

- Timeline unit tests: narration vs answer on mixed steps, block boundaries (queued message,
  sub-agents, run end), card classes and order, pinned latest-only, old logs.
- Design: visual baselines for the block (running, waiting, finished, stopped, compact) through
  `visual-update`; the jsdom box guard on the block.
- Channels: fake-im tests for detailed / brief / off, edit and no-edit channels, rejected edits,
  notifications only on new messages; a container dual-replica test for the progress message id.

## 10. Decisions (maintainer, 2026-11-26)

1. Narration in the channel progress card: the latest narration is the card's status line (one
   line, cut with "…"), under the head; earlier narration is not shown.
2. Group chat default: `brief`.
3. A single synchronous sub-agent (one `Agent` call in a step, not `run_in_background`) is a rail
   row with its own summary ("子智能体 · <description> · N 个工具"), opening the agent panel;
   two or more in one step, or a background one, keep the sub-agent group and end the block.
4. No-edit channels: one milestone message each time the pinned card (the todo list) changes, at
   most one a minute (the todo plugin writes the list when an item completes).

### Execution rulings (2026-11-26)

1. The rail pages 200 steps at a time (a fold row adds 200 more) instead of virtualization (§1.3).
   Superseded by #925: the rail is windowed.
2. Sectioning the rail by todo item (§1.3) is a follow-up, not implemented. Done in #924.
3. The parallel calls of one model step are one rail step (§1.2).
4. `ProcessEntry.pinned` is a list: the latest card per (extension, view); pinned cards of a
   stopped or failed run stand outside (§4, §5).
5. Handoffs and reveals merge into one pending entry per turn (§4); device-code and sub-agent-wait
   entries stay outside after completion. Superseded by #926: they fold into the rail once over.
6. The channel progress card's finished meta has no todo count, since the kernel cannot read a
   pinned card's counts (§1.3 keeps it for the web head; §6.2 for channels).
7. `process_display: off` keeps today's delivery exactly (streaming draft and narration messages)
   as the escape hatch; narration is never sent "with a progress card" (§6.2).
8. The progress card's elapsed time refreshes only when its content changes (§6.2).
9. Earlier blocks of a run split by a queued message show 已处理 without a time (§1.3).
10. Web: the Default option of the process setting saves NULL (direct chats detailed, group chats
    brief).
11. The pinned head summary (title + badge) uses the view cache only; after a reload a finished
    head may omit it (§1.3). Amended (#928): the tool also records the badge on its result
    (`card.badge`, pinned only, at most 32 characters), which the head uses when the view is not
    in the cache.
12. Channels: the native `progress` card goes only to a plugin that declares `features.progress`
    and `cards` (released lark, slack and telegram have no `progress` branch, so the card would
    fail their delivery); every other channel gets the same card as `renderCardAsText` text, sent once and
    edited in place like the card (§6.3).
13. A run that finishes with no non-empty answer after its last narration promotes that narration
    to its answer: channels send it as the answer message at `run_finished` (progress modes; `off`
    already sends narration); the web draws it as answer prose after the block, and it stays a
    narration step in the block too.
14. A channel without edits honours the display setting: `brief` sends no start message and no
    milestones (only the answer, blocking cards and the merged handoffs); `detailed` also sends a
    trailing milestone at run end when the pinned text differs from the last milestone sent. On
    the promoted-answer path (ruling 13) that trailing milestone precedes the answer; on the
    normal path, where the answer went out at its step, it follows the answer.
    A retryable failure of the previous run's final card edit, retried once when the next run's
    card starts (`startProgress`), is dropped if it fails again (accepted).
15. Release order: the todo plugin's `placement: "pinned"` ships in the same release as core;
    otherwise todo cards stack as output cards.
16. A connect card folds into the rail only once its run ended: its call goes on without waiting
    (the result says the connector is not connected), so "decided" by the call would hide a card
    that still offers Connect inside a block that collapses at the answer (§4).

## AGENTS.md rules touched

- **Web UI**: no rule changes; the design spec's §6.16.8 rule "groups end at prose" is replaced by
  §1.2 here (maintainer decision needed).
- **Runtime and replay**: none; display only, no new model-visible input.
- **Channels**: "ack only after `onEvent` resolves" and the gateway role are untouched; the
  outbound side gains the progress card (§6.3).
- **Public API reports**: `ToolResult.card.placement` and `ChannelCard` `progress` need
  `pnpm gen:sdk-api` and a changeset for `@capybara-hq/plugin-sdk`.
- **Migrations**: one expand-only column set on `channel_deliveries`.
- **Multi-replica discipline**: the progress message id lives in PG; no new timers.
