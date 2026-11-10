# Reply While a Question Waits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A message from the run's starter closes every pending question of that conversation's run
as `skipped`; the run resumes at once and the model reads a fixed skipped result, then the message.

**Architecture:** The skip happens inside the message's own transaction, under the conversation row
lock `EventLog.appendIn` already takes (D5, D7). The tool pipeline writes the skipped result itself
on resume (D6). Cards, the web composer and the question card learn the new state; nothing in
request building changes (D10).

**Tech Stack:** TypeScript, NestJS + Kysely (kernel), PostgreSQL, BullMQ, Next + TanStack Query
(apps/web), `@capybara-hq/design`, vitest.

**Spec:** `docs/superpowers/specs/2026-11-10-reply-while-question-pending-design.md` (approved
2026-11-10, decisions in §15).

## Global Constraints

- Model-facing text is English and fixed (spec §7.1):
  - `QUESTION_SKIPPED_TEXT = "The user did not answer this question and sent a message instead; read it below and continue."` (`isError: false`, `AskUserQuestion` only)
  - `INPUT_SKIPPED_TEXT = "The user did not provide the requested input and sent a message instead; read it below and continue. Call the tool again only if it is still needed."` (`isError: true`, every other tool)
  - `display.summary`: AskUserQuestion `{ zh: "用户没有回答，直接发了消息", en: "User sent a message instead of answering" }`; others `{ zh: "用户没有提供输入，直接发了消息", en: "User sent a message instead" }`.
- No `DriftReason`, no change to `runtime/context/build.ts`; `reconstruct.test.ts` and
  `rename-compat.test.ts` pass before and after with no fixture edits.
- Migration: next free number (main is at 0107 → `0108_question_skipped.sql`), schema `capybara`,
  expand-only, idempotent.
- Lock order for every `questions` write: conversation row, then question rows (D7). The only locks
  taken inside a transaction are these row locks. Bus publishes, `notify` and `events.emit` happen
  after the commit.
- `question_answered` idem key stays `question_answered:<id>`: exactly one per question.
- SDK public API change → `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`;
  kernel / web / design changes → changesets as `pnpm check` requires.
- UI copy zh + en through i18n; zh says 智能体, never the Latin `agent`; apps/web writes no styles.
- Run tests from the repo root: `pnpm exec vitest run <path>`.

## Review Focus

1. A deduped retry of a message (same `clientMessageId`) must skip nothing — `appendIn` returning an
   old event must be told apart (Task 3 test "retry skips nothing").
2. A fork sub-agent's question surfaced in the root must stay pending after a root message (Task 4
   test "sub-agent question is not skipped").
3. Answer / expiry / abort racing a message across replicas: one `question_answered`, no `40P01`
   (Task 6).
4. A question of a run started by another account (wake runs inherit the owner, guest account
   shared) — only `runs.trigger_account_id = author` skips (Task 3 test "other starter").
5. Rolling back to old pipeline code after a skip: old code re-calls the tool with `answer: null`
   (harmless, spec §8.3) — no test, stated in the PR.

---

### Task 1: SDK question card: `skipped`, `textReply`, inline with Other

**Files:**
- Modify: `packages/plugin-sdk/src/cards.ts`
- Modify: `packages/plugin-sdk/src/index.ts` (exports, if not re-exported by `*`)
- Test: `packages/plugin-sdk/test/cards.test.ts`
- Generated: `packages/plugin-sdk/api/*` via `pnpm gen:sdk-api`; changeset `.changeset/question-text-reply-sdk.md` (minor pre-release bump of `@capybara-hq/plugin-sdk`)

**Interfaces:**
- Produces:
  - `ChannelCard` question: `state: "pending" | "answered" | "skipped" | "expired" | "cancelled"`, `textReply?: "plain" | "mention"`.
  - `questionRenderableInline(form: InputForm, opts?: { textReply?: boolean }): boolean`.
  - `questionTextReplyHint(mode: "plain" | "mention", locale: Locale): string` (copy below).
  - `questionStateLabel(state: string, locale: Locale): string` (an unknown state returns the state string itself, never `undefined`).

- [ ] **Step 1: Failing tests** in `cards.test.ts`:
  - `questionRenderableInline` single + `allowOther` → `false`; with `{ textReply: true }` → `true`; multi + Other + `textReply` → `true`; two fields → `false`; single with 6 options + `textReply` → `false`.
  - `validateChannelCard` accepts `state: "skipped"`, `textReply: "plain" | "mention"`; rejects `textReply: "x"` with `textReply must be one of "plain", "mention"`.
  - `renderCardAsText` pending + `textReply: "plain"` ends with the line `也可以直接回复文字` (zh) / `You can also just reply with text` (en); `"mention"` → `也可以在本话题 @我 回复文字` / `You can also reply in this thread, mentioning me`; `skipped` status line `状态：已跳过（已直接回复）` / `Status: Skipped (replied instead)`.
- [ ] **Step 2:** `pnpm exec vitest run packages/plugin-sdk/test/cards.test.ts` → FAIL.
- [ ] **Step 3:** Implement. Hint line goes after the web link line, pending cards only.
- [ ] **Step 4:** Tests pass; `pnpm gen:sdk-api`; `pnpm check:sdk-api`.
- [ ] **Step 5:** Commit `feat(plugin-sdk): question cards say a text reply works and can be skipped`.

### Task 2: Schema: migration, status type, event payload, domain event

**Files:**
- Create: `packages/kernel/src/migrations/0108_question_skipped.sql` (spec §6.2 body; confirm the constraint name in `0010_tools.sql` / `pg_constraint`)
- Modify: `packages/kernel/src/db/kernel-schema.ts` (`QuestionsTable.status`), `packages/kernel/src/tools/questions.service.ts` (`QuestionStatus`)
- Modify: `packages/kernel/src/conversations/events.ts` (`question_answered.outcome` + `skippedBySeq: seqNo.optional()` — reuse the seq schema the file already uses)
- Modify: `packages/kernel/src/infra/events/kernel-events.ts` (`"question.answered"` gains `outcome: "answered" | "skipped"`)
- Test: `packages/kernel/test/conversations/events.test.ts`, migration via `pnpm check:migrations`

- [ ] **Step 1:** Failing test: `ConversationEventSchema` parses `question_answered` with `outcome: "skipped", answer: null, skippedBySeq: 7`; rejects `skippedBySeq: -1`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; existing `answer()` emits `outcome: "answered"`.
- [ ] **Step 4:** `pnpm exec vitest run packages/kernel/test/conversations/events.test.ts`, `pnpm check:migrations`, `pnpm typecheck` → pass.
- [ ] **Step 5:** Commit `feat(kernel): questions can be skipped (status, event outcome)`.

### Task 3: Lock order and `skipPendingIn` (multi-replica; review alone)

**Files:**
- Modify: `packages/kernel/src/conversations/event-log.ts` — `appendIn` result gains which events were newly written: new method `appendInReport(conversationId, events): Promise<{ events: ConversationEvent[]; fresh: boolean[] }>` (same transaction contract; `appendIn` delegates and returns `.events`).
- Modify: `packages/kernel/src/tools/questions.service.ts`
- Test: create `packages/kernel/test/tools/questions-skip.test.ts`

**Interfaces:**
- Produces: `QuestionsService.skipPendingIn(conversationId: string, accountId: string, messageSeq: number): Promise<{ records: QuestionRecord[]; toSeq: number | null }>` (`@Transactional({ propagation: "mandatory" })`), SQL as spec §8.1 step 2, each row → `status 'skipped'`, `answered_by`, `answered_at = now()`, `question_answered { outcome: "skipped", answer: null, byAccountId, skippedBySeq: messageSeq }`.
- Produces: private `lockConversation(conversationId)` used by `answerIn` and `expireIn` (read `conversation_id` without lock, `SELECT id FROM conversations … FOR UPDATE`, then the question `FOR UPDATE` as today); `cancelPendingFor` first selects the distinct conversation ids of the affected rows and locks those conversation rows `ORDER BY id`.
- `answerIn` on a `skipped` row: 409 `question.already_answered`, message `"Question was skipped: the user sent a message instead"`.

- [ ] **Step 1: Failing tests** (`questions-skip.test.ts`, kernel + PG + Redis like `ask-user.test.ts`, mem-connector fixture; drive `QuestionsService` and `ConversationsService.postUserMessage` through the HTTP message route):
  - "a message by the starter skips the pending question": status `skipped`, `answered_by` = owner, one `question_answered` with `outcome: "skipped"`, `skippedBySeq` = the message's seq < event seq.
  - "an overdue question is not skipped" (set `expires_at = now() - interval '1 minute'` directly).
  - "another conversation's question is not skipped".
  - "a question of a run started by someone else is not skipped" (update `runs.trigger_account_id` to another account).
  - "a retried message (same clientMessageId) skips nothing": message 1 skips question 1; the run asks question 2; resending message 1 with its `clientMessageId` leaves question 2 pending.
  - "a message logged before question_asked skips nothing": call `skipPendingIn` order check — append a `user_message` with `EventLog.append`, then `QuestionsService.ask`, then assert pending (the skip runs only in the message's transaction).
  - "answering a skipped question → 409 question.already_answered".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `appendInReport`, `skipPendingIn`, lock order changes.
- [ ] **Step 4:** Tests pass (Task 4 wires the call; tests that post messages pass after Task 4 — implement Tasks 3 and 4 as one commit if the implementer prefers).
- [ ] **Step 5:** Commit `feat(kernel): a starter's message skips the run's pending questions`.

### Task 4: Wire the skip into the message transaction

**Files:**
- Modify: `packages/kernel/src/conversations/conversations.service.ts` (`writeMessage` → uses `appendInReport`; when the `user_message` is fresh, calls `questions.skipPendingIn`; `postIn` returns `{ event, toSeq, skipped }`; `postUserMessage` after commit: `notify(C, max seq)`, per skipped record `events.emit("question.answered", { id, orgId, conversationId, runId, outcome: "skipped" })`, then `ensureRun` as today)
- Modify: the module wiring so `ConversationsService` can inject `QuestionsService` (check for cycles; if `ToolsModule` imports conversations, move `QuestionsService` provider so both see it, or inject via a small token — prefer the existing module graph).
- Test: `questions-skip.test.ts` (end-to-end), `packages/kernel/test/runtime/waits.test.ts`

- [ ] **Step 1: Failing tests:**
  - "waiting on AskUserQuestion → message `echo:moved on` → run finishes with `moved on`" with no timeout job: `tool_result.content === QUESTION_SKIPPED_TEXT`, `isError: false`, `display.summary` as Global Constraints; the next `model_call.request.absorbedUpToSeq` ≥ message seq.
  - "two questions in one step (`tools:[AskUserQuestion, AskUserQuestion]`) → both skipped by one message, one resume, two skipped results".
  - "question + approval in one step → question skipped, run still `waiting`; after the approval the run takes in the message".
  - "files-only message skips" and "a skill invocation skips" (web route).
  - "sub-agent question is not skipped": a fork skill's child asks; a root message leaves the child question `pending`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Pass.
- [ ] **Step 5:** Commit (with Task 5 if the pipeline is needed for green).

### Task 5: Pipeline writes the skipped result; AskUserQuestion description

**Files:**
- Modify: `packages/kernel/src/tools/pipeline.ts` (`processCall`: last round `skipped` → `writeResult(ctx, call.id, last.toolKey, { content, isError, display: { summary } })`, return `undefined`; no `tool_call_started`, no re-call. Constants next to `INPUT_CANCELLED_TEXT`.)
- Modify: `packages/kernel/src/tools/builtins/ask-user.ts` (description's last sentence per spec §7.3)
- Test: `packages/kernel/test/tools/ask-user.test.ts`, `packages/kernel/test/tools/elicitation.test.ts`

- [ ] **Step 1: Failing tests:** mem-connector `ask` tool → message → `memState().askCalls` has exactly one entry, result `INPUT_SKIPPED_TEXT`, `isError: true`; MCP elicitation (the existing fake MCP server in `elicitation.test.ts`) → the remote saw one `tools/call`, result `INPUT_SKIPPED_TEXT`. Description test asserts the new sentence.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Commit `feat(kernel): the kernel writes a skipped question's result`.

### Task 6: Races across replicas

**Files:**
- Test: `packages/kernel/test/runtime/waits-dual.test.ts` (or `questions-skip.dual.test.ts` if setup differs)

- [ ] **Step 1:** Tests (20 iterations each; the spec's 50 if the run stays under ~60 s): answer on replica A vs message on B via `Promise.all` → exactly one `question_answered`, no error code `40P01` in either response, run reaches terminal once; expire (set `expires_at` to `now() + 200ms`, call `questions.expire` as it comes due) vs message; abort vs message → either `aborted` with the message starting a new run, or skipped then stopped.
- [ ] **Step 2:** Run; fix product bugs if any (never loosen the assertions).
- [ ] **Step 3:** Commit `test(kernel): skip races answer, expiry and stop on two replicas`.

### Task 7: Channel outbound: `textReply` and the skipped card

**Files:**
- Modify: `packages/kernel/src/channels/cards.ts` (`questionCard(…, state incl. "skipped", webUrl, answer, textReply?)`)
- Modify: `packages/kernel/src/channels/outbound.ts` (`question_asked` → `textReply: this.target.chatType === "dm" ? "plain" : "mention"`; `subagent_waiting` path none; `question_answered` handles `skipped`)
- Test: `packages/kernel/test/channels/outbound.test.ts`, `subagent-cards.test.ts`, `inbound.test.ts`, `cards.test.ts`

- [ ] **Step 1: Failing tests:** DM pending card `textReply: "plain"`; group `"mention"`; sub-agent card has no `textReply`; inbound DM reply while a question waits → card replaced with `state: "skipped"` (idem key `<conv>-question-<id>-skipped`), the run's reply delivered in the thread; a card click after → `alreadyHandled` phrase; group reply with mention → skipped.
- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** Commit `feat(kernel): IM question cards offer a text reply and show skipped`.

### Task 8: Trajectory, zero-drift fixtures, full-run replay

**Files:**
- Modify: `packages/kernel/src/evals/trajectory.ts` (`outcome` gains `"skipped"`, `skippedBySeq?: number`)
- Modify: `plugins/model-fake/src/script.ts` — new directive `slowtool:<ms>:<name>:<json>` (waits `ms`, abortable, then the tool call) to log a message while the asking step streams; README/docs line where directives are listed.
- Test: `packages/kernel/test/evals/trajectory.test.ts`, `reconstruct.test.ts` (two new cases in the baseline describe), `run-replay.test.ts`

- [ ] **Step 0:** Before any kernel change: `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts packages/kernel/test/tools/rename-compat.test.ts` → pass (record in the PR).
- [ ] **Step 1: Failing tests:**
  - reconstruct "a question skipped by a message: the skipped result, then the message; zero drift and equal to what the provider received" (`expectZeroDrift`, and the last request has the tool results turn before the user text).
  - reconstruct "a message sent while the asking step streamed: not a skip, the answer then the message; zero drift" (`slowtool:300:AskUserQuestion:{…}`, post message while streaming, answer the question, assert `question_answered.outcome === "answered"`).
  - trajectory: `question.outcome === "skipped"`, `skippedBySeq` = message seq.
  - run-replay: full-run replay of a run with a skipped question sends the same requests.
- [ ] **Step 2–4:** fail → implement → pass; reconstruct + rename-compat again green.
- [ ] **Step 5:** Commit `feat(kernel): trajectories show skipped questions; zero-drift cases`.

### Task 9: Web and design

**Files:**
- Modify: `packages/design/src/conversation/hitl.tsx` (`QuestionState` gains `{ kind: "cancelled" }`; copy keys `hitl.cancelledQuestion`, `hitl.skipped` → 已跳过：直接回复了消息 / Skipped: replied with a message) and the design i18n tables
- Modify: `apps/web/src/components/QuestionCard.tsx` (outcome → state mapping per spec §11.3)
- Modify: `apps/web/src/components/conversation/ComposerBar.tsx` + the view that passes run state: hint per spec §11.1 (`chat.waitingSkipHint`, `chat.waitingHint`)
- Modify: `apps/web/src/lib/timeline.ts` (types: `outcome` `"skipped"`, `skippedBySeq`), `apps/web/src/lib/trajectories.ts` + trajectory viewer line (已跳过（用户发了消息） / Skipped (the user sent a message), link to `#seq-<n>` or the existing seq anchor)
- Modify: `apps/web/messages/{zh,en}.json` (`errors.question.already_answered` per spec §9), `docs/design/spec.md` §6.16.12
- Test: `packages/design/test/hitl.test.tsx` / `conversation-shell.test.tsx`, `apps/web/test/timeline.test.ts`, `conversation-page.test.tsx`, `trajectories.test.tsx`

- [ ] **Step 1: Failing tests:** cancelled vs skipped rendering; composer hints: running → `runningHint`; waiting with a question of this run whose starter is the viewer → `waitingSkipHint`; waiting on an approval only → `waitingHint` (zh and en); timeline skipped outcome; trajectory skipped line with link.
- [ ] **Step 2–4:** fail → implement → pass; `pnpm check:web-ui`, `pnpm check:i18n`.
- [ ] **Step 5:** Commit `feat(web): composer hint and skipped / cancelled question states`.

### Task 10: Skills, changesets, verify

**Files:**
- Modify: `.agents/skills/writing-tools/SKILL.md` (skipped outcome, no re-call), `writing-channels/SKILL.md` (card `skipped`, `textReply`), `replay-evals/SKILL.md` (a skip needs no DriftReason), `writing-web-ui/SKILL.md` only if the design catalog line changes
- Create: changesets for `@capybara-hq/kernel`/`@capybara-hq/capybara` (whatever `pnpm check` asks), `@capybara-hq/design`, `@capybara-hq/plugin-sdk` (Task 1)

- [ ] **Step 1:** `pnpm typecheck && pnpm lint && pnpm check`.
- [ ] **Step 2:** `pnpm verify`; a timing-only failure elsewhere is rerun once and reported.
- [ ] **Step 3:** Commit `docs(skills): reply-while-question-pending`.
