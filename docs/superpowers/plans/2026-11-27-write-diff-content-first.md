# Plan: live `Write` diff for models that stream `content` first

Spec: `docs/superpowers/specs/2026-11-27-write-diff-content-first-design.md` (approved 2026-11-27).
Issue #929. One core PR on branch `docs/929-write-diff-content-first`.

## Wire format (fixed before the waves; kernel and web both build on it)

- `tool_base` delta (bus, SSE, draft): `{ callId, text, sha256, guess?: { path } }`.
- New delta `tool_base_verdict`: `{ callId, confirmed: boolean }` (bus and SSE; no offset).
- Draft tool `base?: { text, sha256, guess?: { path }, verdict?: "confirmed" | "rejected" }`. The
  draft keeps a rejected guess marked (not deleted) so a lagging draft read never brings it back.
- Base merge rule (kernel draft and web, one function each side), `next = mergeBase(prev, got)`:
  - no `prev`: `got`;
  - `prev` a guess not confirmed and `got` has no `guess`: `got` (the exact base is only read
    after a rejection; widened from "rejected" during wave 1 for a viewer that missed the verdict);
  - same base (`sha256` and `guess.path` equal) and `prev` has no verdict: `prev` with `got`'s
    verdict;
  - otherwise `prev`.
- A verdict applies only to a base with a `guess` and no verdict yet; with no base it is dropped
  (the draft carries both to a viewer that missed the base).
- Display: a base is usable for the diff when it has no `guess`, or `verdict === "confirmed"`, or
  (guess, no verdict) while streaming (shown as a guess). A rejected base is never drawn. Only an
  exact or confirmed base is remembered for the logged row (`rememberBase` / `loggedLiveView`).

## Wave 1 (parallel, disjoint files)

### K: kernel (main session)

1. `write-base.ts`: `WriteCallScan` (pure): per call, feeds fragments to the path scanner and a new
   prefix scanner of the `content` property (`TopLevelStringPrefix`: the open string's decoded
   text so far, capped at `GUESS_PREFIX_LINES` complete lines); reports `order`
   (`path_first` / `content_first`), the closed path, the content prefix lines and whether the
   content string closed. `chooseGuess(prefixLines, candidates)`: score and margin rule.
   Unit tests: every cut of escaped inputs, the score rule.
2. `EventLog.recentFilePaths(conversationId, limit)`: distinct `view.file.path` of the newest
   `tool_result`s, newest first. Each candidate is then read with the existing `readWriteBase`
   (its latest state is the recorded state it checks).
3. `writeBaseWatcher`: guess mode (candidate reads at content start, choose at 8 lines / content
   closed / path closed, emit guessed base), the synchronous verdict at path close (normalized as
   `readWriteBase` does), the exact read after a rejection, one `write input order` info log per
   builtin `Write` call at `settle` (provider and model passed in). Unit tests in
   `write-base.test.ts`.
4. Sink, bus, drafts: `StreamSink` `tool_base` with `guess`, new kind `tool_base_verdict`;
   `ConversationBusMessage` delta; `streamSink` publish; `RunDrafts.setToolBase` with the merge
   rule, `RunDrafts.setToolBaseVerdict`, `parseTool` reads `guess` / `verdict`. Unit tests next to
   the existing ones.
5. `Write` definition: the `file_path` sentence; update any test pinning it.
6. Integration: model-fake streams a content-first `Write` over a file read earlier: SSE has the
   guessed `tool_base` then `tool_base_verdict confirmed`; a new file gets no guess; the draft frame
   carries both. Extend `packages/kernel/test/runtime/write-base.test.ts` /
   `stream.http.test.ts` as fits.

### W: web and design (one subagent)

1. Design: `ToolRowData.keyArgGuess?: boolean`; `ToolLabel` renders the preview as
   `<span class="cb-muted" data-part="key-arg-guess">推测：</span>` + the key arg (i18n
   `tool.keyArgGuess` zh 「推测：」, en "Guess: "); no new CSS; design spec §6.16.9 text; jsdom test;
   the catalog / reference entry as `writing-web-ui` requires.
2. Web `run-drafts.ts` / `stream.ts` / `live-drafts.ts`: the types, `mergeBase`, the verdict delta
   in `applyToolDelta`, `mergeTools`, live drafts' pass-through and gap logic. Tests in
   `apps/web/test/stream.test.ts` and the live-drafts tests.
3. `streaming-tool-view.ts`: a guessed base draws the live diff without `added` / `removed`, and
   returns `keyArg` = guess path with `keyArgGuess` until the verdict; a rejected base is the
   writing form. `timeline.ts`: pass `keyArgGuess` to the row; `rememberBase` only exact or
   confirmed. Tests.

## Wave 2 (main session)

- Review the subagent's diff against the wire format; run `pnpm verify --fast` and the changed
  tests; changesets (`@capybara-hq/kernel`, `@capybara-hq/web` if versioned, `@capybara-hq/design`
  if published); update the spec where the implementation settled a detail (the rejected marker);
  commit, push, mark the PR ready.
