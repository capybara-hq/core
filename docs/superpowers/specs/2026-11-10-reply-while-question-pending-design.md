# Replying with a message while a question waits

- Date: 2026-11-10.
- Status: design, waiting for maintainer review. No code yet.
- Amends: the input request mechanism (`packages/kernel/src/tools/questions.service.ts`, the tool
  pipeline's resume of `input_required`), the IM card spec (`ChannelCard` kind `question`,
  `questionRenderableInline`, `renderCardAsText` in `packages/plugin-sdk/src/cards.ts`), the run input
  spec `2026-11-07-run-input-and-live-drafts-design.md` (messages during a run), the design spec
  `docs/design/spec.md` §6.16.12 (question block states).
- Markers: **(decided)** is the maintainer's direction (2026-11-10); **(designer's call)** is decided
  here and may be overturned in review; **(open)** is listed in §15 with a recommendation.

## 1. Why

The agent asks a question (`AskUserQuestion`, a single choice that also offers 「其他」). What happens
today, verified in the code:

1. **IM.** `questionRenderableInline` (`packages/plugin-sdk/src/cards.ts`) is false when the field has
   `allowOther`. `AskUserQuestion` always sets `allowOther: true` (`questionsForm` in
   `packages/kernel/src/tools/builtins/ask-user.ts`), so in Slack and Lark every `AskUserQuestion`
   card only shows 「到网页上回答」 (`plugins/slack/src/blocks.ts` `questionInputs`,
   `plugins/lark/src/cards.ts`).
2. **A plain reply does not move the run.** The person replies in the thread (or types in the web
   composer). `ChannelInbound.message` → `ConversationsService.postUserMessage` logs an ordinary
   `user_message` and calls `RunQueue.ensureRun`, which does nothing because the run is active
   (`waiting`). The message is an interjection: shown as 「待处理」 and taken in by the run's next model
   call (`model_call.request.absorbedUpToSeq`, R31). But the run is parked in `Waits` until every
   pending question of the run is settled (`Waits.resume` refuses while a `questions` row is
   `pending`). So nothing moves until the question expires (`tools.approvalTimeoutHours`, the
   `wait-timeout` job), and then the model is told "The user did not answer within Nh."
3. The web composer even says 「运行中发送的消息会在下一步交给智能体」 only while the run is running; while it
   waits there is no hint at all.

People often ignore a question and say something else; the run must follow the person, not the card.

## 2. Goals and non-goals

Goals:

- A message from the person who can answer a pending question closes the question as **skipped**
  and the run continues at once (decided).
- The model reads, as the question tool's result, that the person did not answer and sent a message,
  then the message itself as an ordinary user message from the log. The model alone decides whether
  the message answers the question or is a new request; it may ask again (decided).
- One rule for the web and every IM channel (decided).
- IM cards say a text reply works, and draw the option buttons also for a single choice with 「其他」,
  the 「其他」 path being a plain reply (decided).
- Replay invariant kept: everything the model sees is in the log; old logs rebuild byte for byte.

Non-goals:

- No matching of the reply against the options or 「其他」, no keyword rules (decided: rejected by the
  maintainer).
- Approvals are not touched: a message never decides, denies or skips an approval (§4.4).
- No new HTTP route; no new "skip" button (see §15 Q3).
- IM `/new` keeps its meaning (archives the thread's conversation); it does not post into the old
  conversation, so the old question keeps waiting there until it is answered on its card or expires.
- Sub-agent questions are not skipped by a message in the root conversation (§4.3, §15 Q1).

## 3. Decisions

| # | Decision | Source |
|---|---|---|
| D1 | A `user_message` written while one of the run's questions is pending, by the account that may answer it, sets that question to the new status `skipped` in the same transaction and logs `question_answered { outcome: "skipped" }`; the run resumes after the commit. | decided |
| D2 | The question's call gets a fixed English `tool_result` (§7); the message is the ordinary `user_message` already in the log, taken in by the next model call. No option matching. | decided |
| D3 | Who may skip = who may answer: the run's starter (`runs.trigger_account_id`), the existing rule of `QuestionsService.answer`. | existing rule, confirmed |
| D4 | Which questions: every `pending`, not yet overdue question of a run **of this conversation** whose starter wrote the message. Several pending questions are all skipped by one message; one resume follows. | designer's call |
| D5 | The log order decides: a message skips only the questions already logged (`question_asked`) and still pending when the message is written, under the conversation row lock. A message logged before the question was asked never skips it. | designer's call (§15 Q2) |
| D6 | For a skipped question the kernel writes the call's result itself and does not call the tool again, for all three question sources (`AskUserQuestion`, an extension tool's `input_required`, MCP elicitation). | designer's call (§15 Q4) |
| D7 | Every write to a `questions` row takes the conversation row lock first (the lock `EventLog.appendIn` takes), then the question row. The answer and expiry paths change their lock order to match. | designer's call (needed for D5 and to rule out deadlocks) |
| D8 | IM question cards gain `textReply` and the state `skipped`; `questionRenderableInline` accepts `{ textReply }`, which lifts the `allowOther` restriction. Option buttons are drawn for a single choice with 「其他」, and for a multi-select with 「其他」 too. | decided (single choice); designer's call (multi-select) |
| D9 | The web composer says a message skips the question while one the viewer can skip waits; the question card has a distinct skipped state; the trajectory viewer shows the outcome and links the message. | decided (direction), copy designer's call |
| D10 | No `DriftReason`: the skipped result is a logged `tool_result`, the message a logged `user_message`, its placement the existing `absorbedUpToSeq`. | designer's call (§12) |

## 4. The rule

### 4.1 Who

A question may be answered only by the run's starter (`runs.trigger_account_id`;
`QuestionsService.answer` → 403 `forbidden` for anyone else; the web `QuestionCard` and IM card
actions go through the same check). The same account skips it by writing a message. In practice:

- **Web.** A conversation is writable only by its owner (`ConversationsService.writable`), and runs of
  a chat conversation are started by the author of their trigger message, so the owner skips. A wake
  run (background task, sub-agent delivery) carries the trigger account it inherited
  (`run-queue.ts`), which is still the owner.
- **IM DM.** The conversation belongs to the bound person; same as the web.
- **IM group thread.** `channel_threads` is keyed by `(connection, chat, thread, account)`
  (`threads.ts`), so another bound person's message in the same thread goes to *their own*
  conversation and never reaches this question. Anonymous guests share the org's guest account
  (`AnonymousGuests.ensure`), so any anonymous person in that thread may already answer the guest's
  question on its card; they may equally skip it with a message. Unchanged trust, stated for review.
- A message whose author is not the starter (not reachable today; kept as a guard) skips nothing and
  stays an ordinary interjection.

### 4.2 Which questions, when

A `user_message` newly written by account `A` into conversation `C` skips each question `q` with:

- `q.conversation_id = C` (the run's own questions; sub-agent questions live in the child
  conversation, §4.3),
- `q.status = 'pending'` and `q.expires_at > now()`,
- `q.run_id` = a run of `C` in status `running` or `waiting` whose `trigger_account_id = A`
  (`running`: the question is logged but `Waits.suspend` has not parked the run yet; its
  `isSettled` re-check then resumes it at once).

| Case | Outcome |
|---|---|
| One pending question | skipped; run resumes; model sees the skipped result, then the message. |
| Several pending questions (parallel calls of one step, e.g. two `AskUserQuestion`, or one plus an extension tool's form) | all skipped by the one message, one resume, each call gets its skipped result. |
| Question and approval pending in the same step | the question is skipped, the approval stays; the run keeps waiting until the approval is decided, then takes in the message (§4.4). |
| Message logged before the question was asked (sent while the step was streaming) | not skipped (D5). The card appears after the person's message; they answer it or write again. The first message is taken in after the question settles, as today. |
| Question overdue but still `pending` (its timeout job has not run yet) | not skipped; the timeout job (or the wait sweep) expires it, the run resumes, the message is taken in after the expired result. Matches the answer path, which refuses an overdue question. |
| Question already `expired` / `answered` / `cancelled` | nothing; the message is an ordinary interjection or starts the next run, as today. |
| A retried message (same `clientMessageId`, deduped by `appendIn`) | skips nothing: only a message this transaction wrote skips (§8.1). |
| Message with attachments (`files`, `@` resources) or files only | skips like any message; the blocks travel in the `user_message`. |
| Slash command / skill invocation (`/name args`, web or IM) | a `user_message` with `skill`: skips. The rendered invocation is the message the model reads. |
| IM `/device`, `/new` | not messages to this conversation: skip nothing (`/new` archives the thread; the old question keeps waiting, see non-goals). |
| Message with a model / effort switch | skips; `model_switched` is logged before the message as today; the running run keeps its model. |
| Message in a sub-agent's conversation | refused today (`conversation.read_only`); unchanged. |

### 4.3 Sub-agent questions surfaced in the parent

A sub-agent's question belongs to the child run; the root shows it through `subagent_waiting`
(`Waits.surfaceInRoot`) and IM delivers the same card in the root's thread. A message in the root
conversation does **not** skip it (designer's call, §15 Q1):

- the message lands in the root's log; the child would be told "read it below" about a message it can
  never read;
- background sub-agents (`Agent`) never hold the parent run (agent map spec §5.4), so the root is not
  blocked: the message starts or joins a root run as today;
- a fork invocation's child (skill fork, `subagent_dispatches.for_skill`) does hold the parent run;
  there the message waits like during an approval. The person can still answer the card.

Consequently the IM card of a sub-agent question carries no `textReply` (§10.1) and the web composer
does not promise a skip for it (§11.1).

### 4.4 Approvals (out of scope)

Approvals are governance: the approver may be someone else (role escalation), and a reply is not a
decision. A message leaves every approval pending. While a run waits only on approvals, the message
stays 「待处理」 and is taken in after the decision, as today; the web composer says so (§11.1).

## 5. Question state machine

```
                 ask (question_asked)
                        │
                        ▼
                    ┌────────┐  answer by starter (card / web)     ┌──────────┐
                    │pending │ ───────────────────────────────────▶│ answered │
                    └────────┘                                     └──────────┘
                     │  │  │    message by starter (new)           ┌──────────┐
                     │  │  └──────────────────────────────────────▶│ skipped  │
                     │  │       expires_at ≤ now (timeout / sweep) ┌──────────┐
                     │  └─────────────────────────────────────────▶│ expired  │
                     │          run stopped / starter left org     ┌──────────┐
                     └────────────────────────────────────────────▶│cancelled │
                                                                   └──────────┘
```

- All four end states are terminal and each writes exactly one `question_answered` (idem
  `question_answered:<id>`). Transitions happen only under the row lock (§8), so concurrent
  attempts produce exactly one winner; the losers see a non-pending row (answer → 409
  `question.already_answered`; expire → `settled`; message → skips nothing).
- `skipped` makes the run resumable like the other end states (`Waits.resume` only looks for
  `status = 'pending'`), so `resume`, `isSettled`, the wait sweep (`sweepStuckRuns`,
  `sweepOverdue`) and the `wait-timeout` job need no change: a timeout job firing later finds the
  question settled and its resume attempt is a no-op.

## 6. Event log and schema changes

### 6.1 `question_answered`

```ts
// packages/kernel/src/conversations/events.ts
ev("question_answered", z.object({
  questionId: z.string(),
  callId: z.string(),
  answer: FormAnswerSchema.nullable(),          // null for skipped
  byAccountId: z.string().nullable(),           // skipped: the message's author
  outcome: z.enum(["answered", "skipped", "expired", "cancelled"]),
  /** skipped: the seq of the user_message that skipped it (same transaction, lower seq). */
  skippedBySeq: seqNo.optional(),
}))
```

- Appended in the message's transaction, right after the `user_message` (so `skippedBySeq` < its own
  seq), `runId` = the question's run.
- Not model-visible (request building skips `question_*` events, unchanged).
- Events are validated on append only, so a kernel rolled back past this change still reads these
  logs (pre-0.1.0, stated for completeness).

### 6.2 `questions.status`

New migration `packages/kernel/src/migrations/0107_question_skipped.sql` (number at implementation
time; kernel schema `capybara`):

```sql
-- A message from the run's starter closes a pending question (reply-while-question spec §6.2).
ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_status_check;
ALTER TABLE questions ADD CONSTRAINT questions_status_check
  CHECK (status IN ('pending', 'answered', 'skipped', 'expired', 'cancelled'));
```

Widening a check is expand-only; the pair is idempotent; `DROP CONSTRAINT IF EXISTS` is not a
destructive statement for `check:migrations`. Confirm the generated constraint name of
`0010_tools.sql` (`questions_status_check`) at implementation. `answered_by` / `answered_at` are
filled for skipped too (the author, `now()`). `QuestionStatus` and `QuestionsTable.status` gain
`"skipped"`.

### 6.3 Domain event

`KernelEventMap["question.answered"]` gains `outcome: "answered" | "skipped"` (the two outcomes a
person causes). Its consumers stay: `DecisionResumer` resumes the run, `ChannelJobs` enqueues the IM
delivery. Emitted after the commit, once per skipped question.

## 7. What the model sees

### 7.1 The skipped result

`ToolPipeline.processCall` today: last round `pending` → keep waiting; otherwise call the tool again
with `ctx.resume = { state, answer }` (`answer: null` for expired / cancelled). New: last round
`skipped` → write the result directly (D6), no tool call, no `tool_call_started`:

| Source | `content` (English, model-visible) | `isError` | `display.summary` (zh / en, UI only) |
|---|---|---|---|
| `AskUserQuestion` | `The user did not answer this question and sent a message instead; read it below and continue.` | false | 用户没有回答，直接发了消息 / User sent a message instead of answering |
| any other tool (extension `input_required`, MCP elicitation) | `The user did not provide the requested input and sent a message instead; read it below and continue. Call the tool again only if it is still needed.` | true | 用户没有提供输入，直接发了消息 / User sent a message instead |

Constants `QUESTION_SKIPPED_TEXT` and `INPUT_SKIPPED_TEXT` next to `INPUT_CANCELLED_TEXT` in
`tools/pipeline.ts`. Why no re-call (D6): an extension tool would only see `answer: null`, which it
reads as cancel / timeout, and could write any text; an MCP connector call would be re-sent to the
remote (its side effects before the elicitation repeat, `elicitation.ts` limits) just to be told
`cancel`. The skip is a person changing course; a fixed result is honest and identical everywhere.
`AskUserQuestion`'s own resume branch for `answer === null` stays for expiry.

### 7.2 Request shape

The next model call absorbs the message (`absorbedUpToSeq` ≥ its seq). Placement in
`buildModelRequest` is the existing one for an interjection that arrived while a tool ran: the
assistant turn with the `tool_use`, the tool results turn (the skipped result among them, in call
order), then the user message (inline at its seq; the `tool_result` is rendered right after its
assistant message). Nothing new in `build.ts`.

### 7.3 `AskUserQuestion` description

The last sentence of the description becomes: "The run pauses until the user answers. The user may
instead reply with a message; then the result says so and their message follows. If they do not
answer in time, the result says so." A changed description is a new spec hash: old `model_call`s keep
theirs and replays fetch definitions by hash; `tools_changed` compares keys only, so no notice is
logged.

## 8. Kernel flow

### 8.1 The message transaction

`ConversationsService.postIn` (already `@Transactional({ propagation: "requires_new" })`) →
`writeMessage` (mandatory) gains one step after the append:

1. `EventLog.appendIn(C, [model_switched?, user_message])` — takes the conversation row lock
   (`SELECT … FROM conversations … FOR UPDATE`). `appendIn` must report whether the `user_message`
   was newly written or returned by its idem key (a `written` flag on the result, or the conversation's
   `last_seq` read under the lock before the append).
2. Only if newly written: `QuestionsService.skipPendingIn(C, A, messageSeq)`
   (`propagation: "mandatory"`):
   ```sql
   SELECT q.* FROM questions q JOIN runs r ON r.id = q.run_id
   WHERE q.conversation_id = $C AND q.status = 'pending' AND q.expires_at > now()
     AND r.status IN ('running', 'waiting') AND r.trigger_account_id = $A
   ORDER BY q.created_at
   FOR UPDATE OF q
   ```
   For each row: `UPDATE questions SET status = 'skipped', answered_by = $A, answered_at = now()`;
   `appendIn(C, question_answered { …, outcome: "skipped", answer: null, byAccountId: A,
   skippedBySeq })`. Returns the records.
3. After the commit (the caller's existing post-commit section, AGENTS.md multi-replica rule):
   `eventLog.notify(C, maxSeq)`; per skipped question `events.emit("question.answered", { …,
   outcome: "skipped" })`; then `runs.ensureRun(C)` as today (a no-op: the run is active).

The resume: `DecisionResumer` → `Waits.resume(runId, questionId)`: the conditional update `waiting →
queued` (no pending approval / question, no active fork child) and the resume job id
`run-<conversationId>-resume-<questionId>`; once per wait whatever replica, as today. A lost emit is
repaired by the wait sweep's stuck-run pass (`WAIT_SWEEP_GRACE_MS`). A run still `running` when the
skip commits resumes through `Waits.suspend`'s `isSettled` re-check.

### 8.2 Lock order (D7)

Today the question writers lock in two orders: `answerIn` / `expireIn` / `cancelPendingFor` lock the
question row, then the conversation row (inside `appendIn`); `abortWaitingIn` locks the conversation
and run rows, then the questions (`cancelPendingIn`). The skip locks the conversation row first (it
must, D5). To make every pair consistent:

- `answerIn` and `expireIn`: read `conversation_id` of the question without a lock, `SELECT … FROM
  conversations WHERE id = … FOR UPDATE` (re-entrant with `appendIn`'s later lock), then the question
  row `FOR UPDATE` as today.
- `cancelPendingFor` (a member leaves): lock the affected conversations' rows in id order first.
- `askIn`: unchanged (it inserts a row nobody else can lock yet, then `appendIn` takes the
  conversation lock).

Why D5 then holds without gaps: a message and a question ask both serialize on the conversation row.
If the ask commits first, the message's `SELECT … FOR UPDATE` (a new statement after it got the
conversation lock) sees the pending question and skips it. If the message commits first, the
question's `question_asked` gets the higher seq and the question waits (the message is taken in after
it settles).

### 8.3 Races

| Race | Result |
|---|---|
| Answer (web or IM button) and message at once, same or different replicas | Both take the conversation lock, then the question row; one commits first. Answer first → the message finds no pending question and is an interjection taken in after the answer's result. Message first → the answer gets 409 `question.already_answered` (web toast; IM `alreadyHandled` phrase). Exactly one `question_answered`. |
| Expiry job and message | Same: one wins. An overdue question is never skipped (it is the expiry's). |
| Two messages at once | The first skips; the second finds nothing pending; both are taken in by the next call. |
| Stop (abort) and message | `abortWaitingIn` locks the conversation first, as the message does. Abort first → questions `cancelled`, run `aborted`; the message starts the next run. Message first → skipped and resume queued; the abort then finds the run `queued`/`running` and stops it the usual way. |
| Resume job and a late timeout job | `resume` is a conditional update; the late job's `expire` returns `settled`. |
| Rolling deploy: an old replica runs the resumed run | Old pipeline code sees a non-pending last round and re-calls the tool with `answer: null` (`AskUserQuestion` says "did not answer within Nh"). Harmless and pre-0.1.0; deploy order in §14 keeps the window short. |

## 9. API changes

- **No route is added or changed.** `POST …/conversations/:id/messages` keeps its body and its
  202 `{ event }` response; the skip is visible on the stream (`question_answered`). Platform
  parity: the route stays excluded (`internal`), `GET` / `POST …/questions/:id[/answer]` stay
  `human-only`; `platform-parity.test.ts` and `check:platform-ops` need nothing.
- `GET /api/v1/orgs/:orgId/questions/:id`: `QuestionView.status` may be `"skipped"`.
- `POST …/questions/:id/answer` on a skipped question: 409 `question.already_answered` with the
  message "Question was skipped: the user sent a message instead". Web copy
  `errors.question.already_answered`: 「该问题已被回答、已跳过或已过期。」 / "This question was already
  answered, skipped or has expired."
- Trajectory API (`evals/trajectory.ts`, `TrajectoryToolCall.question`): `outcome` gains
  `"skipped"`, plus `skippedBySeq?: number`.

## 10. Channels

### 10.1 Card spec and SDK (`packages/plugin-sdk/src/cards.ts`)

```ts
| {
    kind: "question";
    id: string;
    form: InputForm;
    state: "pending" | "answered" | "skipped" | "expired" | "cancelled";
    answerSummary?: string;
    webUrl: string;
    /**
     * The person may answer by replying with text instead (pending cards only): "plain" in a DM
     * (any reply reaches the agent), "mention" in a group thread (the reply must mention the bot,
     * the kernel ignores group messages without it). Absent: only the card's own controls work
     * (a sub-agent's question, §4.3).
     */
    textReply?: "plain" | "mention";
  }

/**
 * Whether IM can draw the question's controls: exactly one enum field (single ≤ 5 options /
 * multi ≤ 10). A field with allowOther qualifies only with `textReply` (the Other path is a plain
 * reply, so no Other button is drawn).
 */
export function questionRenderableInline(form: InputForm, opts?: { textReply?: boolean }): boolean;
```

- `validateChannelCard`: `state` accepts `skipped`; `textReply` optional, one of the two values.
- `renderCardAsText`: the state `skipped` reads 「已跳过（已直接回复）」 / "Skipped (replied instead)";
  a pending card with `textReply` adds one line after the web link: `plain` → 「也可以直接回复文字」 /
  "You can also just reply with text"; `mention` → 「也可以在本话题 @我 回复文字」 / "You can also reply
  in this thread, mentioning me".
- Calls without `opts` keep today's answer, so existing callers compile and behave as before; the
  new parameter is a public API change: `pnpm gen:sdk-api` and a changeset bumping
  `@capybara-hq/plugin-sdk` (`check:sdk-api`, `check:sdk-api-changeset`). Pre-0.1.0: no
  `channel@1` version bump for the new state and field.

### 10.2 Kernel outbound (`packages/kernel/src/channels/outbound.ts`, `cards.ts`)

- `questionCard(…)` gains the state `skipped` and an optional `textReply`.
- `questionCardAt` sets `textReply` for a question of a run of the delivered conversation
  (`question_asked`): `this.target.chatType === "dm" ? "plain" : "mention"`. The `subagent_waiting`
  path passes none.
- `question_answered` with `outcome: "skipped"`: the card is replaced like the other outcomes (idem
  key `<conversation>-question-<id>-skipped`); the run's output then follows in the thread through
  the delivery already enqueued by the inbound message.

### 10.3 Inbound flow (no new code path)

Reply in the DM, or in the thread with the bot mentioned → `ChannelInbound.message` (dedupe, speaker
resolution, thread lookup) → `post` → `postUserMessage` → the skip of §8.1 → `channel_deliveries`
upsert and outbound job (existing). The card's buttons after a skip → `QuestionsService.answer` →
`question.already_answered` → the existing `alreadyHandled` reply.

### 10.4 Channel plugins (capybara-hq/plugins)

Slack (`blocks.ts` `questionInputs` / `questionBlocks`), Lark (`cards.ts`) and Telegram (if it draws
buttons; otherwise it already uses `renderCardAsText`):

- call `questionRenderableInline(c.form, { textReply: c.textReply !== undefined })`; never draw an
  「其他」 button;
- pending with `textReply`: a context line with the hint (same copy as §10.1);
- `questionStates.skipped` in their locale tables; an unknown future state falls back to the text
  renderer's label rather than printing `undefined` (designer's call; cheap insurance).
- Their tests: a single choice with `allowOther` + `textReply` draws buttons and the hint; without
  `textReply` only the web link; multi-select with `allowOther` draws checkboxes; skipped state.

## 11. Web

### 11.1 Composer (`apps/web/src/components/conversation/ComposerBar.tsx`)

Today `hint = running ? t("runningHint") : undefined`. New, from the timeline's pending waits
(`PersonWaits`; the run's starter from `run_started.triggerAccountId`):

| Run state | Hint (replaces the placeholder) |
|---|---|
| running | unchanged: 运行中发送的消息会在下一步交给智能体 / Messages sent while it works reach it at its next step |
| waiting, a question of this conversation's run is pending and the viewer is its starter | 也可以直接回复：发送消息会跳过上面的提问 / Or just reply: sending a message skips the question above |
| waiting otherwise (approvals only, or a fork sub-agent's question) | 处理完上面的事项后，智能体才会读到新消息 / New messages reach the agent once the item above is handled |

Keys `chat.waitingSkipHint`, `chat.waitingHint` (zh and en, `check:i18n`; zh says 智能体, never the
Latin word). The send button stays enabled in every state.

### 11.2 Timeline and the pending chip (`apps/web/src/lib/timeline.ts`)

- `QuestionItem.answered` already carries the `question_answered` payload; it now may be
  `outcome: "skipped"` with `skippedBySeq`. `waitEnded` is outcome-agnostic (no change).
- The message is held and shows 「待处理」 at the bottom until a `model_call` absorbs it (existing D4 of
  the run input spec); the resume is immediate, so the chip shows for about one model call, then the
  message stands after the question card, before the step that took it in. Reload renders the same.

### 11.3 Question card (`apps/web/src/components/QuestionCard.tsx`, design `QuestionBlock`)

Today `cancelled` is drawn as the design's `skipped` state (「已跳过」), which becomes wrong. Change:

- design `QuestionState` (`packages/design/src/conversation/hitl.tsx`) gains `{ kind: "cancelled" }`
  (`hitl.cancelledQuestion`: 已取消 / Cancelled); `skipped` keeps `who` and its copy becomes
  `hitl.skipped`: 已跳过：直接回复了消息 / Skipped: replied with a message;
- `QuestionCard`: `answered` → answered, `skipped` → skipped (`who` = 你 / You for the viewer),
  `expired` → expired, `cancelled` → cancelled;
- `docs/design/spec.md` §6.16.12: states `pending`, `url`, `answered`, `skipped`, `cancelled`,
  `expired`; the size table gains the cancelled row (same tokens as skipped). Visual baselines are
  re-rendered by the `visual-update` workflow only.
- `SubagentWait` (a sub-agent's question in the root) shows the same states through the child's log.

### 11.4 Trajectory viewer

The tool call's question line reads 已跳过（用户发了消息） / Skipped (the user sent a message) with a
link to the message at `skippedBySeq` in the same trajectory (`apps/web/src/lib/trajectories.ts`
type gains the outcome and field).

## 12. Replay and evals

- **No `DriftReason`** (D10). The skipped result is a `tool_result` event (content and `isError`
  are what request building reads); the message is a `user_message`; where the next request put it is
  the recorded `absorbedUpToSeq`. `question_answered` is not model-visible. Request building is
  untouched, so the rule "new model-visible input needs a DriftReason" does not apply: nothing is
  read from PG, config or the clock.
- **Old logs** have no `skipped` outcome and rebuild byte for byte; `reconstruct.test.ts` and
  `rename-compat.test.ts` are run before and after (they must stay green with no fixture edits).
- **Step replay** of the step after a skip rebuilds the skipped result and the message from the case
  snapshot like any interjection.
- **Full-run replay** (`RecordedToolPipeline`) returns the recorded skipped result for the matched
  call and copies the message as a `replay_interjection` at the step that absorbed it
  (`run-replay.ts`, existing); a candidate that does not call the question tool at that point is the
  existing `tool_unmatched`. Replays never create questions or fire the skip.
- **Evals**: no change to eval sets, the judge or the queue. A case taken from such a run reads
  naturally to the judge (the result text says what happened).

## 13. Tests

Kernel (`pnpm exec vitest run <path>` from the root; model-fake scripts):

- `test/tools/questions-skip.test.ts` (new): a message by the starter skips the pending question
  (status, `answered_by`, event with `skippedBySeq` = the message's seq, emitted once); not an
  overdue one; not another conversation's; not a question of a run started by someone else; a
  deduped retry (same `clientMessageId`) skips nothing; a message logged before `question_asked`
  skips nothing.
- `test/runtime/waits.test.ts`: waiting on `AskUserQuestion` → message → run resumes at once (no
  timeout job needed), `tool_result` = `QUESTION_SKIPPED_TEXT`, `isError: false`, the next
  `model_call.request.absorbedUpToSeq` ≥ the message's seq and the provider request ends with the
  results turn, then the message; two questions in one step → both skipped, one resume job; question +
  approval in one step → question skipped, run still `waiting`, resumes after the decision with both
  in the request; overdue question + message → expired by the job, message after the expired result.
- Extension `input_required` (fake-tools-ui) and MCP elicitation (fake-connector) → `INPUT_SKIPPED_TEXT`,
  `isError: true`, the handler / remote is **not** called again (call counters).
- Sub-agent: a fork child's question surfaced in the root, a root message → the child question stays
  pending (D4, §4.3).
- `test/runtime/waits-dual.test.ts`: answer on replica A and message on replica B, 50 iterations of
  `Promise.all` → exactly one `question_answered`, never a deadlock (`40P01`), the run resumes once;
  same for expiry vs message and abort vs message.
- Skill invocation and files-only messages skip (web and `inbound-skills.test.ts`).
- Channels: `inbound.test.ts` DM reply and group reply with mention while a question waits → skipped,
  card replaced with `skipped`, the run's reply delivered in the thread; a card click after the skip →
  `alreadyHandled`. `outbound.test.ts` / `subagent-cards.test.ts`: pending card `textReply` `plain` in
  a DM, `mention` in a group, absent for a sub-agent question. `cards.test.ts`: `skipped` card.
- Migration: `check:migrations` passes; the status check accepts `skipped`.
- Trajectory: `outcome: "skipped"` with `skippedBySeq`.
- **Zero drift** (`test/evals/reconstruct.test.ts`, baseline group), two new cases built from real
  runs: "a question skipped by a message: the skipped result, then the message; zero drift and equal
  to what the provider received" and "a message sent while the asking step streamed: not a skip, the
  answer then the message; zero drift". `run-replay.test.ts`: full-run replay of a run with a skipped
  question sends the same requests.

SDK (`packages/plugin-sdk/test/cards.test.ts`): `questionRenderableInline` with and without
`textReply` (single + Other, multi + Other, several fields, too many options);
`validateChannelCard` accepts `skipped` and both `textReply` values, rejects others;
`renderCardAsText` hint lines and the skipped label in zh and en.

Web: `timeline.test.ts` (skipped outcome on the card; message placed after the card once absorbed,
pending before); `conversation-page.test.tsx` (the three composer hints, zh and en); `QuestionCard`
cancelled vs skipped; design `conversation-shell.test.tsx` for the new state; `pnpm check:web-ui`,
`pnpm check:i18n`.

## 14. Rollout

1. One core PR (after this spec and its plan are approved): SDK cards change + `gen:sdk-api` +
   changeset; migration; lock order (D7); skip; pipeline results; outbound `textReply`; trajectory;
   web and design; the skills updated in the same PR: `writing-tools` (skipped outcome, no re-call),
   `writing-channels` (card spec), `replay-evals` (skip needs no DriftReason), `writing-web-ui` if the
   design catalog changes. Changesets for every published package touched (`pnpm changeset`).
2. Plugins PR in capybara-hq/plugins (slack, lark, telegram) on the released SDK; released in the
   same rc as the kernel. A kernel newer than its channel plugins shows `skipped` cards through the
   plugin's fallback (§10.4) and no hint line until the plugin is upgraded; release notes say so.
3. Deploy: the migration runs before the new code serves (standard start gate); during a rolling
   deploy an old replica may run a resumed run (§8.3, harmless).

## 15. Open questions (maintainer)

1. **Sub-agent questions.** Should a message in the root skip a pending question of a *fork*
   sub-agent that holds the root run? Recommendation: **no, not in this change** (§4.3): the child
   cannot read a message logged in the root, and forks that ask are rare; the card stays answerable.
   Revisit if acceptance hits it (the fix would give the child a variant text, "the user sent a
   message to the main conversation instead; finish with what you have and report back").
2. **A message sent just before the question.** When the person's message was logged while the step
   that asks was still streaming, should the new question be skipped at once? Recommendation: **no**
   (D5): the log order is the rule, the card appears after their message and they can answer or reply
   again; auto-skipping would close questions the person never saw.
3. **The design's Skip button.** `QuestionBlock` already has an unused `onSkip` (spec §6.16.12 shows
   跳过 / Skip). Wire it to the same `skipped` outcome without a message ("The user skipped this
   question.")? Recommendation: **defer** to a small follow-up with its own route; this design leaves
   room (`skippedBySeq` absent = skipped without a message).
4. **Extension tools and MCP elicitation.** Apply the same rule to every question source and have the
   kernel write the result instead of calling the tool again (D6)? Recommendation: **yes**: one rule,
   no repeated remote side effects, and an extension cannot tell a skip from a cancel today anyway
   (`ctx.resume.answer` is only `null`).
