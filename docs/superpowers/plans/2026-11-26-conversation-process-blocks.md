# Conversation Process Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task, layered with
> `wave-planned-subagent-development`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A run reads as one process block before its answer (icons by kind, a lighter tier),
cards are routed by who must act, todos are pinned, and channels get one edited progress card per
run instead of a message per narration.

**Architecture:** The web keeps `buildTimeline` as the event reducer and adds a pure post-pass,
`groupProcess`, that folds process entries into `process` entries and lifts cards by class; the
design package draws it with `ProcessBlock` / `RailStep` / `PendingActions`. The SDK adds
`ToolResult.card.placement` / `text` and a `progress` `ChannelCard`; the kernel records the new card
fields, gives tool info an icon, and its channel delivery replaces narration messages and the
streaming draft with a progress card rebuilt from the run's events.

**Tech Stack:** TypeScript, NestJS + Fastify kernel, Kysely/PG, Next.js web, `@capybara-hq/design`,
next-intl, vitest, lucide-static.

**Spec:** `docs/superpowers/specs/2026-11-26-conversation-process-blocks-design.md` (decisions in
§10). Mockup next to it. Skills to read first: `writing-web-ui` (Tasks 1, 4, 6, 7, 8),
`writing-extension-ui` (Tasks 2, 5, 7), `writing-channels` (Tasks 2, 8–10), `writing-kernel-api`
(Tasks 3, 8), `writing-migrations` (Task 8), `replay-evals` (Task 6: confirm no request-building
file is touched).

## Global Constraints

- Display only: no change to `runtime/context/*`, the event log format, replay or model-visible
  text; zero-drift fixture tests stay green untouched.
- Narration rule (spec §1.1): the text of an `assistant_message` whose content has a `tool_call`
  block is narration; without one it is an answer. Same rule in web and channels.
- Copy: zh and en in every string; the zh UI says 智能体 and 平台, never `agent`; the todo is
  「待办」 / "Todos", never 任务.
- New icons: `lightbulb`, `terminal` only (via `pnpm --filter @capybara-hq/design gen:icons`).
- Hierarchy values (spec §3): tool name `muted` 600 (was `ink` 700), arguments `faint`; thinking and
  narration `prose-small` `muted`; rail gutter 20 px, rule 1 px `line`; chips 20 px, 11 px icon,
  −5 px overlap, max 6; block ↔ answer / cards `space.5`; rows `space.1`.
- Running block shows the last 4 steps; rail virtualized past 200 rows.
- `card.text`: pinned only, at most 2000 characters; `card.placement` default `output`.
- Channel process setting `process_display`: `detailed` | `brief` | `off`; NULL = `detailed` in
  `dm`, `brief` in `group`. No-edit milestones at most one a minute.
- Pages never style (`check:web-ui`); a new component or template goes through the design package
  with a reference page and a size table in `docs/design/spec.md`.
- Public SDK change: `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`;
  migration number: the next free one at execution time (0185 today).
- New unit / container tests join `packages/kernel/test/unit-tests.json` /
  `container-tests.json` in the same change.

## Review Focus

1. **A step that streams text and then a tool call**: the prose moves into the block without the
   page jumping twice, and a reload mid-step renders the same thing (Task 6 test
   `streamed narration moves into the open block`).
2. **A run that stops while waiting for approval**: the block shows 已停止, the approval card shows
   its final state outside, the pinned card stays out (Task 6 test `stopped while waiting`).
3. **A delivery job that moves to another replica mid-run**: the new holder edits the same progress
   message, never posts a second one (Task 10 dual-replica test).
4. **An edit the platform rejects** (message too old): one new progress message, then edits go to
   it (Task 10 test `rejected edit re-posts once`).
5. **Old conversations** (cards without `placement`, logs before this change): render as `output`
   cards and the same blocks (Task 6 test `log without placement`).

## Waves and PRs

| Wave | Tasks (disjoint files) | PR |
|---|---|---|
| A | 1 design icons + tier, 2 SDK, 3 kernel tool icon | PR 1 (core) |
| B | 4 ProcessBlock, 5 kernel card fields, 6 web grouping | PR 1 |
| C | 7 web Thread | PR 1 |
| D | 8 channel setting + migration, 9 progress reducer | PR 2 (core) |
| E | 10 outbound integration, 11 docs and skills | PR 2 |
| F | 12 plugins (todo, lark, slack, telegram) after the SDK rc is published | plugins PR |

Task 10 (multi-replica, notifications) is reviewed alone on the most capable model.

---

### Task 1: Icons and the lighter process tier

**Files:**
- Modify: `packages/design/scripts/gen-icons.mjs` (ICONS: `lightbulb`, `terminal`), regenerate
  `packages/design/src/icons/paths.ts`
- Modify: `packages/design/src/styles/conversation.css` (`.cb-tool-name`, key-arg, thinking body)
- Modify: `packages/design/src/conversation/thinking.tsx` (prop `inRail`)
- Modify: `docs/design/spec.md` §6.16.5, §6.16.9 size tables
- Test: `packages/design/test/tool-group.test.tsx`, `packages/design/test/thinking-row.test.tsx` (new)

**Interfaces:**
- Produces: icon names `lightbulb`, `terminal`; `ThinkingRowProps.inRail?: boolean` (no left rule,
  body `prose-small`).

- [ ] **Step 1: Failing tests**: `tool name is muted 600` (computed style of `[data-part="tool-name"]`
  through the size-table helper the existing test uses: color `color.muted`, weight 600);
  `thinking in rail has no rule` (`inRail` → `.cb-thinking-body` border-left `0`, font-size
  `type.prose-small`).
- [ ] **Step 2:** `pnpm exec vitest run packages/design/test/tool-group.test.tsx packages/design/test/thinking-row.test.tsx` → FAIL.
- [ ] **Step 3:** Add the icons, run `gen:icons`; CSS per Global Constraints; `inRail` sets
  `data-in-rail="true"`, styled in CSS; update the two size tables (`tool-name` color
  `color.muted`, weight 600; new state `in-rail` for `thinking-row`).
- [ ] **Step 4:** Tests PASS; `pnpm check` PASS (size tables vs CSS).
- [ ] **Step 5:** Commit `feat(design): lighter process tier and lightbulb, terminal icons`.

### Task 2: SDK: card placement and text, progress channel card

**Files:**
- Modify: `packages/plugin-sdk/src/tool.ts:153` (`ToolResult.card`)
- Modify: `packages/plugin-sdk/src/cards.ts` (`ChannelCard`, `renderCardAsText`)
- Generate: SDK API report (`pnpm gen:sdk-api`); add `.changeset/*.md` (plugin-sdk, minor in pre)
- Test: `packages/plugin-sdk/test/cards.test.ts`

**Interfaces:**
- Produces:
  ```ts
  card?: { view: string; key?: string; placement?: "output" | "pinned" | "process"; text?: string };
  export const CARD_TEXT_MAX = 2000;
  | {
      kind: "progress";
      state: "running" | "waiting" | "finished" | "stopped" | "failed";
      title: string;          // "正在处理" / "等待你批准" / "已处理 2 分 43 秒" (kernel-localized)
      meta?: string;          // "已用 0:42" / "待办 4/4 · 12 个工具 · 1 个调用出错"
      status?: string;        // latest narration, one line
      pinned?: string;        // the pinned card's Markdown text
      steps: string[];        // at most 3, oldest first
      pending: { text: string; url: string }[];
      url: string;            // the run on the web
      urlText: string;        // "在网页查看完整过程"
    }
  ```
- [ ] **Step 1: Failing tests**: `renders a running progress card as text` (title line, status,
  pinned verbatim, steps as `- ` lines, pending as Markdown links, the url line); `finished card is
  one line plus the link` (no steps, no pending).
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/cards.test.ts` → FAIL.
- [ ] **Step 3:** Types, `renderCardAsText` branch (model-controlled fields inside code spans, as
  the other kinds do; `status` and `pinned` are kernel / extension text, not model text, rendered
  as is); TSDoc on `placement` and `text` quoting spec §5.
- [ ] **Step 4:** Tests PASS; `pnpm gen:sdk-api`; `pnpm check:sdk-api` PASS.
- [ ] **Step 5:** Commit `feat(sdk): card placement and text, progress channel card` with the changeset.

### Task 3: Kernel: tool icon in tool info

**Files:**
- Modify: `packages/kernel/src/tools/info.ts` (`ToolInfo.icon`)
- Modify: `apps/web/src/lib/conversations.ts:1236` (mirror type)
- Test: `packages/kernel/test/tools/info.test.ts` (existing or new unit test, listed in `unit-tests.json`)

**Interfaces:**
- Produces:
  ```ts
  export type ToolIcon =
    | { kind: "name"; name: "terminal" | "file-text" | "square-pen" | "search" | "globe" | "skills"
        | "agent" | "list-checks" | "connector" | "extension" }
    | { kind: "catalog"; itemId: string };   // web: `${org}/catalog/${itemId}/icon`
  ToolInfo.icon: ToolIcon
  ```
  Builtins by key first (`WebSearch`, `WebFetch` → `globe`; `Skill` → `skills`; `Agent` → `agent`;
  `TaskList`, `TaskOutput` → `list-checks`), then by kind (`command` → `terminal`, `read` →
  `file-text`, `edit` → `square-pen`, `search` → `search`, else `extension`); connector →
  `connector`; extension → its org catalog item when that item has an icon, else `extension`.
- [ ] **Step 1: Failing tests**: one assertion per mapping row above; an extension whose catalog
  item has an icon gets `{ kind: "catalog", itemId }`.
- [ ] **Step 2:** run the test → FAIL.
- [ ] **Step 3:** Implement in `info.ts` (catalog lookup in the same query batch as the display
  name). The `/tools` route's response schema changes: run `platform-parity.test.ts`.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5:** Commit `feat(kernel): tool info carries the tool's icon`.

### Task 4: Design: ProcessBlock, RailStep, PendingActions

**Files:**
- Create: `packages/design/src/conversation/process-block.tsx`, export from `conversation/index.ts`
- Modify: `packages/design/src/styles/conversation.css`, `packages/design/src/i18n.ts` (zh, en)
- Create: `docs/design/reference/src/process-block.html`; modify `docs/design/spec.md` (new
  §6.16.8a Process block with states and size table; §6.16.8 "groups end at prose" replaced by the
  spec's §1.2)
- Test: `packages/design/test/process-block.test.tsx`

**Interfaces:**
- Consumes: Task 1 icons, `ThinkingRow inRail`.
- Produces:
  ```ts
  export type ProcessIcon = { name: IconName } | { src: string };
  export type ProcessBlockProps = {
    state: "running" | "waiting" | "finished" | "stopped" | "failed";
    current?: ReactNode;                 // running / waiting: the current step's label
    waiting?: ReactNode;                 // the existing WaitingWord for the waiting step
    elapsedMs: number | null;
    summary: { thoughts: number; tools: number; errors: number;
               pinned?: { title: string; badge?: string } };
    kinds: { key: string; icon: ProcessIcon; label: string }[];   // first-use order, ≤ 6 drawn
    open: boolean; onToggle(): void;
    hiddenBefore?: number; onShowEarlier?(): void;                 // "前 N 步" fold row
    pinned?: ReactNode;                  // under the head
    backgroundRunning?: number;
    children: ReactNode;                 // RailStep elements
  };
  export function ProcessBlock(p: ProcessBlockProps): JSX.Element;
  export function RailStep(p: { icon: ProcessIcon | "dot" | "spinner" | "hand"; children: ReactNode }): JSX.Element;
  export type PendingAction = { key: string; icon: ProcessIcon; title: string; description?: string;
                                action: { label: string; href: string } };
  export function PendingActions(p: { items: PendingAction[] }): JSX.Element;
  ```
  Copy keys: `process.running` 正在运行 / Running; `process.worked` 已处理 {time} / Worked for
  {time}; `process.thoughts` 思考 {n} 次 / Thought {n} times; `process.tools` {n} 个工具 /
  {n} tools; `process.earlier` 前 {n} 步 / {n} earlier steps; `process.stopped` 已停止 /
  Stopped; `process.background` {n} 个后台任务仍在运行 / {n} background tasks still running;
  `process.subagent` 子智能体 · {description} · {n} 个工具 / Sub-agent · {description} ·
  {n} tools; `pending.many` {n} 项需要你处理 · 不阻塞，我已继续 / {n} things need you · not
  blocking, I carried on.
- [ ] **Step 1: Failing tests**: `finished head` (chips ≤ 6 in order, text "已处理 2 分 43 秒 ·
  待办 4/4 · 思考 4 次 · 12 个工具", error dot with accessible name "1 个调用返回了错误", chevron,
  `aria-expanded`); `running head has no chevron and shows the elapsed time`; `waiting head shows
  the waiting words in accent`; `fold row opens earlier steps`; `rail rule spans first to last
  icon` (data attributes on first / last `RailStep`); `pending actions merge with the many-line only
  for two or more`; `head stays one line at compact` (touch test pattern from
  `touch-conversation.test.tsx`); `no box in box` (`findNestedBoxes` on a block with an open tool
  box and a pinned inline card).
- [ ] **Step 2:** `pnpm exec vitest run packages/design/test/process-block.test.tsx` → FAIL.
- [ ] **Step 3:** Implement; the head is the live region (`aria-live="polite"`, text updates only
  when the current step changes); duration via the existing `formatDuration`.
- [ ] **Step 4:** Tests PASS; `pnpm check` PASS; add the page to `/dev/ui` catalog
  (`apps/web/src/dev/catalog/conversation-page-blocks.tsx`).
- [ ] **Step 5:** Commit `feat(design): process block, rail steps and pending actions`.

### Task 5: Kernel: record card placement and text

**Files:**
- Modify: `packages/kernel/src/tools/pipeline.ts:460` (`ToolCard`), `:3917` (`cardOf`)
- Modify: `apps/web/src/lib/conversations.ts:371` (event type)
- Test: `packages/kernel/test/tools/inline-card.test.ts` (find the existing `cardOf` test with
  `grep -rn "not an inline view" packages/kernel/test`; extend it)

**Interfaces:**
- Consumes: Task 2 types, `CARD_TEXT_MAX`.
- Produces: `tool_result.payload.card: { plugin; view; key?; placement?; text? }`.
- [ ] **Step 1: Failing tests**: `keeps placement and text of a pinned card`; `drops text unless
  pinned` (card kept, text gone, warning logged); `drops an unknown placement` (card kept as
  `output`, warning); `text over 2000 characters is dropped` (card kept, warning).
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Validate in `cardOf`; omit `placement` when `output`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(kernel): inline cards keep placement and text`.

### Task 6: Web: narration flag and process grouping

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` (prose entry `narration`, card entry `placement`)
- Create: `apps/web/src/lib/process.ts`
- Test: `apps/web/test/timeline-process.test.ts`

**Interfaces:**
- Consumes: `TimelineEntry` from `timeline.ts`.
- Produces:
  ```ts
  // timeline.ts
  | { kind: "prose"; key: string; text: string; streaming: boolean; narration: boolean }
  | { kind: "card"; key: string; plugin: string; view: string; callId: string; cardKey?: string;
      placement: "output" | "pinned" | "process" }
  // process.ts
  export type ProcessStep =
    | Extract<TimelineEntry, { kind: "thinking" | "tools" | "network-facts" | "card" }>
    | { kind: "narration"; key: string; text: string; streaming: boolean }
    | { kind: "subagent"; key: string; row: TimelineSubagent }
    | { kind: "note"; key: string; note: "fallback" | "compacted"; divider: DividerData }
    | { kind: "decided"; key: string; entry: Extract<TimelineEntry, { kind: "approval" | "question" | "connect" }> };
  export type ProcessEntry = {
    kind: "process"; key: string; runId: string | null;
    state: "running" | "waiting" | "finished" | "stopped" | "failed";
    steps: ProcessStep[];
    pinned?: Extract<TimelineEntry, { kind: "card" }>;  // latest pinned card of the block's run
    durationMs: number | null; backgroundRunning: number;
  };
  export type PendingEntry = { kind: "pending"; key: string;
    items: Extract<TimelineEntry, { kind: "handoff" | "reveal" }>[] };
  export type ThreadEntry =
    | Exclude<TimelineEntry, { kind: "thinking" | "tools" | "network-facts" | "handoff" | "reveal" }>
    | ProcessEntry | PendingEntry;
  export function groupProcess(entries: readonly TimelineEntry[]): ThreadEntry[];
  ```
  Rules (spec §1–§4): a block opens at the first thinking / narration / tool / single synchronous
  sub-agent (a `subagents` entry with one row whose call is not background); it closes at an answer
  prose, a user entry, a multi-row or background `subagents` entry, or the run's `run` entry; a
  `divider` of kind `fallback` / `compacted` inside an open block becomes a `note` step; an
  undecided approval / question / connect / device-code stays outside right after the block (state
  `waiting`) and once decided becomes a `decided` step; handoffs and reveals of the turn merge into
  one `pending` entry after the blocking cards; `output` cards and `files` follow; `pinned` cards
  keep only the latest per (plugin, view) on the block, and after a `failed` / `stopped` run the
  pinned card is emitted outside instead; `process` cards stay as steps after their tools step.
- [ ] **Step 1: Failing tests** (log fixtures built with the helpers in `apps/web/test/timeline.test.ts`):
  `narration vs answer` (a step with text + tool_call → narration step; final text → prose after
  the block); `streamed narration moves into the open block` (draft prose then a draft tool call);
  `one block across thinking, tools, narration`; `queued user message splits the block`;
  `parallel sub-agents end the block, a single sync one is a step`; `fallback inside a run is a
  note step`; `approval waits outside, decided becomes a step`; `stopped while waiting`;
  `two handoffs merge into one pending entry`; `order outside: block, blocking, pending, files,
  answer`; `pinned keeps the latest per view`; `pinned stays outside after a failed run`;
  `log without placement` (card treated as `output`).
- [ ] **Step 2:** `pnpm exec vitest run apps/web/test/timeline-process.test.ts` → FAIL.
- [ ] **Step 3:** Set `narration` in the `assistant_message` case (content has a `tool_call`) and
  in `withDrafts` for drafts with tool calls; implement `groupProcess` as one pass with an open
  block accumulator.
- [ ] **Step 4:** PASS; the existing `apps/web/test/timeline*.test.ts` still PASS.
- [ ] **Step 5:** Commit `feat(web): fold a run's process into one block`.

### Task 7: Web: Thread draws process blocks

**Files:**
- Modify: `apps/web/src/components/conversation/ConversationView.tsx:320`
  (`groupProcess(withDrafts(...))`), `apps/web/src/components/conversation/Thread.tsx`
  (cases `process`, `pending`; tool and thinking rendering moved into `RailStep`s)
- Modify: `apps/web/src/components/conversation/AgentMap.tsx:435` (same post-pass for transcripts)
- Test: `apps/web/test/thread-process.test.tsx`

**Interfaces:**
- Consumes: Task 3 `ToolInfo.icon`, Task 4 components, Task 6 `ThreadEntry`.
- Produces: open state per block in the thread's existing UI state (finished blocks start closed,
  running / waiting open; a person's toggle wins until the run state changes).
- [ ] **Step 1: Failing tests** (`renderRouteWithCache` pattern of the existing thread tests):
  `finished run renders one collapsed block, files and the answer`; `running block shows the last
  four steps and the fold row`; `pending actions link to the handoff target`; `pinned todo card
  renders under the head while running`; `chips use the catalog icon of an extension tool`;
  `copying the answer copies no process text`; `the head announces step changes, not rows`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement; virtualize the rail past 200 steps with the thread's existing
  virtualization helper (grep `useVirtual` in `apps/web/src/components/conversation`).
- [ ] **Step 4:** PASS; `pnpm check:web-ui` PASS; `pnpm verify --fast` PASS.
- [ ] **Step 5:** Commit `feat(web): conversation thread draws process blocks`. Open PR 1.

### Task 8: Channel process setting and delivery columns

**Files:**
- Create: `packages/kernel/src/migrations/0185_channel_process_display.sql`
- Modify: `packages/kernel/src/channels/channels.schemas.ts:15,26`,
  `packages/kernel/src/channels/connections.service.ts`, kernel DB types
- Modify: `apps/web/src/app/(app)/channels/[id]/view.tsx`, `apps/web/src/lib/channels.ts`,
  `apps/web/messages/zh.json`, `apps/web/messages/en.json`
- Test: `packages/kernel/test/channels/connections.http.test.ts`, web channel page test

**Interfaces:**
- Produces:
  ```sql
  ALTER TABLE channel_connections ADD COLUMN IF NOT EXISTS process_display text
    CHECK (process_display IN ('detailed', 'brief', 'off'));
  ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_message_id text;
  ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS progress_run_id text;
  ALTER TABLE channel_deliveries ADD COLUMN IF NOT EXISTS milestone_at timestamptz;
  ```
  `processDisplay: z.enum(["detailed","brief","off"]).nullable().optional()` on create and update;
  `export function processDisplayOf(v: string | null, chatType: "dm" | "group"): "detailed" | "brief" | "off"`
  in `packages/kernel/src/channels/features.ts`.
  Web copy: 过程显示 / Process; 详细 / Detailed; 简洁 / Brief; 关闭 / Off; hint 「单聊默认详细，
  群聊默认简洁。」 / "Direct chats default to Detailed, group chats to Brief."
- [ ] **Step 1: Failing tests**: `update stores processDisplay and returns it`; `null resets to the
  default`; unit `processDisplayOf` (4 cases); web `saves the process setting`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Migration, schema, service, web FormSection (an existing section of the page,
  `Select`); Platform parity follows the shared schema.
- [ ] **Step 4:** PASS; `platform-parity.test.ts`, `pnpm check:applied-migrations --base origin/main` PASS.
- [ ] **Step 5:** Commit `feat(channels): per-connection process display setting`.

### Task 9: Channel progress reducer

**Files:**
- Create: `packages/kernel/src/channels/progress.ts`
- Test: `packages/kernel/test/channels/progress.unit.test.ts` (add to `unit-tests.json`)

**Interfaces:**
- Consumes: Task 2 `ChannelCard` `progress`.
- Produces:
  ```ts
  export interface ProgressState {
    runId: string; startedAt: string; endedAt?: string;
    state: "running" | "waiting" | "finished" | "stopped" | "failed";
    status?: string; pinned?: string; recent: string[]; pending: { text: string; url: string }[];
    thoughts: number; tools: number; errors: number; pinnedTitle?: string; pinnedBadge?: string;
    pinnedVersion: number;   // bumps when a pinned card's text changes (milestones)
  }
  export function initProgress(runId: string, startedAt: string): ProgressState;
  export function reduceProgress(s: ProgressState, e: ConversationEvent,
    label: (toolKey: string, input: unknown) => string, base: string | undefined): ProgressState;
  export function progressCard(s: ProgressState, opts: { base: string; conversationId: string;
    locale: "zh" | "en"; mode: "detailed" | "brief"; now: number }): ChannelCard;
  ```
  `label` is the approval card's existing title-and-key-argument helper. Narration (§1.1) sets
  `status` (first line, 120 characters, "…"); a pinned card sets `pinned` from its `text`;
  `brief` drops `steps` and `status`.
- [ ] **Step 1: Failing tests**: `narration becomes the status line`; `answer text does not`;
  `recent keeps the last three tool labels`; `handoff adds a pending link`; `approval_requested
  sets waiting, approval_decided resumes`; `run_finished finishes with the summary title
  "已处理 2 分 43 秒" and meta "待办 4/4 · 12 个工具 · 1 个调用出错"`; `pinned text bumps
  pinnedVersion only when it changes`; `brief has no steps`.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (pure). **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(channels): progress card reducer`.

### Task 10: Outbound: progress card, no narration messages (review alone, most capable model)

**Files:**
- Modify: `packages/kernel/src/channels/outbound.ts` (`Delivery`: `finalize` ~1537, `onDelta`
  ~1588, `handle` ~1058, the `tool_result` handoff branch ~1115, draft throttle ~1634)
- Test: `packages/kernel/test/channels/outbound-progress.test.ts`,
  `packages/kernel/test/channels/outbound-progress.dual.test.ts` (add to `container-tests.json`)

**Interfaces:**
- Consumes: Tasks 8, 9.
- Behaviour (spec §6.2):
  - Mode from `processDisplayOf(connection.process_display, target.chatType)`; edit channels with
    `detailed` / `brief` use the progress card; `off`, or no `features.edit`, keep today's draft.
  - `run_started`: post the progress card (new message, notifies), store `progress_message_id`,
    `progress_run_id` in the same `advance` write.
  - Each handled event of that run: `reduceProgress`; edit the card at
    `max(DRAFT_INTERVAL_MS, features.minEditIntervalMs)`, immediately on a state change or a new
    `pinnedVersion`; `onDelta` text goes to `status`, not a draft.
  - `assistant_message`: narration → no message; answer → one new message.
  - `tool_result` handoff → into `pending`, no message; after the answer, when `pending` is not
    empty, one message whose `cards` array holds one `bind` card per link (not one message per link).
  - Run end: final edit to the finished form.
  - No-edit channels: `run_started` → one 「已开始处理」 / "Working on it" message; a new
    `pinnedVersion` → one message with the pinned text if `milestone_at` is more than 60 s old
    (stored in PG, not memory); handoffs merged after the answer.
  - On delivery start with `progress_run_id` set: rebuild state by reducing the run's events from
    its `run_started` seq.
  - A rejected edit (`editRejected`): post a new progress message once and store its id.
- [ ] **Step 1: Failing tests** (fake-im): `narration sends nothing, the answer sends one message`;
  `one progress message per run, edited`; `approval card still posts a new message`;
  `handoffs merge after the answer`; `brief edits without steps`; `off keeps the streaming draft`;
  `no-edit channel sends start and throttled milestones`; `rejected edit re-posts once`;
  dual: `second replica resumes and edits the same progress message`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** PASS; existing `outbound*.test.ts`, `fake-im-approval.test.ts`,
  `schedules/channel-delivery.test.ts` PASS (update expectations that counted narration messages,
  each change noted in the commit body).
- [ ] **Step 5:** Commit `feat(channels): one progress card per run instead of narration messages`.

### Task 11: Docs and skills

**Files:**
- Modify: `.agents/skills/writing-channels/SKILL.md` (progress card, narration rule, setting),
  `.agents/skills/writing-extension-ui/SKILL.md` (`placement`, `text`),
  `.agents/skills/writing-web-ui/SKILL.md` (process blocks; `groupProcess` is the only grouping),
  `packages/plugin-sdk/agent-docs/` topic for channels and tool results (`pnpm gen:agent-docs`)
- [ ] **Step 1:** Edit; `pnpm check` PASS (agent docs, skills links).
- [ ] **Step 2:** Commit `docs: process blocks, card placement and channel progress`. Open PR 2.

### Task 12: Plugins (capybara-hq/plugins, after the SDK rc is published)

**Files:**
- Modify: `plugins/todo/src/index.ts:261` →
  `card: { view: TASKS_CARD, key: snapshot, placement: "pinned", text: renderTodos(todos) }`
  (`renderTodos` output cut to 2000 characters)
- Modify: `plugins/lark/src/cards.ts`, `plugins/slack/src/blocks.ts`,
  `plugins/telegram/src/cards.ts`: render `progress` (header with title and meta, status line,
  pinned Markdown, steps, pending links, url button); Telegram as text through `renderCardAsText`
- Test: each plugin's card test: `renders a running progress card`, `renders a finished one`;
  todo: `write returns a pinned card with text`
- [ ] **Step 1:** Bump the SDK dependency; failing tests. **Step 2:** FAIL. **Step 3:** implement.
- [ ] **Step 4:** PASS (`pnpm verify --fast` in plugins). **Step 5:** Commit per plugin; one PR;
  changesets for each published plugin.
