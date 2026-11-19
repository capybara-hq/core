# Prompt suggestions in the composer

Status: draft for maintainer review (2026-11-19). The interaction and the decisions listed under
"Maintainer decisions" are approved and not reopened here.

## Intent

After an agent's turn ends, the composer of the conversation page shows the message the person is
most likely to send next as its placeholder, in the placeholder's grey. Tab fills the composer with
it (the person can edit, then send); typing anything hides it. This is Claude Code's prompt
suggestion, carried to the web.

The suggestion comes from one extra **side request** to the run's own model, sent after the run
completed, with the run's last model request as a byte-identical prefix so that the provider's
prompt cache serves almost all of its input.

## Maintainer decisions (given, not reopened)

1. No hidden tool for the main model. The SDK has only `toolChoice: "auto" | "none"`, and a tool
   call would continue the run and pollute the append-only log. Instead, after a root
   conversation's run completes normally, the kernel sends one side request to the same model with
   the exact prefix of the run's last request plus an appended instruction, and a small output cap.
2. Only the run's own model: no cheaper model, no new purpose mapping (another model loses the
   cache).
3. On by default; the platform (super admin) and each org can switch it off.
4. UI only: never in the model-visible history; replay and evals unaffected.
5. Not for sub-agents, channel conversations, failed or aborted runs, runs waiting on a person,
   scheduled or headless runs (the exact list is fixed in §2 from the code).
6. Usage is recorded and attributed, and the call fires the model hooks.

## Goals

- One short suggestion per completed web chat run, shown in that conversation's composer.
- The side request's input is served from the prompt cache wherever the provider caches: the
  prefix is byte-identical to the run's last request, verified at runtime, never assumed.
- Never delays the run's completion, never holds a run or conversation lock, never adds a
  model-visible event, never shows an error to anyone.
- Multi-replica safe: no process memory, a deterministic BullMQ job, a Redis key with a TTL.
- Billed and reported like every other kernel model call (`usage` event, `usage.report`,
  `model.request` / `model.response` hooks, policy hooks fail closed).

## Non-goals

- Several suggestions, a suggestion list, or chips of alternatives.
- Suggestions in channels (Lark, Telegram, Slack…), in sub-agent threads, on the new conversation
  page (no run has happened yet) or for external apps calling the HTTP API (they read the event
  log; the suggestion is not in it, see §5).
- Recording that a sent message came from a suggestion. A sent suggestion is an ordinary
  `user_message` typed by the person.
- A per-member switch. The org and the platform switch are the only controls (decided question 3
  defers a member-level one).
- Retrying a failed suggestion. Any failure means no suggestion for that run.

## Facts this design builds on (origin/main, 2026-11-19)

Verified in code unless marked *inferred*.

- **Run end.** `RunWorker` (`packages/kernel/src/runtime/run-worker.ts`) writes the terminal event
  through `finish(...)` and then calls `this.completed(conversationId)` for outcomes `completed`,
  `max_steps`, `budget` (the `default` branch) and `max_duration`. `completed()` is fire-and-forget
  (`void this.titles.maybeEnqueue(conversationId)`) and runs after the terminal state committed.
  `suspended` (waiting for an approval, an input or sub-agents), `aborted`, `interrupted` and
  failures (`run_failed`) never reach it. A manual compact run (`executeCompaction`) finishes
  without calling it. `budget` exists only for sub-agents (`budgetRunOf`).
- **Precedent: titles.** `packages/kernel/src/conversations/titles.ts` is a post-run side call:
  queue `cap-kernel-titles` (no `:`), deterministic job id `title-<conversationId>-<attempt>`,
  consumed on the worker role through `run-processors.ts`, `model.request` policy then observe
  with `purpose: "title"`, `runId: ""`, `step` 0, `attempt` 1 (a denial writes a `hook.denied`
  audit row and no `hook_denied` event), and a `usage` event with `purpose: "title"`, `step` 0 and
  no run, appended with `appendInReport` + `UsageReportJobs.oweEvents` in a
  `@Transactional({ propagation: "requires_new" })` method. Step consumers skip every `usage` with
  a `purpose`; run totals never see a run-less one (replay-evals skill).
- **Precedent: ephemeral display state.** Compaction progress (`runtime/compaction-progress.ts`)
  is a Redis key with a TTL plus a bus message on `conversationTopic(id)`, forwarded by the SSE as
  `event: compaction`; never in the log. Live drafts (`RunDrafts`) are read from Redis once after
  the SSE catch-up and sent as `event: draft` (`runtime/stream.ts`).
- **The request is rebuildable byte for byte.** `assembleModelRequest` (`runtime/model-call.ts`)
  is shared by the runtime and `evals/reconstruct.ts`; `reconstructRequest` rebuilds a recorded
  `model_call` from a `CaseSnapshot` (`evals/snapshot.ts`, `takeSnapshot` for a finished run:
  events up to the terminal event, the agent definitions, the tool specs by `specHash`) with the
  recorded params, `toolChoice`, `absorbedUpToSeq`, output cap and fit plan, and reports drift;
  a baseline with empty drift equals what was sent (`reconstruct.test.ts`, zero drift).
  `loadSnapshotMedia` loads the media bytes for it.
- **Append-only.** `buildModelRequest` (`runtime/context/build.ts`): "new events are only appended
  at the end of messages; the only prefix change comes from a new compaction summary", and `step`
  and `agentVersion` never enter the request "to keep the cache prefix stable". `usage` events
  never enter the request.
- **Wrap-up precedent and why this design does not copy it.** The wrap-up call (`buildRequest`
  with `wrapUp`, model-call.ts ~line 1047) reuses the prefix but sets `toolChoice: "none"`. The
  Anthropic plugin maps that to `tool_choice: {type: "none"}` and the OpenAI-compatible,
  OpenAI and DeepSeek plugins to `tool_choice: "none"` (plugins repo, `*/src/map-request.ts`).
- **Provider caching** (plugins repo):
  - `anthropic/src/map-request.ts`: system blocks with `cache: true` get `cache_control`; the
    history uses the top-level automatic `cache_control` (breakpoint on the last cacheable block);
    thinking is `{type: "adaptive"}` with a `display` from `params.thinking`, effort from
    `params.effort`; `max_tokens` from `maxOutputTokens`; `tool_choice` only for `"none"`.
  - Anthropic's cache invalidation hierarchy (Anthropic prompt-caching docs, as bundled with the
    Claude API skill): changing `tool_choice` keeps the tools and system caches but **invalidates
    the messages cache**; a `thinking` or `effort` change invalidates the messages cache;
    `max_tokens` is not part of the cached prefix; appending messages keeps the prefix. On Opus
    4.5+ / Sonnet 4.6+ / Haiku 5.5 and the Fable and Mythos models a plain user message after
    thinking turns keeps the messages cache; on earlier models it strips previous thinking blocks
    and misses from the first stripped block (the same happens to the person's next real message).
  - OpenAI (`openai/src/map-request.ts`, Responses API) and DeepSeek / OpenAI-compatible: no
    explicit breakpoints; the vendors cache an exact prompt prefix automatically and report hits
    (`cached_tokens`, DeepSeek `prompt_cache_hit_tokens`). *Inferred:* the output cap is not part
    of the cached prompt on either; whether `tool_choice` is rendered into the cached prompt is not
    documented, so this design never changes it (below).
  - `ModelRequest.purpose` is "informational; real providers ignore it and must not forward it"
    (`plugin-sdk/src/model.ts`), so it changes no wire bytes.
- **Settings patterns.** Org settings live in `orgs.settings` jsonb, read leniently
  (`OrgSettingsSchema`, `orgs/settings.service.ts`), patched through `OrgSettingsPatchSchema`,
  and mirrored by the Platform operations `org-settings.get` / `org-settings.update`
  (`platform/ops/org-settings.ops.ts`). Platform settings live in `deployment_settings`
  (`identity/settings.ts`, `DEPLOYMENT_SETTINGS_PATCH`), mirrored by `admin.settings` /
  `admin.update-settings` (`platform/ops/admin.ops.ts`). Both operations take the route's exported
  schema, so a new field flows into them; only their descriptions are hand-written.
- **Composer.** `ComposerBox` (`packages/design/src/conversation/composer.tsx`) owns the textarea
  placeholder (`token?.hint ?? hint ?? placeholder`) and its key handling; the web's `ComposerBar`
  (`apps/web/src/components/conversation/ComposerBar.tsx`) owns the draft. `isTouchPointer()`
  exists in `packages/design/src/shell/pointer`. Spec: `docs/design/spec.md` §6.16.2 (Composer,
  states `idle`, `new`, `running`, …) and §6.11 (keys).
- **Model-fake** (`plugins/model-fake/src/script.ts`) already keys a scripted reply on
  `req.purpose === "compaction"`.

## Design

### 1. The side request

For a run that qualifies (§2), the job (§3) builds:

1. **The reference.** `takeSnapshot(db, orgId, conversationId, runId, evals.maxCaseBytes)` and
   `reconstructRequest(snapshot, lastCallSeq, { model: info, mediaInfo, media })` as a baseline
   (no candidate definition, params or version), where `lastCallSeq` is the run's last
   `model_call` (highest seq; the call whose response is the run's final `assistant_message`),
   `info` the current `ModelInfo` of that call's `provider` / `model` (a fallback rung's model if
   the last call used one) resolved for the org, and the media from `loadSnapshotMedia`. Any drift
   (`system_hash`, `tools_changed`, `tool_spec_missing`, `definition_missing`, `params_changed`,
   `media_missing`, `media_changed`, `permission_profile_changed`) means the provider would see a
   different prefix: **skip**. This is the zero-drift path evals already test.
2. **The extension.** The same `assembleModelRequest` inputs as the reference (recorded tools,
   params, `toolChoice`, `absorbedUpToSeq`, `recordedMaxOutputTokens`, media), with the events
   extended to the seq of the run's final `assistant_message`. Because building is append-only,
   this is the reference's messages plus that assistant message, rendered exactly as the next step
   or the person's next message would render it. The job **checks** it: `system`, `tools`,
   `toolChoice` and `params` deep-equal the reference's, the first `n` messages deep-equal the
   reference's `n` messages, and exactly one assistant message follows. Otherwise: skip.
3. **The instruction.** One appended `user` message with one text block,
   `PROMPT_SUGGESTION_INSTRUCTION` (model-facing, English):

   > The user has not replied yet. Write the message the user is most likely to send next in this
   > conversation, as the user would type it, in the language the user writes in. Keep it short
   > (at most 12 words, or about 25 CJK characters) and specific to what just happened: a natural
   > follow-up request, a choice between options you offered, or a go-ahead to continue. Do not
   > answer it, do not call tools and do not explain. Reply with the message text only, or with
   > exactly NONE when no next message is clear.

   A `user` message, not a `role: "system"` message: a mid-conversation system message must follow
   a user message on Anthropic, and the plugins turn unsupported ones into `[system]` user text
   anyway; a user turn after an assistant turn is valid on every provider.
4. **What differs from the run's last request, and nothing else:**
   - two appended messages (the final assistant message, the instruction);
   - `maxOutputTokens = min(reference.maxOutputTokens, PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS)`,
     `PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS = 2048`. Not part of the cached prefix on any provider
     (Anthropic: documented; others: inferred). The cap is a cost ceiling, not a target: thinking
     cannot be switched off without breaking the cache (below), so the cap leaves room for a short
     adaptive thought; the expected output is a few dozen tokens;
   - `purpose: "suggestion"` (not sent to the vendor).

   **Unchanged on purpose:** `system`, `tools` (still declared: the history has tool calls, and
   the tool definitions are the first cached block), `params` (thinking, effort, temperature:
   Anthropic invalidates the messages cache on a thinking or effort change, so the title call's
   `thinking: "off"` default is not used here) and **`toolChoice`**. Anthropic documents that a
   `tool_choice` change invalidates the messages cache, which is the whole conversation; the
   wrap-up precedent pays that, the suggestion must not. So the request keeps the recorded
   `toolChoice` (absent on an ordinary last step, `"none"` when the run ended in a `max_steps`
   wrap-up), and tool use is refused in the instruction's words instead. **A reply that contains a
   `tool_call` block is discarded** (no suggestion), as is one with any stop reason other than
   `end_turn`.
5. **Cost guards** (each: skip, debug log, no call):
   - the reference carries a fit plan (`model_call.request.fit`): the run was already trimmed to
     fit the window, and two more messages may not fit;
   - the extension's estimate (`estimateTokens`) plus the cap is over
     `contextWindow - compaction.reserveTokens` for the model;
   - the run's last step reported no cache activity (`cacheReadTokens + cacheWriteTokens = 0` in
     its `usage`) and more than `PROMPT_SUGGESTION_UNCACHED_INPUT_MAX = 8000` input tokens: the
     provider is not caching this conversation, so the side request would cost a full-price input;
   - the job started more than `PROMPT_SUGGESTION_MAX_DELAY_MS = 60_000` after the run finished
     (a backed-up queue): the person has probably moved on, and the default 5-minute Anthropic
     cache is less likely to be warm.

   **Cache effect per provider.** Anthropic: the tools, system and messages caches of the last
   step are read; the automatic breakpoint writes one new entry covering the two appended
   messages (a small 1.25× write on those tokens only). OpenAI, DeepSeek and OpenAI-compatible
   vendors: the prefix is identical, so their automatic prefix cache applies when the vendor and
   model cache at all; the guard above stops a conversation that shows no caching from paying
   repeatedly. Measured on a deployment: main-run cache hit ~97 %.

6. **The call.** The job resolves the provider (`ProviderRegistry.resolve(orgId, ref)`; a model or
   provider disabled since the run, or not resolving: skip) and calls `consumeModelStream`
   (model-call.ts) with no sink, `info.streamIdleTimeoutMs ?? runtime.streamIdleMs` and a signal
   that aborts after `PROMPT_SUGGESTION_TIMEOUT_MS = 60_000` or on worker shutdown. One attempt: no
   same-model retry, no fallback model (a fallback would miss the cache).
7. **The result.** `cleanSuggestion(text)`: the text blocks joined, the first non-empty line, with
   control characters and `HIDDEN_FORMAT_RE` (bidi and other format characters; `text.ts`) removed,
   wrapping quotes and a leading `User:` / `用户：` label stripped, trimmed, at most 200 characters
   (cut on a code point boundary, no ellipsis). `NONE` (any case), an empty result, or a result
   equal to the final assistant message's text means no suggestion.

### 2. When it runs, and when not

The run worker calls `PromptSuggestionQueue.maybeEnqueue(...)` from `completed()` with the outcome
kind (a new parameter). The job re-checks everything below before it calls the model, and the write
re-checks freshness (§4). A suggestion is generated only when **all** hold:

| Condition | Source |
|---|---|
| Outcome `completed` or `max_steps` (not `max_duration`: the deadline may cut a step; not `budget`: sub-agents only) | `run_finished.reason` |
| `conversations.kind = 'chat'` (not `subagent`, not `eval`: no step or full-run replay ever enqueues) | conversation row |
| `conversations.source = 'web'` (not `channel_dm` / `channel_group`, not `subagent`) | conversation row |
| `run_started.trigger` is not `schedule` (unattended; nobody is at the composer) and not `compact` (a compact run sends no step request) | `run_started` |
| The run's last `assistant_message` answers its last `model_call` (it is the newest model-visible event of the run; only its `usage` and `run_finished` follow), has text and no `tool_call` block | log |
| The run is the conversation's latest run, no user message has been logged after its `run_finished`, and the conversation's message queue is empty | `runs`, log, `conversation_queue` |
| The platform switch and the org switch are both on (§6) | settings |
| Every guard of §1.5 passes | §1 |

Not generated, by construction: failed and aborted runs (`run_failed` / `run_aborted`, never
`completed()`), runs waiting on a person (`suspended`, not terminal; when the wait ends and the run
completes, it qualifies), interrupted runs, wake runs that end while another run is queued.
Included: wake runs after a background task or a sub-agent delivery (`trigger:
"background_task"` / `"subagent"`) on a web conversation; they end with a reply the person reads
like any other.

API-created conversations (`POST /conversations` from an external app) have `source: "web"` too
(`conversations.controller.ts`). They qualify; the cost is bounded by the guards, and the result
is never in the log. Decided question 2 keeps them.

### 3. Where it runs

- **Queue** `cap-kernel-suggestions` (no `:`), registered like `cap-kernel-titles`; producer on
  any role (the run worker), consumer only on the `worker` role through an `@Processor` in
  `runtime/run-processors.ts` and started under `WorkerModule`, as titles are.
- **Job** `suggest-<runId>` (run ids are UUIDs: no `:`), data `{ conversationId, runId,
  finishedAt }`, `attempts: 1`, `removeOnComplete: true`, `removeOnFail: true`. The deterministic
  id makes a double enqueue (the same run completing twice is impossible, but a replayed
  `completed()` after a crash is not) a no-op. Worker concurrency `PROMPT_SUGGESTION_CONCURRENCY
  = 4` per replica (a constant; the calls are short and mostly cached).
- **Enqueue is a hint.** `completed()` runs after the terminal state committed and the enqueue is
  `void`-ed and never throws (it logs). A lost enqueue costs one suggestion; per AGENTS.md this is
  a hint whose loss is harmless, so no outbox row.
- **No locks, no transaction around the call.** The job holds neither the conversation row lock
  nor a run lease and reads with plain queries; the usage write is its own short transaction.
- **No run quota.** Like titles, the side request is not a run: it takes no org run-concurrency
  slot.
- **Shutdown.** The worker's stop aborts the call in flight; the job is dropped (no retry).

### 4. Storage and delivery

**Choice: a Redis key with a TTL plus a bus message, not an event in the log.**

- The suggestion is a disposable UI hint, valid until the next message. The event log is the
  conversation's permanent record and the single source of truth for what the model saw; a
  `prompt_suggestion` event would be kept forever, copied into eval snapshots and trajectories
  and exports, and every reader of the log (build, reconstruct, the trajectory viewer, the web
  timeline, external apps) would have to learn to skip it. A key that expires costs nothing to
  forget.
- The codebase already keeps display-only conversation state this way (compaction progress, live
  drafts), multi-replica safe: the key is the shared state, any replica reads it.
- The one thing the log does carry is the side request's `usage` event (§7), which must be durable
  for billing; it holds no text.

Details:

- Key `capk:prompt-suggestion:<conversationId>`, value
  `{"runId","afterSeq","text","createdAt"}` (`afterSeq` = the seq of the run's `run_finished`),
  `EX` `PROMPT_SUGGESTION_TTL_SECONDS = 86_400`. One key per conversation: a newer suggestion
  replaces an older one.
- **Write only when fresh.** After the call, the job re-reads the §2 freshness conditions (latest
  run, no user message after `afterSeq`, empty queue) and writes only if they still hold. A message
  sent in the gap between that read and the write leaves a stale key, which the readers below
  ignore; correctness never depends on the write winning a race.
- **Delivery.** The job publishes `{ kind: "prompt_suggestion", conversationId, runId, afterSeq,
  text }` on `conversationTopic(conversationId)` (a new member of `ConversationBusMessage`,
  validated in `isBusMessage`); the SSE forwards it as `event: suggestion` with
  `{runId, afterSeq, text}`. On every SSE open (including reconnects), after the catch-up and the
  live drafts, the stream reads the key and sends the same frame when the suggestion is still
  fresh (the conversation's latest run is `runId`, no `user_message` / `run_started` after
  `afterSeq`) and the effective switch is on; a stale key is deleted there. No new HTTP route.
- **Invalidation is the reader's rule, not a delete.** The web shows a suggestion only while
  (a) its `runId` is the conversation's latest finished run in the client's log, (b) the client's
  log holds no `user_message` and no `run_started` with a seq above `afterSeq`, (c) no run is
  active, and (d) the draft is empty and was not touched since the suggestion arrived (§5). A new
  message, a new run (a retry, a wake, a queued message), a fork or a switch away from the
  conversation all fail these checks, so nothing needs to be cleared and no message path deletes
  the key: the next suggestion replaces it, an SSE open deletes it when stale, and the TTL is the
  backstop.
- **Who sees it.** Whoever may open the conversation's stream receives the frame; they can already
  read the whole conversation. The web renders it only in the composer, which the page shows only
  to those who may send.

### 5. The UI

`ComposerBox` gains one optional prop, `suggestion?: { text: string; onDismiss(): void }`; the web
passes it from the conversation's state. The design package does the rendering and the keys:

- **Shown** as the textarea's placeholder (same `faint` placeholder style, one line, ellipsis when
  longer than the line on a phone) when the draft is empty, no skill chip is set and no run is
  going (the running `hint` wins). The idle placeholder ("输入消息，/ 使用命令") is replaced, not
  combined.
- **Tab** (no modifier, not composing, the draft empty, a suggestion shown): `preventDefault`,
  the draft becomes the suggestion text, the caret goes to its end; the person edits or sends with
  ↵ as usual. Tab is intercepted in exactly this state, so keyboard focus navigation is unchanged
  everywhere else; Shift+Tab is never intercepted.
- **Esc** while a suggestion is shown dismisses it (then Tab moves focus as usual).
- **Typing hides it**: any change that makes the draft non-empty dismisses the suggestion for
  that run (it does not come back when the draft is cleared again, as in Claude Code). Pasting
  and attaching a file count as typing.
- **Accessibility.** The textarea's placeholder is the suggestion, so screen readers announce it
  as the field's placeholder; while it is shown the textarea is also described
  (`aria-describedby`) by a visually hidden "按 Tab 使用建议" / "Press Tab to use the
  suggestion". No live region (a suggestion arriving must not interrupt reading the reply).
- **Touch devices** (`isTouchPointer()`, no Tab key): a ghost `control.dense` button "使用建议" /
  "Use suggestion" (`corner-down-left` 14) at the end of the control row before send, shown only
  while a suggestion is shown; tapping it fills the draft (and does not pop the keyboard,
  consistent with `refocusText`). Its accessible name includes the text ("使用建议：<text>").
  Decided question 1.
- **Web.** `useConversation` keeps `suggestion` from the SSE `onSuggestion` handler and applies
  the reader's rule of §4 against its event list; `ConversationView` passes it to `ComposerBar`,
  which passes it to `ComposerBox` and tracks the per-run dismissal. Sub-agent composers and the
  new conversation page pass none.
- **Design spec.** §6.16.2 gains the state `suggestion` (placeholder, Tab, Esc, typing, the touch
  button and its size row), the placeholder list gains "the suggestion replaces the idle
  placeholder", and §6.11 (keys) gains "Tab in an empty composer showing a suggestion fills it;
  Esc dismisses it". The `/dev/ui` catalog and the reference set gain the `suggestion` state
  (baselines rendered only by the `visual-update` / `reference-update` workflows).
- **Copy** (design i18n, zh and en): `composer.suggestion.hint` 按 Tab 使用建议 / Press Tab to use
  the suggestion; `composer.suggestion.use` 使用建议 / Use suggestion;
  `composer.suggestion.useNamed` 使用建议：{text} / Use suggestion: {text}.

### 6. Settings

- **Platform** (super admin): `deployment_settings` key `promptSuggestions`, `"on" | "off"`,
  absent = `on`. `DEPLOYMENT_SETTINGS_PATCH.promptSuggestions: z.enum(["on","off"]).nullable()
  .optional()` (null clears to the default). An invalid stored value reads as `off` with a
  warning (a cost switch fails toward no extra calls). Read live per job and per SSE open. No
  startup config field (decided question 3).
- **Org** (org admin): `OrgSettingsSchema.promptSuggestions: z.enum(["on","off"]).optional()
  .catch("off")`, absent = `on`; `OrgSettingsPatchSchema.promptSuggestions:
  z.enum(["on","off"]).nullable().optional()` (null clears it, back to on).
- **Effective** = platform `on` **and** org not `off` (`effectivePromptSuggestions(platform,
  org)`). The org cannot switch on what the platform switched off: the org settings response
  carries the platform value (`deployment.promptSuggestions`), and the org settings page shows the
  switch disabled with "平台已关闭" / "Turned off by the platform".
- **Web.** The organization settings page and the admin settings page each get one switch in the
  conversation group next to compaction: "输入建议" / "Prompt suggestions", description
  "智能体回复后，在输入框里给出你可能想发的下一条消息。每次会额外调用一次同一模型，通常大部分由缓存提供。" /
  "After the agent replies, the input box suggests the next message you might send. Each
  suggestion is one extra call to the same model, mostly served from the prompt cache."
- **Platform tool.** No new route, so no new operation and no exclusion. The new fields join the
  shared patch schemas, so `org-settings.update` and `admin.update-settings` accept them without
  new code (the parity test pins it); the four descriptions (`org-settings.get` / `.update`,
  `admin.settings` / `.update-settings`) name the field. Both directions are allowed through the
  tool: it is a cost switch, not a widening of access (like `toolSearch`).

### 7. Usage accounting and hooks

- **Purpose `"suggestion"`.** `ModelCallPurpose` (`plugin-sdk/src/hooks.ts`) and therefore
  `UsagePurpose` and `ModelRequest.purpose` gain `"suggestion"`; the kernel's `usage` event schema
  (`conversations/events.ts`), the usage report payload type (`runtime/usage-report.ts`) and the
  web's purpose union (`apps/web/src/lib/conversations.ts`) follow. An SDK public API change:
  `pnpm gen:sdk-api` and a changeset bumping `@capybara-hq/plugin-sdk`.
- **`model.request`** fires before the call with `purpose: "suggestion"`, the run's scope
  (`orgId`, the run's trigger `accountId`, `agentId`, `agentVersion`, `conversationId`, `runId` =
  the run it follows), `step` 0, `attempt` 1, the request as sent (media as placeholders,
  `hookRequestOf`). Policy hooks run first and fail closed (a policy extension not loaded on the
  replica denies). A denial: no call, a `hook.denied` audit row with `detail.purpose:
  "suggestion"`, no `hook_denied` event (not a run step), no suggestion, no retry.
- **`model.response`** (observe) fires after a sent call, `outcome` ok or failed, with usage when
  known; not for a call aborted by shutdown.
- **`usage` event** appended to the conversation's log, like a title's: `purpose: "suggestion"`,
  `step` 0, no run (`runId` null), `idemKey` `usage_suggestion:<runId>` (one per run), written
  with its owed `usage.report` delivery in one transaction (`appendInReport` + `oweEvents`). A
  call that failed after it was sent logs its estimated input as usage, as titles do. Step
  consumers skip it (it has a purpose), run totals and the run row never include it (it belongs
  to no run), the conversation's and the org's usage include it, `usage.report` delivers it with
  `purpose: "suggestion"` and `runId: ""`. The event is not model-visible (`build.ts` skips
  `usage`) and needs no `DriftReason`.
- **Observability.** One debug log line per call with the conversation, run, model, input,
  cache-read and cache-write tokens and the outcome (never the text), so a deployment can check the
  cache hit rate the design relies on.

### 8. Failure handling

Every failure means no suggestion; nothing reaches a person as an error, nothing is retried, the
run is unaffected (it already ended).

| Failure | Behaviour |
|---|---|
| Enqueue fails (Redis down) | logged at warn; no suggestion |
| A §2 condition no longer holds when the job runs | skipped silently |
| Snapshot too large, drift, extension mismatch, a §1.5 guard | skipped, debug log |
| Model or provider no longer resolves, media unavailable | skipped, debug log |
| `model.request` denied | audit row, no call |
| Provider error, idle timeout, 60 s timeout | warn log, usage logged if sent |
| Reply with a tool call, a stop reason other than `end_turn`, `NONE`, empty after cleaning | no suggestion, usage logged |
| Freshness lost before the write | usage logged, nothing written |
| Redis write or bus publish fails | warn log; the usage stands |
| Worker shutdown mid-call | aborted, dropped, no `model.response` |

### 9. Privacy

- The side request sends the provider exactly what the run already sent, plus the final reply and
  a fixed instruction: no new data leaves the deployment.
- The suggestion text is stored only in Redis for at most 24 hours, keyed by conversation, and
  reaches only clients allowed to open that conversation's stream. It is never logged (log lines
  carry token counts only), never written to the event log, never sent to a channel, never in a
  trajectory, an eval case or a `usage.report` payload.
- Policy and observe hooks see the side request like a step request (the same content the run
  already showed them), labelled `purpose: "suggestion"`, so a policy extension can deny the
  purpose specifically.

### 10. Replay and evals

Nothing model-visible changes: no `model_call`, no `reminder`, no new event type. The only new log
entry is a `usage` event with a purpose and no run, which request building skips, step consumers
skip, and snapshots copy as data. Step and full-run replays run in `eval` conversations and never
enqueue (§2), and replays fire no hooks. The zero-drift fixtures are untouched, and the job's use of
`reconstructRequest` adds a production consumer of the zero-drift guarantee rather than a new
request builder.

### 11. Where the code changes

| Area | Files |
|---|---|
| SDK | `packages/plugin-sdk/src/hooks.ts` (`ModelCallPurpose`), `model.ts` (doc of `purpose`), generated API, changeset |
| model-fake | `plugins/model-fake/src/script.ts` (`purpose: "suggestion"` reply, `suggest:` script lines) |
| Kernel side call | new `packages/kernel/src/conversations/prompt-suggestion-request.ts` (pure: request builder, eligibility, cleaning), `prompt-suggestion-store.ts` (Redis key, freshness, bus publish), `prompt-suggestions.ts` (queue, job, hooks, usage), `runtime/run-processors.ts`, `roles/worker-role.ts`, `lifecycle/kernel-lifecycle.ts`, `runtime/run-worker.ts` (`completed(conversationId, runId, kind)`) |
| Kernel events and usage | `conversations/events.ts` (usage purpose), `runtime/usage-report.ts` (payload type), `evals/trajectory.ts` if it enumerates purposes |
| Kernel delivery | `conversations/event-log.ts` (`ConversationBusMessage`), `runtime/stream.ts` (`isBusMessage`, frame, open-time send) |
| Kernel settings | `identity/settings.ts` (platform key, patch, read), `orgs/settings.service.ts` (org field, patch, effective), `platform/ops/org-settings.ops.ts`, `platform/ops/admin.ops.ts` (descriptions) |
| Design | `packages/design/src/conversation/composer.tsx` (prop, placeholder, keys, touch button), design i18n, CSS for the touch button, `/dev/ui` catalog state, `docs/design/spec.md` §6.16.2 and §6.11 |
| Web | `apps/web/src/lib/stream.ts` (`event: suggestion`), `components/conversation/useConversation.ts`, `ConversationView.tsx`, `ComposerBar.tsx`, `lib/conversations.ts` (purpose union), `lib/org-settings.ts`, `lib/admin.ts`, the two settings views, web messages (zh, en) |

## Testing

Per the test portfolio (unit: no database or app, listed in `packages/kernel/test/unit-tests.json`;
integration: one app per file, the default; container: dual-replica, listed in
`container-tests.json`; no fixed sleeps, no per-test timeouts).

- **Unit (kernel)**, `test/conversations/prompt-suggestion-request.test.ts`, joins
  `unit-tests.json`:
  - the request builder on log fixtures: the side request equals the reconstructed last request
    except for the two appended messages, the output cap and `purpose`; `toolChoice` absent stays
    absent and `"none"` (a `max_steps` wrap-up) stays `"none"`; `system`, `tools` and `params`
    deep-equal; a fit plan, drift or an extension mismatch returns skip;
  - eligibility: each row of §2 flips the answer (outcome, kind, source, trigger, last event,
    queue, newer user message);
  - `cleanSuggestion`: `NONE`, quotes, labels, control and bidi characters, 200-character cut on a
    surrogate pair, echo of the assistant text;
  - the cost guards and the 60 s staleness guard;
  - `effectivePromptSuggestions`, and invalid stored values reading as off.
- **Integration (kernel)**, `test/conversations/prompt-suggestions.test.ts` (model-fake, one app):
  - a completed web run produces one side call whose request (recorded by the test model) has the
    last step request as an exact prefix, one `usage` event with `purpose: "suggestion"` and no
    run, one owed `usage.report`, the Redis key, and an `event: suggestion` SSE frame; an SSE
    opened afterwards receives it too;
  - no side call for: a channel conversation, a sub-agent, a scheduled run, a failed run, an
    aborted run, a run waiting for an approval, the org switch off, the platform switch off;
  - a message sent while the side call is in flight: the key is not written (or is ignored on
    open) and the next SSE open sends nothing;
  - a reply with a tool call, `NONE`, a provider failure, a policy denial (audit row, no call):
    no suggestion, never an error event, run state untouched;
  - `org-settings.update` / `admin.update-settings` accept `promptSuggestions`;
    `platform-parity.test.ts` stays green.
- **Container (dual-replica)**: not needed. The job is keyed by run id (BullMQ dedupes across
  replicas by job id), holds no lock and keeps no process state; the titles dual test already
  covers the queue mechanics this reuses. (Recorded here so a reviewer can disagree.)
- **Replay**: the zero-drift fixtures (`reconstruct.test.ts`) run before and after unchanged.
- **Design (jsdom)**, `packages/design/test/composer-suggestion.test.tsx`: placeholder shown only
  when empty and idle; Tab fills and moves the caret, Tab without a suggestion or with text is not
  intercepted, Shift+Tab never; Esc dismisses; typing dismisses for the run; the touch button;
  `aria-describedby`; `findNestedBoxes` finds nothing.
- **Web**: `useConversation` applies the reader's rule (a later `user_message` or `run_started`
  hides it; a frame for an older run is ignored); a settings view test for the disabled org switch.

## Rollout

On by default after merge; release notes say so and name both switches. Deployments whose
providers do not cache, or whose cache hit is poor, can switch it off on the platform. No
migration (settings are jsonb and `deployment_settings` rows; the purpose is a jsonb value).

## Decided questions (2026-11-19, maintainer delegation)

The maintainer delegated these to the recommendations:

1. **Touch devices.** Phones get the small "使用建议" / "Use suggestion" button in the control row
   while a suggestion shows (§5); placeholder only would give phones a suggestion they cannot use
   without retyping it.
2. **External apps.** API-created conversations (`source: "web"`) keep getting suggestions: the
   cost is bounded (one cached call per completed run, the guards of §1.5, the org switch);
   revisit with the `purpose: "suggestion"` usage numbers. Recording a message's client is a
   separate change.
3. **More switches.** No startup config field for the platform switch and no per-member switch
   now; PG settings at both levels match the decision, and both can be added later without a
   format change.

## AGENTS.md rules touched

- **Multi-replica discipline.** Deferred work is a BullMQ job with a deterministic id
  (`suggest-<runId>`, queue `cap-kernel-suggestions`, no `:`), consumed only under `WorkerModule`;
  the only shared state is a Redis key with a TTL; no in-process state; the enqueue is a
  harmless-to-lose hint after commit (no outbox), the usage write its own transaction; no lock is
  taken, none inside a transaction.
- **Runtime and replay.** Nothing model-visible: no new model-visible input, so no `DriftReason`;
  the side request reuses `assembleModelRequest` / `reconstructRequest` and never writes a
  `model_call`; zero-drift tests run before and after.
- **Extensions / hooks.** The new kernel model call fires `model.request` (policy fail closed,
  then observe) and `model.response` with `purpose: "suggestion"`.
- **Model providers.** No retries inside the extension (and none in the kernel for this call); the
  run's own model only; `ModelRequest.purpose` stays informational.
- **SDK public API.** `ModelCallPurpose` gains `"suggestion"`: `pnpm gen:sdk-api` and a changeset
  bumping `@capybara-hq/plugin-sdk`.
- **Platform tool.** No route added or removed; the new settings fields join the shared patch
  schemas, so the existing operations cover them (`check:platform-ops`, parity test); descriptions
  updated.
- **Config.** Not touched: no `KernelConfigSchema` field (platform switch in `deployment_settings`).
- **Web UI.** The composer change lives in `packages/design`; `apps/web` passes data only; the
  touch button sits in the existing control row (no box in a box).
- **Language / i18n.** Model-facing instruction in English; UI copy in zh and en, zh says 智能体
  and 平台, never 企业 or the Latin word.
- **Tests.** New unit test file joins `unit-tests.json`; integration is one app per file; no
  container test (reason in Testing).
- No new AGENTS.md rule.

## Implementation notes (2026-11-19)

Where the implementation differs from the text above, the smallest change that keeps the intent:

1. **Eligibility types.** `suggestionEligible` takes the real `run_finished.reason` and
   `run_started.trigger` unions; trigger `message` (or absent) qualifies like any non-excluded one.
2. **Model check.** `buildSuggestionRequest` skips (`model_mismatch`) when the resolved `ModelInfo`
   is not the last call's model, so a wrong resolution can never produce a different prefix.
3. **Events after the final reply.** The extension is built from every event up to the terminal
   event, not cut at the final reply: a model-visible event after the reply fails the
   "exactly one appended assistant message" check (§2 row "only its usage and run_finished
   follow"); user messages past `absorbedUpToSeq` stay out as in the next real step.
4. **Never throws on a bad snapshot.** An `ApiError` from reconstruction (e.g. a corrupt
   permission record) is a `drift` skip. `reconstructRequest` is split into `reconstructInputs`
   and `reconstructFromInputs`, one path, unchanged behaviour (zero-drift tests 42/42).
5. **`cleanSuggestion`.** Cuts at 200 code points; `NONE` with trailing punctuation (`.`, `!`,
   `。`, `！`) is none; one balanced pair of wrapping quotes from a fixed set is removed.
6. **Double runs.** `removeOnComplete` frees the job id, so `maybeEnqueue` and the job also skip
   when the run's `usage_suggestion:<runId>` event already exists (no second paid call).
7. **Freshness** requires the latest run's status `completed` (every `run_finished` sets it; failed
   and aborted runs never qualify anyway).
8. **Compaction reserve and media.** The job uses a pure `resolveCompactionSettings` shared with
   `CompactionSettingsService` and loads media through `AttachmentsService` as `RunSteps` does
   (importing those services' modules would be a module cycle).
9. **Usage on a failed call** (differs from "as titles do"): no usage is logged when the
   `ModelError` kind shows the vendor refused before processing (`rate_limited`, `overloaded`,
   `auth`, `invalid_request`, `context_overflow`): a suggestion's estimate is the whole
   conversation at full price and would overstate cost. Other failures log the input estimate
   plus streamed characters / 4 as output, like the purpose calls.
10. **`model.response` on a timeout.** Observe hooks run on the worker's lifecycle signal, not the
    call's 60 s signal, so a timed-out call still fires `model.response` (outcome failed); a
    shutdown fires none. The same latent bug in the title call is fixed with it. A test seam
    `PROMPT_SUGGESTION_TIMEOUT` lowers the timeout in tests.
11. **Design.** A new `corner-down-left` icon; a reference-only `referenceTouch` prop draws the
    touch button in the reference set and the `/dev/ui` catalog (desktop renderers have no touch
    pointer). Any paste or ＋ attach click while the suggestion shows dismisses it.
12. **Web.** The reader's rule matches the latest `run_finished`'s run id (and hides on any
    `user_message` / `run_started` above `afterSeq`); any draft edit while a suggestion is offered
    dismisses it for that run; each settings page has its own section next to compaction (neither
    page has a shared conversation group). Switching back on writes `null` (follow the default).
13. **Tests.** The integration-test cases are split between `prompt-suggestion-job.test.ts` (the
    job: hooks, fail-closed policy, usage, timeout, billing) and `prompt-suggestions.test.ts`
    (end to end through HTTP and SSE: exclusions, freshness race, NONE / tool / failure replies);
    the channel case sets `conversations.source` directly since eligibility reads only that.
14. **Delivery details.** An SSE open deletes a stale key with a compare-and-delete (only while the
    key still holds the suggestion it read, so a newer one written meanwhile is kept). A live
    `prompt_suggestion` bus frame is forwarded without re-reading the switch (the job checked it
    just before writing; a frame racing a switch-off is harmless). `maybeEnqueue` checks the
    outcome, the conversation kind and source; the trigger (`schedule`, `compact`) is checked by
    the job, so a scheduled run on a web conversation costs one skipped job and no model call.
15. **Existing tests.** Suggestions stay on by default in tests, as titles do; tests that count
    usage events, `usage.report` deliveries or model hook calls on web chats exclude
    `purpose: "suggestion"` (as they already exclude `title`).
