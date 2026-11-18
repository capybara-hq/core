# Prompt suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development, layered
> with the repo's `wave-planned-subagent-development` skill (wave table below), to implement this
> plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After a completed web chat run, the composer shows the person's likely next message as
its placeholder; Tab fills it. The suggestion comes from one side request to the run's own model
whose prefix is byte-identical to the run's last request, so the prompt cache serves its input.

**Architecture:** `RunWorker.completed()` enqueues `suggest-<runId>` on `cap-kernel-suggestions`
(a hint, like titles). The worker-role job rebuilds the run's last request through the eval
zero-drift path (`takeSnapshot` + `reconstructRequest`), extends it with the final assistant
message and an English instruction, keeps `system` / `tools` / `params` / `toolChoice` unchanged,
lowers only the output cap, fires the model hooks (`purpose: "suggestion"`), calls the model once,
logs a run-less `usage` event, and stores the cleaned text in a Redis key (24 h TTL) plus a bus
message that the SSE forwards as `event: suggestion`. The design `ComposerBox` renders it as the
placeholder with Tab / Esc / a touch button; the web passes it from `useConversation`. Platform
(`deployment_settings.promptSuggestions`) and org (`orgs.settings.promptSuggestions`) switches,
default on.

**Tech Stack:** TypeScript, NestJS + BullMQ + ioredis + Kysely (kernel), React 19 / Next 16
(apps/web), plain CSS in `packages/design`, Vitest (unit, integration with test containers,
jsdom).

**Spec:** `docs/superpowers/specs/2026-11-19-prompt-suggestions-design.md`. Open questions decided
as recommended unless the maintainer rules otherwise: the touch button ships; API-created `web`
conversations are not excluded; no startup config field and no member switch.

## Global Constraints

- Constants (export them from `packages/kernel/src/conversations/prompt-suggestion-request.ts`
  unless noted): `PROMPT_SUGGESTION_INSTRUCTION` (the spec §1.3 text, verbatim),
  `PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS = 2048`, `PROMPT_SUGGESTION_UNCACHED_INPUT_MAX = 8000`,
  `PROMPT_SUGGESTION_MAX_DELAY_MS = 60_000`, `PROMPT_SUGGESTION_TIMEOUT_MS = 60_000`,
  `PROMPT_SUGGESTION_MAX_CHARS = 200`; in `prompt-suggestion-store.ts`:
  `PROMPT_SUGGESTION_TTL_SECONDS = 86_400`, `promptSuggestionKey(id) =
  "capk:prompt-suggestion:" + id`; in `prompt-suggestions.ts`: `PROMPT_SUGGESTION_QUEUE =
  "cap-kernel-suggestions"`, `promptSuggestionJobId(runId) = "suggest-" + runId`,
  `PROMPT_SUGGESTION_CONCURRENCY = 4`.
- The side request differs from the reconstructed last request **only** in: two appended messages
  (the final `assistant_message`, then one `user` text message with the instruction),
  `maxOutputTokens = min(recorded, 2048)` and `purpose: "suggestion"`. Never change `system`,
  `tools`, `params` or `toolChoice` (Anthropic invalidates the messages cache on a `tool_choice`,
  thinking or effort change). Anything else: skip.
- No retries, no fallback model, no error shown to anyone, no model-visible event, no
  `model_call`, no lock, no transaction around the call. Usage: `usage` event, `purpose:
  "suggestion"`, `step` 0, no run, `idemKey` `usage_suggestion:<runId>`, with `oweEvents`.
- Hooks: `model.request` (policy, fail closed, then observe) and `model.response` (observe) with
  `purpose: "suggestion"`, `runId` = the run, `step` 0, `attempt` 1; a denial writes a `hook.denied`
  audit row with `detail.purpose: "suggestion"` and no `hook_denied` event.
- Never log the suggestion text; log token counts only.
- Copy: design i18n `composer.suggestion.hint` 按 Tab 使用建议 / Press Tab to use the suggestion;
  `composer.suggestion.use` 使用建议 / Use suggestion; `composer.suggestion.useNamed` 使用建议：{text} /
  Use suggestion: {text}. Web settings: 输入建议 / Prompt suggestions, the spec §6 description, and
  平台已关闭 / Turned off by the platform. zh never says 企业 or the Latin word for agent (智能体).
- English for comments (`pnpm check:english-comments --base origin/main`). Run single tests from the
  worktree root: `pnpm exec vitest run <path>`.
- Each task adds its own changeset file (distinct file names) for the packages it changes.

## Review Focus

1. **Prefix identity.** The side request's first `n` messages, `system`, `tools`, `params` and
   `toolChoice` deep-equal the reconstructed last request; any drift, fit plan or mismatch skips.
   (Task 2 tests "equals the last request plus two messages", "keeps toolChoice none after a
   wrap-up", "skips on drift / fit / mismatch".)
2. **Freshness.** A message sent while the call is in flight never leaves a suggestion that a
   client shows or an SSE open sends. (Task 7 test "a message during the side call".)
3. **Fail closed hooks.** A policy hook that denies, or a policy extension not loaded, means no
   call and an audit row. (Task 5 / Task 7 "policy denial".)
4. **Exclusions.** No enqueue or no call for channel, sub-agent, eval, scheduled, compact, failed,
   aborted, waiting, `max_duration` runs and switched-off orgs or platform. (Task 2 eligibility
   unit tests, Task 7 integration.)
5. **Tab does not trap focus.** Tab is intercepted only with an empty draft and a visible
   suggestion; Shift+Tab never. (Task 4 tests.)

---

## Wave plan (for the ledger)

| Task | Depends on (interfaces) | Files / areas | Risk | Wave | Review |
|---|---|---|---|---|---|
| 1 SDK purpose and model-fake | — | `packages/plugin-sdk/src/hooks.ts`, `model.ts`, generated SDK API, `plugins/model-fake/src/script.ts` + its test, changesets | normal | 1 | batched |
| 2 Request builder, eligibility, cleaning | — (uses `purpose` as a string until Task 1 lands; see Task 2) | new `packages/kernel/src/conversations/prompt-suggestion-request.ts`, new unit test, `packages/kernel/test/unit-tests.json` | normal (judgment-heavy: most capable implementer) | 1 | alone, most capable |
| 3 Settings (platform + org) | — | `identity/settings.ts`, `orgs/settings.service.ts`, `platform/ops/org-settings.ops.ts`, `platform/ops/admin.ops.ts`, existing settings integration tests | normal | 1 | batched |
| 4 Design composer and spec | — | `packages/design/src/conversation/composer.tsx`, design CSS, design i18n, new design test, `docs/design/spec.md` | normal | 1 | batched |
| 5 Store, queue, job, run hook, usage | 1 (`"suggestion"` purpose), 2 (builder API), 3 (`effectivePromptSuggestions`, readers) | new `conversations/prompt-suggestion-store.ts`, new `conversations/prompt-suggestions.ts`, `runtime/run-worker.ts`, `runtime/run-processors.ts`, `roles/worker-role.ts`, `lifecycle/kernel-lifecycle.ts`, `conversations/events.ts`, `runtime/usage-report.ts`, `evals/trajectory.ts`, admin queue health if it lists queues | **high** (multi-replica, fail-closed hooks, billing) | 2 | alone, most capable |
| 6 SSE delivery | 3 (readers), 5 (store API) | `conversations/event-log.ts`, `runtime/stream.ts`, stream unit/integration test | normal | 3 | batched |
| 7 Kernel integration tests | 5, 6 | new `packages/kernel/test/conversations/prompt-suggestions.test.ts` | normal | 4 | batched |
| 8 Web wiring and settings UI | 3 (API fields), 4 (`suggestion` prop), 6 (`event: suggestion`) | `apps/web/src/lib/stream.ts`, `lib/conversations.ts`, `lib/org-settings.ts`, `lib/admin.ts`, `components/conversation/useConversation.ts`, `ConversationView.tsx`, `ComposerBar.tsx`, both settings views, web messages, `/dev/ui` catalog, web tests | normal | 4 | batched |
| 9 Verify and baselines | 1–8 | `pnpm verify`, `visual-update` / `reference-update` workflows (controller) | normal | 5 | controller |

Task 5 owns `prompt-suggestion-store.ts` and Task 6 only imports it, so Task 6 waits for Task 5
(wave 3). Tasks 7 and 8 have disjoint files (kernel test vs web) and run together. Only Task 2 edits
`unit-tests.json`; Task 3 tests through the existing settings integration test files.

---

### Task 1: SDK purpose and model-fake

**Files:**
- Modify: `packages/plugin-sdk/src/hooks.ts` (`ModelCallPurpose`, the doc comments of
  `ModelCallPurpose`, `ModelCallRequestHookPayload`, `ModelRequestHookPayload`,
  `ModelResponseHookPayload`)
- Modify: `packages/plugin-sdk/src/model.ts` (`ModelRequest.purpose` doc)
- Regenerate: the SDK API report (`pnpm gen:sdk-api`)
- Modify: `plugins/model-fake/src/script.ts` and its test
- Create: `.changeset/prompt-suggestions-sdk.md` (`@capybara-hq/plugin-sdk` patch),
  `.changeset/prompt-suggestions-model-fake.md` (`@capybara-hq/plugin-model-fake` patch; check the
  package name in `plugins/model-fake/package.json`)

**Interfaces:**
- Produces: `ModelCallPurpose` includes `"suggestion"`; `UsagePurpose` follows.
- Produces (model-fake): with `req.purpose === "suggestion"` the reply is
  `Suggestion: <first 40 chars of the earliest user text>`; a user message `suggest:<text>` earlier
  in the conversation makes the suggestion reply exactly `<text>` (so tests can script `NONE`, a
  long text, or `tool:` to produce a tool call); `suggest-fail:<kind>` fails the suggestion call
  with that `ModelError` kind. The main run's replies to these lines are unchanged (`You said: …`).

- [ ] **Step 1:** Add `"suggestion"` to `ModelCallPurpose`; document it: "`suggestion` is the
  prompt suggestion side request after a completed web run (`runId` the run, `step` 0, `attempt`
  1; a denial skips it and is recorded only in the audit log)".
- [ ] **Step 2:** `pnpm gen:sdk-api`; check `pnpm check:sdk-api` and `check:sdk-api-changeset`.
- [ ] **Step 3:** model-fake: write the failing test for the three script behaviours, then
  implement them next to the `compaction` branch in `scripted()`. The `suggest:` lookup scans all
  user messages (the instruction is the last one).
- [ ] **Step 4:** `pnpm exec vitest run plugins/model-fake` and `pnpm typecheck`.
- [ ] **Step 5: Commit** `feat(plugin-sdk): add the suggestion model call purpose` (body lists
  model-fake's script lines).

---

### Task 2: Request builder, eligibility and cleaning (pure)

Everything here is a pure function over a snapshot, events and settings, so it is unit-tested
without a database.

**Files:**
- Create: `packages/kernel/src/conversations/prompt-suggestion-request.ts`
- Create: `packages/kernel/test/conversations/prompt-suggestion-request.test.ts`
- Modify: `packages/kernel/test/unit-tests.json` (add the file)

**Interfaces (produced, consumed by Task 5):**

```ts
export type SuggestionSkip =
  | "no_model_call" | "no_final_reply" | "final_reply_has_tool_call" | "drift" | "fit"
  | "prefix_mismatch" | "too_large" | "uncached";

/** The side request, or why there is none. `model` is the info the caller resolved. */
export function buildSuggestionRequest(input: {
  snapshot: CaseSnapshot;
  model: ModelInfo;
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
  media?: ReadonlyMap<string, MediaBytes | null>;
  reserveTokens: number;
}): { request: ModelRequest; lastCall: { seq: number; provider: string; model: string };
      finalText: string; estimate: number } | { skip: SuggestionSkip };

/** The run's last model_call (highest seq with the run's id), or undefined. */
export function lastModelCallOf(events: readonly ConversationEvent[], runId: string):
  Extract<ConversationEvent, { type: "model_call" }> | undefined;

export interface SuggestionEligibilityInput {
  outcome: "completed" | "max_steps" | "max_duration" | "budget";
  kind: "chat" | "eval" | "subagent";
  source: ConversationSource;
  trigger: "background_task" | "subagent" | "schedule" | "compact" | undefined;
}
export function suggestionEligible(i: SuggestionEligibilityInput): boolean;

export function cleanSuggestion(reply: string, finalText: string): string | null;

/** Whether the job is too late (`now - finishedAt > PROMPT_SUGGESTION_MAX_DELAY_MS`). */
export function suggestionStale(finishedAt: number, now: number): boolean;
```

`buildSuggestionRequest` steps (spec §1): find the last `model_call` of `snapshot.runId`; skip
`fit` when its `request.fit` is set; find the run's last `assistant_message` after it (skip
`no_final_reply` when absent or without text, `final_reply_has_tool_call` when it has a
`tool_call` block); skip `uncached` when the run's last step-`usage` (no `purpose`) has
`cacheReadTokens + cacheWriteTokens === 0` and `inputTokens > 8000`;
`reconstructRequest(snapshot, call.seq, { model, mediaInfo, media })`, skip `drift` when
`drift.length > 0`; build the extension with `assembleModelRequest` from the same inputs
reconstruct used (export a small helper from `evals/reconstruct.ts` only if needed, e.g.
`reconstructInputs(snapshot, seq, opts)` returning the `AssembleModelRequestInput`, and keep
`reconstructRequest` calling it so there is one path) with the events cut at the final
`assistant_message`'s seq; skip `prefix_mismatch` unless `system`, `tools`, `toolChoice`,
`params` deep-equal and the reference's messages are a deep-equal prefix followed by exactly one
`assistant` message; append `{ role: "user", content: [{ type: "text", text:
PROMPT_SUGGESTION_INSTRUCTION }] }`; set `maxOutputTokens` and `purpose` (`"suggestion"`; until
Task 1 lands cast through `ModelRequest["purpose"]`, and remove the cast in Task 5); skip
`too_large` when `estimateTokens(...) + maxOutputTokens > model.contextWindow - reserveTokens`.

- [ ] **Step 1: Fixtures.** Build log fixtures with the helpers `reconstruct.test.ts` uses: a
  two-step run (tool call, tool result, final text), a `max_steps` wrap-up run (recorded
  `toolChoice: "none"` and the wrap-up reminder), a run with a fit plan, a run whose final message
  has a tool call, a run whose last usage shows no cache activity.
- [ ] **Step 2: Failing tests** for: "equals the last request plus two messages" (deep-equal
  `system`, `tools`, `params`, `toolChoice`, message prefix; the two appended messages; cap
  `min(recorded, 2048)`; `purpose`), "keeps toolChoice none after a wrap-up", "toolChoice stays
  absent on an ordinary run", "skips on drift" (change the snapshot's definition → `system_hash`),
  "skips on a fit plan", "skips on a final tool call", "skips uncached large input", "skips too
  large"; eligibility rows (each row of spec §2's first four lines); `cleanSuggestion` (`NONE`,
  ` none `, quotes, `User:` / `用户：`, control and bidi characters, 200-char cut on a surrogate
  pair, echo of `finalText`, multi-line takes the first non-empty line); `suggestionStale`.
- [ ] **Step 3: Implement** until green; `pnpm exec vitest run
  packages/kernel/test/conversations/prompt-suggestion-request.test.ts` and `pnpm test:unit`.
- [ ] **Step 4: Replay invariant.** `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts`
  (before and after, unchanged).
- [ ] **Step 5: Commit** `feat(kernel): build the prompt suggestion side request`.

---

### Task 3: Settings (platform and org)

**Files:**
- Modify: `packages/kernel/src/identity/settings.ts` (key `PROMPT_SUGGESTIONS_SETTING =
  "promptSuggestions"`, `DEPLOYMENT_SETTINGS_PATCH.promptSuggestions`, the write path next to
  `externalSharing`, the deployment settings view, `readPromptSuggestions(db, log?)`)
- Modify: `packages/kernel/src/orgs/settings.service.ts` (`OrgSettingsSchema.promptSuggestions`,
  `OrgSettingsPatchSchema.promptSuggestions`, `effectivePromptSuggestions(platform, org)`, null
  clears, the org settings `deployment` view gains `promptSuggestions`)
- Modify: `packages/kernel/src/platform/ops/org-settings.ops.ts`, `platform/ops/admin.ops.ts`
  (descriptions only)
- Modify: the existing settings integration tests (find them with
  `git grep -l "externalSharing" packages/kernel/test`), add cases there
- Create: `.changeset/prompt-suggestions-settings.md` (`@capybara-hq/kernel` patch)

**Interfaces (produced):**
- `readPromptSuggestions(db, log?): Promise<"on" | "off">` (absent → `on`, invalid → `off` with a
  warning), `effectivePromptSuggestions(platform: "on" | "off", org: "on" | "off" | undefined):
  boolean`, and a convenience `OrgSettingsService.promptSuggestionsEnabled(orgId): Promise<boolean>`
  (one read of each; used by Tasks 5 and 6).
- HTTP: `PATCH /api/v1/orgs/:orgId/settings` and the admin settings PATCH accept
  `promptSuggestions: "on" | "off" | null`; the GETs return the effective inputs.

- [ ] **Step 1: Failing tests** (integration, existing files): platform absent reads on; set off;
  null clears; invalid stored value reads off with a warning; org absent follows; org off; org on
  under platform off stays effectively off; `org-settings.update` and `admin.update-settings`
  through the Platform tool accept the field both ways.
- [ ] **Step 2: Implement.** Follow `externalSharing` for the platform key and `toolSearch` for the
  org field (both directions allowed through the Platform tool, no narrowing rule). Update the four
  operation descriptions: "promptSuggestions (on or off, absent meaning on: whether the composer
  suggests the person's next message after a completed run; the deployment's promptSuggestions must
  be on too)".
- [ ] **Step 3:** `pnpm exec vitest run <the settings test files>`,
  `pnpm exec vitest run packages/kernel/test/platform/platform-parity.test.ts` (path per
  `git grep -l platform-parity`), `pnpm check:platform-ops`, `pnpm typecheck`.
- [ ] **Step 4: Commit** `feat(kernel): platform and org switches for prompt suggestions`.

---

### Task 4: Design composer and spec

**Files:**
- Modify: `packages/design/src/conversation/composer.tsx` (`ComposerBoxProps.suggestion`)
- Modify: the composer CSS in `packages/design` (the touch button only; follow the existing
  `cb-composer-bar` rules)
- Modify: design i18n (zh, en) for the three `composer.suggestion.*` keys
- Create: `packages/design/test/composer-suggestion.test.tsx`
- Modify: `docs/design/spec.md` §6.16.2 (state `suggestion`, behaviour, size row for the touch
  button) and §6.11 (keys)
- Create: `.changeset/prompt-suggestions-design.md` (`@capybara-hq/design` patch)

**Interfaces (produced, consumed by Task 8):**

```ts
suggestion?: {
  text: string;
  /** Esc, typing, paste or attaching ended it for this run; the caller stops passing it. */
  onDismiss(): void;
};
```

Behaviour (spec §5): placeholder = `suggestion.text` when `value === ""`, no `token`, no `hint`;
Tab (no modifier, `!isComposing`, `value === ""`, suggestion shown) → `preventDefault`,
`onChange(text)`, caret to end on the next frame, `onDismiss()`; Esc while shown → `onDismiss()`;
a change to a non-empty value while a suggestion is passed → `onDismiss()`; textarea
`aria-describedby` a `cb-sr-only` hint while shown; with `isTouchPointer()` a ghost `control.dense`
button `composer-suggestion-use` (`corner-down-left` 14, label `composer.suggestion.use`,
accessible name `composer.suggestion.useNamed`) before the flexible space's send, filling the draft
without focusing the textarea. No new box (`findNestedBoxes` clean); `data-part` names are
`composer-suggestion-hint` and `composer-suggestion-use`.

- [ ] **Step 1: Spec first** (writing-web-ui "Adding a component"): §6.16.2 bullet "**Suggestion**
  (state `suggestion`)" with the behaviour above; add `suggestion` to `States:`; size row
  `| composer-suggestion-use | suggestion | height | control.dense |`; placeholders line: "a prompt
  suggestion replaces the idle placeholder"; §6.11: "Tab in an empty composer that shows a
  suggestion fills it; Esc dismisses it; elsewhere Tab moves focus".
- [ ] **Step 2: Failing tests:** placeholder only when empty, idle and no chip; the running hint
  wins; Tab fills and calls `onDismiss`; Tab with text or without a suggestion is not prevented;
  Shift+Tab never; Esc; typing calls `onDismiss`; IME composition is ignored; the touch button
  (mock `isTouchPointer`); `aria-describedby`; `findNestedBoxes(container)` is empty.
- [ ] **Step 3: Implement**, then `pnpm exec vitest run packages/design/test/composer-suggestion.test.tsx
  packages/design/test/composer.test.tsx packages/design/test/composer-phone.test.tsx`,
  `pnpm check:web-ui`, `pnpm check:i18n`.
- [ ] **Step 4: Commit** `feat(design): prompt suggestion in the composer`.

---

### Task 5: Store, queue, job, run hook and usage (high risk)

**Files:**
- Create: `packages/kernel/src/conversations/prompt-suggestion-store.ts`
- Create: `packages/kernel/src/conversations/prompt-suggestions.ts`
- Modify: `packages/kernel/src/runtime/run-worker.ts` (`completed(conversationId, runId, kind)`;
  both call sites; inject `PromptSuggestionQueue` as `Pick<…, "maybeEnqueue">`)
- Modify: `packages/kernel/src/runtime/run-processors.ts` (processor for
  `PROMPT_SUGGESTION_QUEUE`, `configuredProcessor` with concurrency 4),
  `packages/kernel/src/roles/worker-role.ts`, `packages/kernel/src/lifecycle/kernel-lifecycle.ts`
  (start / stop like `TitleQueue`), the module that imports `TitlesModule` for the run worker
- Modify: `packages/kernel/src/conversations/events.ts` (usage `purpose` enum + doc),
  `packages/kernel/src/runtime/usage-report.ts` (payload `purpose` type + doc),
  `packages/kernel/src/evals/trajectory.ts` (only if it enumerates purposes), the admin queue
  health list if it enumerates queues (`git grep -n TITLE_QUEUE packages/kernel/src`)
- Create: `.changeset/prompt-suggestions-kernel.md` (`@capybara-hq/kernel` patch)

**Interfaces:**
- Consumes: Task 1 `"suggestion"`; Task 2 `buildSuggestionRequest`, `suggestionEligible`,
  `cleanSuggestion`, `suggestionStale`, `lastModelCallOf`; Task 3
  `OrgSettingsService.promptSuggestionsEnabled`.
- Produces (store, consumed by Task 6):

```ts
export interface StoredSuggestion { runId: string; afterSeq: number; text: string; createdAt: number }
export const PROMPT_SUGGESTION_BUS_KIND = "prompt_suggestion";
@Injectable() export class PromptSuggestionStore {
  /** SET EX TTL, then publish { kind, conversationId, runId, afterSeq, text } on the topic. */
  put(conversationId: string, s: StoredSuggestion): Promise<void>;
  get(conversationId: string): Promise<StoredSuggestion | null>;
  delete(conversationId: string): Promise<void>;
  /**
   * The freshness rule (spec §4), read from PG: `runId` is the conversation's latest run, it is
   * terminal, no `user_message` / `run_started` with seq > afterSeq, the queue is empty.
   */
  isFresh(conversationId: string, s: Pick<StoredSuggestion, "runId" | "afterSeq">): Promise<boolean>;
}
```

- Produces: `PromptSuggestionQueue.maybeEnqueue(conversationId, runId, kind): Promise<void>`
  (never throws), `PromptSuggestionGenerator.run(conversationId, runId, finishedAt, signal)`.

Job (`PromptSuggestionGenerator.run`), in order, every early exit a debug log with the reason and
no throw:
1. `suggestionStale(finishedAt, now)`; conversation row (`kind`, `source`, `org_id`), the run's
   `run_started.trigger` and `run_finished` (seq, reason): `suggestionEligible`;
   `promptSuggestionsEnabled(orgId)`; `store.isFresh(conversationId, { runId, afterSeq })`.
2. `takeSnapshot(db, orgId, conversationId, runId, config.evals.maxCaseBytes)` (an
   `eval.case_too_large` error → skip); resolve the last call's model
   (`ProviderRegistry.resolve(orgId, { provider, model })`, any error → skip); load media with
   `loadSnapshotMedia` (unavailable → skip); the org's effective compaction `reserveTokens`
   (`CompactionSettingsService`); `buildSuggestionRequest`.
3. Hook scope from the run (`trigger_account_id`, `agent_id`, `agent_version`). `model.request`
   (`purpose: "suggestion"`, `runId`, `step` 0, `attempt` 1, `hookRequestOf(request)`); a denial →
   `hook.denied` audit row (`detail.purpose: "suggestion"`, like `checkTitleHooks`), stop.
4. `consumeModelStream(provider, request, info.streamIdleTimeoutMs ?? runtime.streamIdleMs,
   signal, () => {})` with `signal = AbortSignal.any([timeout(60s), shutdown])`; `model.response`
   observe after a sent call (not after a shutdown abort).
5. Usage: append the `usage` event (`purpose: "suggestion"`, `step` 0, no run, `idemKey`
   `usage_suggestion:<runId>`) with `oweEvents` in a `@Transactional({ propagation:
   "requires_new" })` method, then `eventLog.notify`. A sent call that failed logs its estimated
   input tokens (`PurposeAttemptError`-like fallback: the request's estimate), as titles do.
6. Result: discard on a `tool_call` block or `stopReason !== "end_turn"`; `cleanSuggestion`;
   `store.isFresh` again; `store.put`. One debug line with input / cache-read / cache-write /
   output tokens and the outcome, never the text.

- [ ] **Step 1: Failing integration test** in a new file
  `packages/kernel/test/conversations/prompt-suggestion-job.test.ts` (one app; model-fake):
  enqueue via a completed web run; assert one job id `suggest-<runId>`, the stored key, the usage
  event and its owed `usage.report`; a second `maybeEnqueue` for the same run is a no-op; a run
  with `max_duration` does not enqueue; a policy hook that denies (`HookRegistry` test seam as in
  `titles.test.ts`) → audit row, no call, no key.
- [ ] **Step 2: Implement** the store, the queue/processor wiring (copy the `TitleQueue` shape:
  `startWorker`, `process`, `stop`, `onError`), the generator and the run worker change.
- [ ] **Step 3:** `pnpm exec vitest run packages/kernel/test/conversations/prompt-suggestion-job.test.ts
  packages/kernel/test/conversations/titles.test.ts`, `pnpm check:kernel-conventions`,
  `pnpm typecheck`, and the zero-drift test.
- [ ] **Step 4: Commit** `feat(kernel): generate prompt suggestions after completed runs`.

Reviewer checklist for this task: no in-process state (the stop `AbortController` is lifecycle
only), the job id and queue name have no `:`, the processor is registered only under
`WorkerModule`, no lock, no transaction spans the call, the usage write owes its delivery, hooks
fail closed, nothing logs the text, `maybeEnqueue` cannot throw into the run worker.

---

### Task 6: SSE delivery

**Files:**
- Modify: `packages/kernel/src/conversations/event-log.ts` (`ConversationBusMessage` member
  `{ kind: "prompt_suggestion"; conversationId; runId; afterSeq; text }` and its doc)
- Modify: `packages/kernel/src/runtime/stream.ts` (`isBusMessage` validation, frame
  `event: suggestion` with `{ runId, afterSeq, text }`, and after the catch-up and live drafts:
  `store.get` → `isFresh` and `promptSuggestionsEnabled` → send, else `store.delete` when stale)
- Modify / create: the stream's existing test (`packages/kernel/test/runtime/stream.http.test.ts`) for the new frame and the open-time send

- [ ] **Step 1: Failing tests:** a published `prompt_suggestion` reaches an open stream as
  `event: suggestion`; a malformed one is dropped; an SSE opened with a fresh key gets the frame
  after the catch-up; with a stale key gets nothing and the key is deleted; with the org switch off
  gets nothing.
- [ ] **Step 2: Implement.** A failure reading the key or the settings is logged at warn and the
  stream continues (it is a convenience, like the live drafts).
- [ ] **Step 3:** run the stream tests; `pnpm typecheck`.
- [ ] **Step 4: Commit** `feat(kernel): send prompt suggestions on the conversation stream`.

---

### Task 7: Kernel integration tests (end to end)

**Files:**
- Create: `packages/kernel/test/conversations/prompt-suggestions.test.ts` (integration, one app)

- [ ] **Step 1: Cases** (spec Testing, integration list): the full happy path through SSE with the
  request recorded by a recording test model (`test/fixtures/plugins/model-eval`, as
  `titles.test.ts` uses it) asserting the last step request is an exact prefix and only the cap,
  `purpose` and two messages differ; exclusions (channel conversation via the fake IM helpers, a
  sub-agent, a scheduled run, a failed run, an aborted run, a run waiting for an approval, org off,
  platform off); a message during the side call (script a slow suggestion reply, post a message,
  assert the next SSE open sends nothing and the web rule would hide it); `suggest:NONE`,
  `suggest:tool:…`, `suggest-fail:server_error` → no suggestion, a usage event where the call was
  sent, no `run_failed`, no error frame.
- [ ] **Step 2:** `pnpm exec vitest run packages/kernel/test/conversations/prompt-suggestions.test.ts`;
  wait conditions only (`waitFor`), no sleeps or per-test timeouts.
- [ ] **Step 3: Commit** `test(kernel): prompt suggestions end to end`.

---

### Task 8: Web wiring and settings UI

**Files:**
- Modify: `apps/web/src/lib/stream.ts` (`PromptSuggestion` type, `onSuggestion` handler, listener
  for `event: suggestion`)
- Modify: `apps/web/src/components/conversation/useConversation.ts` (`suggestion` state; the
  reader's rule of spec §4 against the event list; cleared on conversation change)
- Modify: `apps/web/src/components/conversation/ConversationView.tsx`, `ComposerBar.tsx` (pass
  `suggestion`, track per-run dismissal; never on `NewConversation` or sub-agent composers)
- Modify: `apps/web/src/lib/conversations.ts` (usage purpose union), `lib/org-settings.ts`,
  `lib/admin.ts` (the new fields)
- Modify: `apps/web/src/app/(app)/settings/organization/view.tsx`,
  `apps/web/src/app/(app)/admin/settings/view.tsx` (one switch each, conversation group next to
  compaction; the org switch disabled with 平台已关闭 when the platform is off; `useAppMutation`)
- Modify: web messages (zh, en)
- Modify: `apps/web/src/dev/catalog/conversation-page-blocks.tsx` (composer `suggestion` state)
- Tests: `useConversation` rule tests and settings view tests next to the existing ones
- Create: `.changeset/prompt-suggestions-web.md` (`@capybara-hq/web` patch)

- [ ] **Step 1: Failing tests:** a suggestion frame shows in the composer; a later `user_message`
  or `run_started` hides it; a frame for an older run is ignored; a running run hides it; the
  dismissal sticks for that run; the org switch renders disabled under a platform off.
- [ ] **Step 2: Implement** (no styles in apps/web; queries via `defineQuery`, writes via
  `useAppMutation`).
- [ ] **Step 3:** web tests, `pnpm check:web-ui`, `pnpm check:i18n`, `pnpm typecheck`.
- [ ] **Step 4: Commit** `feat(web): show prompt suggestions in the conversation composer`.

---

### Task 9: Verify and baselines (controller)

- [ ] `pnpm verify` on the branch (full diff run).
- [ ] Trigger `reference-update` and `visual-update` for the composer `suggestion` state; review
  the rendered PNGs; never render baselines locally.
- [ ] Live check (optional, keys from the local env file only inside the command): one Anthropic
  and one DeepSeek conversation on a dev kernel; read the debug line and confirm `cacheReadTokens`
  covers most of the side request's input. Record the numbers in the PR, not the keys.
- [ ] Final whole-branch review on the most capable model; PR body lists the open-question
  rulings applied.
