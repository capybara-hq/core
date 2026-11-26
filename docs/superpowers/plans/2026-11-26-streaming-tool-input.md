# Streaming Tool Input Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. In this repository, layer `wave-planned-subagent-development` on top (the waves below).

**Goal:** Show a tool call in the conversation while the model writes its input (a live diff for `Edit`, and for `Write` over an existing file a live diff against a base the kernel reads), without executing anything early.

**Architecture:** Providers emit two optional stream events; the kernel forwards them raw through the run's `StreamSink` (bus deltas + Redis live drafts, never the event log) and, for a `Write` whose path has closed, does one display-only kernel read of the file the conversation already read. The web parses partial JSON, keeps tool drafts beside text drafts, and draws streaming rows with new design states that the logged rows replace in place by call id.

**Tech Stack:** TypeScript, NestJS kernel, Redis (bus + drafts), Next 16 web, `@capybara-hq/design`, vitest (unit / integration), Playwright (visual).

**Spec:** `docs/superpowers/specs/2026-11-26-streaming-tool-input-design.md` (PR #910). Read it first; section numbers below refer to it.

## Global Constraints

- Display only: nothing streamed reaches the event log, the model, hooks, the command review or approvals; execution starts from the logged `assistant_message` (D1). Zero-drift fixture tests stay unchanged.
- Event shapes exactly: `{ type: "tool_call_start"; id: string; name: string }`, `{ type: "tool_call_delta"; id: string; input: string }`.
- Bus delta kinds exactly: `"tool_start" | "tool_input" | "tool_base"` beside `"text" | "thinking" | "step_reset"`.
- `DRAFT_TOOL_INPUT_MAX = 512 * 1024` (UTF-8 bytes of tool input plus base per step's draft).
- Base: at most `TOOL_VIEW_DIFF_MAX_BYTES` read; not sent above `TOOL_VIEW_DIFF_MAX_TEXT_BYTES`; only when the log's `latestFileState` for the normalized path matches the bytes read (size and sha256).
- Kernel read `write_base`: run `running`, scope exactly one path, methods `stat` / `readFile`, never makes, wakes or resumes an instance, no path lease.
- Copy (design i18n, zh / en): 生成中 / Writing; 生成参数中 / Writing input; 后面 N 行待对齐 / N more lines not reached yet; 行号待定 / Line numbers after it runs; 写入预览 / Preview.
- English for code comments, identifiers, commit messages; Conventional Commits, body lines ≤ 100 chars; `Co-Authored-By: Capybara <noreply@capybarahq.com>`.
- New kernel unit tests join `packages/kernel/test/unit-tests.json`; integration is the default. No fixed sleeps, no per-test timeouts.
- SDK public API change: `pnpm gen:sdk-api` + a changeset bumping `@capybara-hq/plugin-sdk`.
- apps/web writes no styles; new visuals go through `packages/design` and design spec §6.16.9 / §6.16.10 (spec §10 process).

## Review Focus

1. **Parallel tool calls interleaving** (two calls streaming, fragments alternating, text between them): each row gets only its own fragments, offsets per call id. Tests: Task 3 (`streamSink` interleaved), Task 9 (`reduceChat` interleaved).
2. **Reconnect mid-call** (reload while a `Write` streams): the draft frame restores the row's input so far and its base, then deltas continue without duplication. Test: Task 7 integration, Task 9 (`draft` then deltas past offset).
3. **The final message disagrees with the stream** (a streamed id missing from `message_complete`, or a call that never streamed): the vanished row disappears, the unstreamed call appears as today. Test: Task 12.
4. **Huge `Write` content** (above `DRAFT_TOOL_INPUT_MAX`): publishing continues, the draft marks `inputTruncated`, the web shows the head and size, nothing crashes. Tests: Task 3 (cap), Task 12 (truncated row).
5. **The base is unavailable or stale** (device suspended, file changed since read, binary, path outside write roots, admission refused): no base, the row stays in the neutral writing form, the run is unaffected. Tests: Task 5 and Task 6.

---

## Waves

| Wave | Tasks | PR | Notes |
|---|---|---|---|
| 1 | 1 | core PR 1 | SDK contract first (everything consumes it) |
| 2 | 2, 3, 4, 5 | core PR 1 | disjoint files; **Task 5 is a trust-boundary change: reviewed alone on the most capable model** |
| 3 | 6, 7 | core PR 1 | 6 needs 3, 4, 5; 7 needs all of wave 2 and 6 |
| 4 | 8, 9, 10, 11 | core PR 2 | disjoint files (web libs, design package) |
| 5 | 12, 13 | core PR 2 | 12 needs 8–11; 13 after 11 and 12 |
| 6 | 14, 15, 16 | plugins PR | after core PR 1 is released (SDK rc); one plugin family each |

---

### Task 1: SDK stream events and `ToolSpec.inputView`

**Files:**
- Modify: `packages/plugin-sdk/src/model.ts` (`ModelStreamEvent`, ~line 365)
- Modify: `packages/plugin-sdk/src/tool.ts` (`ToolSpec` ~line 20, `validateToolPresentation` ~line 93)
- Modify: the SDK API report via `pnpm gen:sdk-api`; add `.changeset/streaming-tool-input-sdk.md` (minor bump of `@capybara-hq/plugin-sdk`)
- Test: `packages/plugin-sdk/test/tool.test.ts` (existing presentation tests)

**Interfaces:**
- Produces:
  ```ts
  // model.ts, added to the union
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; input: string }
  // tool.ts
  export type ToolInputView =
    | { kind: "file_write"; path: string; content: string }
    | { kind: "file_edit"; path: string; old: string; new: string }
    | { kind: "command"; command: string; description?: string }
    | { kind: "text"; field: string };
  // ToolSpec.inputView?: ToolInputView
  // validateToolPresentation(spec: Pick<ToolSpec, "title" | "keyArgs" | "inputView" | "inputSchema">): string[]
  ```
  Doc comments state the contract rules of spec §3 (start before deltas, interleaving allowed, parsed equality with `message_complete`, emitting nothing stays valid).

- [ ] **Step 1: Write failing tests** in `tool.test.ts`: `"inputView names string properties of inputSchema"` — a `file_write` view naming `file_path` / `content` (both `{ type: "string" }`) returns `[]`; naming a missing property returns `['inputView names "nope", which is not a string property of inputSchema']`; naming a `{ type: "number" }` property returns the same message; an unknown `kind` returns `["inputView kind must be one of file_write, file_edit, command, text"]`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/plugin-sdk/test/tool.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the types and the checks in `validateToolPresentation` (also strip Cc / Cf like `keyArgs` names).
- [ ] **Step 4: Run** the test — PASS; `pnpm gen:sdk-api`; `pnpm typecheck` — the kernel's exhaustive switches over `ModelStreamEvent` now fail to compile where they assume two delta kinds: leave those to Task 3 (note them), do not patch here.
- [ ] **Step 5: Commit** `feat(sdk): tool call stream events and ToolSpec.inputView`.

### Task 2: Conformance check and model-fake streaming

**Files:**
- Modify: `packages/testing/src/model-conformance.ts` (export the check; use it in `"tool round trip"`, ~line 177)
- Modify: `plugins/model-fake/src/script.ts` (`Plan` ~line 247, the tool branch ~line 601, directive parsing ~line 345–390)
- Test: `packages/testing/test/model-conformance.test.ts` (create if absent), `plugins/model-fake/test/model-fake.test.ts`

**Interfaces:**
- Consumes: Task 1 events.
- Produces:
  ```ts
  // model-conformance.ts
  export function checkToolStream(events: ModelStreamEvent[], done: Extract<ModelStreamEvent, { type: "message_complete" }>): string[];
  ```
  model-fake: every tool call streams `tool_call_start` then its `JSON.stringify(input)` in `CHUNK_CHARS` fragments (no delay); new directive `streamtool:<ms>:<name>:<json>` waits `<ms>` (via the injected `Sleep`) between fragments. Multi-call (`tools:[…]`) streams each call in order.

- [ ] **Step 1: Failing tests.** `checkToolStream`: returns `[]` for start + deltas whose join parses to the final input; returns `["tool_call_delta for unknown id call_x"]` for a delta before its start; `["streamed input of call_1 does not parse to the final input"]` on mismatch; `[]` for a stream with no tool events. model-fake: `"streams a tool call's input"` collects events for script `tool:Write:{"file_path":"/w/a.txt","content":"hi"}` and asserts the first tool event is `{ type: "tool_call_start", id: <final id>, name: "Write" }` and the deltas join to the JSON; `"streamtool waits between fragments"` with a fake `Sleep` records one call per fragment gap.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/testing plugins/model-fake` — FAIL.
- [ ] **Step 3: Implement.** In `"tool round trip"` add `expect(checkToolStream(events, done)).toEqual([])`. In model-fake compute ids before yielding (same hash as today) so start ids equal final ids.
- [ ] **Step 4: Run** the tests and `plugins/model-fake/test/conformance.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(testing): conformance check for streamed tool input; model-fake streams it`.

### Task 3: Kernel stream path (sink, bus, drafts, watchdog)

**Files:**
- Modify: `packages/kernel/src/runtime/model-call.ts` (`StreamSink` ~line 181, onDelta ~line 2013, `consumeModelStream` ~line 2304)
- Modify: `packages/kernel/src/evals/step-replay.ts:306`, `packages/kernel/src/models/purposes.ts:580`, `packages/kernel/src/conversations/prompt-suggestions.ts:262`, `packages/kernel/src/runtime/model-call.ts:1460` (char counting)
- Modify: `packages/kernel/src/conversations/event-log.ts` (`ConversationBusMessage` delta, ~line 82)
- Modify: `packages/kernel/src/runtime/run-drafts.ts` (draft shape, `streamSink` ~line 238)
- Modify: `packages/kernel/src/runtime/stream.controller.ts` (draft frame and `GET …/runs/:runId/draft` carry `tools`)
- Test: `packages/kernel/test/runtime/run-drafts.test.ts`, `packages/kernel/test/runtime/stream.http.test.ts`, new `packages/kernel/test/runtime/consume-model-stream.test.ts` (unit, add to `unit-tests.json`)

**Interfaces:**
- Consumes: Task 1 events.
- Produces:
  ```ts
  // model-call.ts
  export function deltaChars(ev: Exclude<ModelStreamEvent, { type: "message_complete" }>): number; // text / thinking length, input length, 0 for start
  export type StreamSink = (delta: {
    kind: "text" | "thinking" | "tool_start" | "tool_input" | "tool_base" | "step_reset" | "stream_end" | "step_end";
    runId: string; step: number;
    text?: string; callId?: string; name?: string; sha256?: string;
  }) => void;
  // event-log.ts ConversationBusMessage delta: delta adds "tool_start" | "tool_input" | "tool_base"; fields callId?, name?, sha256?
  // run-drafts.ts
  export const DRAFT_TOOL_INPUT_MAX = 512 * 1024;
  export interface DraftTool { id: string; name: string; input: string; inputTruncated?: true; base?: { text: string; sha256: string } }
  export interface RunDraft { step: number; text: string; thinking: string; tools: DraftTool[] }
  RunDrafts.startTool(runId: string, step: number, callId: string, name: string): void
  RunDrafts.appendToolInput(runId: string, step: number, callId: string, text: string): void
  RunDrafts.setToolBase(runId: string, step: number, callId: string, base: { text: string; sha256: string }): void
  ```
  Bus offsets: `tool_input` carries `offset` = characters of that call's input this attempt streamed before the delta (per call id); `tool_start` and `tool_base` carry none.

- [ ] **Step 1: Failing tests.**
  - `consume-model-stream.test.ts`: `"tool deltas keep the watchdog armed"` — a fake provider yields `tool_call_start` then 5 `tool_call_delta`s each 0.6 × `idleMs` apart (fake timers), then `message_complete`: resolves, `onDelta` saw 6 events; `"still times out when tool deltas stop"` — after 2 deltas it stalls: rejects with `ModelError` kind `timeout`.
  - `run-drafts.test.ts`: `"streamSink offsets tool input per call"` — interleaved `tool_input` for `a`,`b`,`a` publish offsets `0, 0, len(a1)`; `"step_reset clears tools"`; `"draft keeps tools and the base"` (read back after flush); `"tool input past DRAFT_TOOL_INPUT_MAX is published but marks inputTruncated"`.
  - `stream.http.test.ts`: `"draft frame carries tools"` — a run streaming a `streamtool:` call, a client connecting mid-call gets `event: draft` whose data has `tools[0].name === "Write"` and a non-empty `input`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/consume-model-stream.test.ts packages/kernel/test/runtime/run-drafts.test.ts packages/kernel/test/runtime/stream.http.test.ts` — FAIL.
- [ ] **Step 3: Implement.** onDelta at ~2013 maps by type (`text_delta` → `text`, `thinking_delta` → `thinking`, `tool_call_start` → `tool_start`, `tool_call_delta` → `tool_input`); the other four consumers count with `deltaChars`. `consumeModelStream` needs no change beyond types (it re-arms on every event): the test proves it.
- [ ] **Step 4: Run** the three tests, `pnpm test:unit`, and the zero-drift tests `pnpm exec vitest run packages/kernel/test/evals/reconstruct.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): forward streamed tool input through the sink and live drafts`.

### Task 4: Tool info `inputView` and builtin declarations

**Files:**
- Modify: `packages/kernel/src/tools/info.ts` (~line 45 / 74 / 179: add `inputView` beside `keyArgs`, `null` when absent)
- Modify: specs in `packages/kernel/src/tools/builtins/sandbox/write.ts`, `edit.ts`, `bash.ts`, `builtins/agent.ts`, `builtins/send-message.ts`, `builtins/image/generate.ts`
- Modify: `apps/web/src/lib/tool-info.ts` type (field `inputView: ToolInputView | null`, mirrored locally; `pnpm check:web-api-parity`)
- Test: the existing tool info test (`grep -rl "keyArgs" packages/kernel/test/tools`), plus `validateToolPresentation` passing for every builtin (existing builtin spec test)

**Interfaces:**
- Consumes: Task 1 `ToolInputView`.
- Produces declarations: `Write` `{ kind: "file_write", path: "file_path", content: "content" }`; `Edit` `{ kind: "file_edit", path: "file_path", old: "old_string", new: "new_string" }`; `Bash` `{ kind: "command", command: "command", description: "description" }`; `Agent` `{ kind: "text", field: "prompt" }`; `SendMessage` `{ kind: "text", field: "message" }`; `GenerateImage` `{ kind: "text", field: "prompt" }`. Tool info JSON: `inputView: ToolInputView | null`.

- [ ] **Step 1: Failing test** `"tool info returns inputView"`: `Write`'s info has the `file_write` view; a connector tool's is `null`.
- [ ] **Step 2: Run** it — FAIL.
- [ ] **Step 3: Implement** the field and the six declarations.
- [ ] **Step 4: Run** the test, `pnpm check:web-api-parity`, `pnpm typecheck` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): declare tool input views and return them in tool info`.

### Task 5: Kernel read purpose `write_base` (trust boundary)

**Files:**
- Modify: `packages/kernel/src/sandbox/kernel-read.ts` (`KernelReadInvocation`, `kernelReadRoot` → covering by purpose)
- Modify: `packages/kernel/src/sandbox/sandbox.service.ts` (`withKernelRead` ~line 1689, the `kernelRead` route ~line 1963, `kernelReadProvider` ~line 2184)
- Modify: `packages/kernel/src/sandbox/operation-intents.ts` (`admitKernelRead`, ~lines 429 / 506), `packages/kernel/src/sandbox/operation-authority.ts` (~line 501–553: scope by purpose)
- Test: `packages/kernel/test/sandbox/kernel-reads.test.ts`, `packages/kernel/test/sandbox/non-tool-callers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type KernelReadInvocation =
    | { claim: ExecutionClaim; purpose: "project_root"; root: string }
    | { claim: ExecutionClaim; purpose: "write_base"; path: string };
  export function kernelReadCovering(read: Pick-of-the-union, method: KernelReadMethod, path: string): string | null;
  // write_base: method "stat" | "readFile" and path === read.path (clean, absolute) → path; else null
  export class KernelReadInstanceNotRunning extends Error {} // write_base use on a device whose instance is not running: nothing made, woken or resumed
  ```
  `withKernelRead` admits `write_base` only for the run's current claim with the run `running` (project_root keeps `queued`); a `write_base` use never takes a path lease.

- [ ] **Step 1: Failing tests** (kernel-reads.test.ts): `"write_base reads exactly its path"` (readFile of the path succeeds; of a sibling path refused before dispatch; `list` refused); `"write_base needs a running run"` (a queued run's claim is refused with `KernelReadNotAdmitted`); `"write_base never wakes a suspended device"` (suspended instance → `KernelReadInstanceNotRunning`, the provider saw no resume / create); `"project_root admission unchanged"` (existing cases still pass). non-tool-callers.test.ts: the new purpose is reachable only through `withKernelRead` (no tool context, route or Platform operation).
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/sandbox/kernel-reads.test.ts packages/kernel/test/sandbox/non-tool-callers.test.ts` — FAIL.
- [ ] **Step 3: Implement** by purpose at each switch; keep `kernelReadRoute` (restricted / full / refused) for both purposes.
- [ ] **Step 4: Run** the tests and the whole `packages/kernel/test/sandbox` folder — PASS.
- [ ] **Step 5: Commit** `feat(kernel): write_base kernel read for display-only Write bases`.

### Task 6: The `Write` base watcher

**Files:**
- Create: `packages/kernel/src/runtime/write-base.ts`
- Modify: `packages/kernel/src/runtime/model-call.ts` (create one watcher per model stream attempt; feed it the start / delta events; cancel on step reset / stream end)
- Modify: the runtime module wiring the reader's deps (`packages/kernel/src/runtime/runtime.module.ts` or the `ModelStepDeps` builder)
- Test: new `packages/kernel/test/runtime/write-base.test.ts` (unit: pure parts and the watcher with a fake reader; add to `unit-tests.json`); integration case in Task 7

**Interfaces:**
- Consumes: Task 3 sink (`tool_base`), Task 4 `inputView` (via the step's resolved tool specs, by tool name), Task 5 `withKernelRead` `write_base`, `lastFileState` / `normalizeSandboxPath` / `fileStateOf` (`tools/builtins/sandbox/file-state.ts`), `checkFilePathShape` / `checkToolWritable` (`tools/builtins/sandbox/common.ts`), `TOOL_VIEW_DIFF_MAX_BYTES` / `TOOL_VIEW_DIFF_MAX_TEXT_BYTES` (`tools/view.ts`).
- Produces:
  ```ts
  /** The value of a top-level string property once its closing quote arrived; null before. */
  export function closedStringProperty(json: string, prop: string): string | null;
  export interface WriteBaseReader {
    read(input: { conversationId: string; path: string; signal: AbortSignal }): Promise<{ text: string; sha256: string } | null>;
  }
  export function writeBaseWatcher(deps: {
    reader: WriteBaseReader;
    inputViewOf(toolName: string): ToolInputView | undefined;
    emit(callId: string, base: { text: string; sha256: string }): void;
    conversationId: string;
    signal: AbortSignal;
  }): { onStart(callId: string, name: string): void; onInput(callId: string, fragment: string): void };
  ```
  The reader resolves the path as `Write` does, checks `lastFileState` (none → null), reads through `write_base`, returns null on size / sha256 mismatch, binary (`looksBinary` or a NUL), any error, or text above `TOOL_VIEW_DIFF_MAX_TEXT_BYTES`. At most one read per call id.

- [ ] **Step 1: Failing tests.** `closedStringProperty`: `'{"file_path":"/w/a'` → null; `'{"file_path":"/w/a.py","con'` → `"/w/a.py"`; escaped quotes `'{"file_path":"/w/\\"q\\".py"}'` → `/w/"q".py`; a nested object's `file_path` ignored. Watcher: emits once for a `file_write` call after the path closes; never for a tool without `file_write`; a reader returning null emits nothing; aborting the signal before the read resolves emits nothing; a reader that throws is swallowed and logged. Reader (with a fake `withKernelRead` and event log): no recorded state → null; hash mismatch → null; matching → `{ text, sha256 }`.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/write-base.test.ts` — FAIL.
- [ ] **Step 3: Implement.** `closedStringProperty` is a small scanner over the top-level object (track depth and string state, decode the value with `JSON.parse` of the quoted slice); scan only the new fragment plus carried state, not the whole buffer, per call.
- [ ] **Step 4: Run** the tests and `pnpm test:unit` — PASS.
- [ ] **Step 5: Commit** `feat(kernel): read a display-only base for streaming Write calls`.

### Task 7: End-to-end kernel integration

**Files:**
- Create: `packages/kernel/test/runtime/streaming-tool-input.test.ts` (integration, one app)

**Interfaces:**
- Consumes: Tasks 2–6.

- [ ] **Step 1: Write tests** (model-fake, device-fake fixture):
  - `"a streaming Write publishes start, input and a base"`: the conversation `Read`s `/workspace/a.py`, then the model runs `streamtool:20:Write:{…}`; the SSE shows `tool_start` (`name: "Write"`), `tool_input` deltas whose join equals the logged input, then `tool_base` with the file's content; the logged `assistant_message` and the executed result equal a non-streamed run's.
  - `"no base for an unread file or a new file"`: no `tool_base` frame; the Write runs as before (refused `not_read` for the unread existing file).
  - `"reconnect mid-call restores tools"`: a second subscriber mid-stream gets `event: draft` with `tools[0].input` a prefix of the final input and the base, then later deltas only.
  - `"zero drift"`: `reconstruct` of the run equals the logged requests.
- [ ] **Step 2: Run** `pnpm exec vitest run packages/kernel/test/runtime/streaming-tool-input.test.ts` — PASS (fix in the owning task's files if not).
- [ ] **Step 3: Run** `pnpm verify --fast` — PASS.
- [ ] **Step 4: Commit** `test(kernel): streaming tool input end to end`; open core PR 1 (draft until green), linking the spec.

### Task 8: Web partial JSON

**Files:**
- Create: `apps/web/src/lib/partial-json.ts`
- Test: `apps/web/test/partial-json.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PartialJson { value: Record<string, unknown> | null; open: string | null /* the top-level string property still receiving text */ }
  export function parsePartialJson(text: string): PartialJson;
  ```

- [ ] **Step 1: Failing tests:** every prefix of three recorded inputs (a `Write` with escapes and CJK, an `Edit`, a connector call with nested arrays) parses without throwing; the full text equals `JSON.parse`; `'{"file_path":"/a","content":"x\\'` → `value.content === "x"`, `open === "content"`; a dangling key `'{"a":1,"b'` → `{ a: 1 }`; a surrogate pair cut in half is dropped, not mangled.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/partial-json.test.ts` — FAIL.
- [ ] **Step 3: Implement** a closing-repair parser (track a stack of open containers and string state; close them; drop trailing incomplete tokens; then `JSON.parse`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): tolerant partial JSON parser`.

### Task 9: Web stream state

**Files:**
- Modify: `apps/web/src/lib/stream.ts` (`StreamDelta` ~line 21, `Draft` ~line 337, `reduceChat` ~line 519, the `draft` listener ~line 258)
- Modify: `apps/web/src/lib/timeline.ts` `TimelineDraft` (~line 499) to carry `tools`
- Test: `apps/web/test/stream.test.ts`, `apps/web/test/stream-resume.test.tsx`

**Interfaces:**
- Consumes: Task 3 wire shapes.
- Produces:
  ```ts
  StreamDelta.delta: "text" | "thinking" | "tool_start" | "tool_input" | "tool_base" | "step_reset" | "draft"; fields callId?, name?, sha256?; draft frames carry tools?
  export interface DraftTool { id: string; name: string; input: string; inputTruncated?: boolean; base?: { text: string; sha256: string } }
  Draft.tools: DraftTool[]; TimelineDraft.tools: DraftTool[]
  ```

- [ ] **Step 1: Failing tests:** `"tool deltas build a draft tool"`; `"interleaved calls stay apart"`; `"a tool_input past the held offset asks for the draft"` (same gap path as text); `"draft frame then deltas do not duplicate"`; `"finalized step ignores late tool deltas"`; `"tool_base sets the base once"`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/stream.test.ts apps/web/test/stream-resume.test.tsx` — FAIL.
- [ ] **Step 3: Implement** in `reduceChat`, reusing the text offset logic per call.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): tool drafts in the conversation stream state`.

### Task 10: Web live diff

**Files:**
- Create: `apps/web/src/lib/live-diff.ts`
- Test: `apps/web/test/live-diff.test.ts`

**Interfaces:**
- Consumes: design `DiffData` / `DiffHunk` types.
- Produces:
  ```ts
  export interface LiveDiff { diff: DiffData; added: number; removed: number; pending: number /* base lines past the last aligned line */ }
  export function liveWriteDiff(base: string, prefix: string): LiveDiff;   // §6.4 Write with a base
  export function liveEditDiff(oldText: string, newPrefix: string): DiffData; // hunks with oldStart = newStart = 0 (gutter pending)
  export function writingLines(prefix: string): DiffData;                   // neutral form: ctx lines numbered from 1
  ```
  `liveWriteDiff`: Myers over base lines vs complete prefix lines (the last, unfinished line is always shown as added); the last aligned line is the last non-blank matched base line; base lines after it count in `pending`, not removed; hunks with 3 lines of context, the line limit of the kernel (`TOOL_VIEW_DIFF_MAX_LINES = 2000`), the edit budget 1000 (beyond: removed-then-added, as the kernel).

- [ ] **Step 1: Failing tests:** identical prefix → no hunks, `pending` = remaining base lines; a rewrite of the middle → removed lines only before the aligned line; the completed prefix equal to the final content gives the same hunks as the kernel's `lineDiff` for three fixtures (copy the kernel's expected hunks from `packages/kernel/test/tools/view.test.ts` as literals); `liveEditDiff` puts all old lines as `del`, new as `add`; a 5 000-line base stays under 16 ms on a warm run (measure, assert < 50 ms).
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/live-diff.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): live diff for streaming Write and Edit`.

### Task 11: Design states (spec §6.5)

**Files:**
- Modify: `docs/design/spec.md` §6.16.9 (Tool row: status `streaming`, state list, size table) and §6.16.10 (Diff block: `live`, `gutter="pending"`, writing form, pending line)
- Modify: `docs/design/reference/src/tool-row.html`, `docs/design/reference/src/diff-block.html` (one reference block per new state)
- Modify: `packages/design/src/conversation/tool-row.tsx` (`ToolRowData.status` adds `"streaming"`; `progress?: { lines?: number; bytes: number }`), `packages/design/src/conversation/diff-block.tsx` (`live?: boolean`, `gutter?: "numbers" | "pending"`, `pending?: number`), `packages/design/src/conversation/tool-copy.ts` (copy), `packages/design/src/styles/conversation.css` (tokens only)
- Modify: catalog `apps/web/src/dev/catalog/conversation-blocks.tsx` (every new state, `RefBlock` ids matching)
- Test: `packages/design/test/tool-row.test.tsx`, `packages/design/test/diff-block.test.tsx`

**Interfaces:**
- Produces: the props above; the row's `streaming` status shows the pulse mark (16 px, replaces the spinner), the word and `progress` (lines when known, else size: 「生成中 · 86 行 · 2.7 KB」 / 「生成参数中 · 1.2 KB」), `aria-busy="true"`, no timer, no actions. `DiffBlock live`: caret after the last line's text, tail-follow while scrolled to the bottom (scrolling up stops it, back to bottom resumes), `pending > 0` draws one line 「后面 N 行待对齐」; `gutter="pending"` hides numbers and adds the footer 「行号待定」.

- [ ] **Step 1: Spec diff** (states and size tables in the §9.2 format) and reference blocks; get the spec diff reviewed (maintainer) before Step 3.
- [ ] **Step 2: Failing jsdom tests:** streaming row has `aria-busy`, no timer, the progress text; `DiffBlock live` renders the caret only on the last line and the pending line with its count; `gutter="pending"` renders no numbers; tail-follow stops after a user scroll up (fire `scroll`).
- [ ] **Step 3: Implement**; reduced motion draws the pulse static.
- [ ] **Step 4: Run** `pnpm vitest run --project design`, `pnpm check:web-ui` — PASS.
- [ ] **Step 5: Commit** `feat(design): streaming tool row and live diff block`.

### Task 12: Timeline streaming rows

**Files:**
- Modify: `apps/web/src/lib/timeline.ts` (`withDrafts` ~line 648: tool rows from `TimelineDraft.tools`)
- Modify: `apps/web/src/components/conversation/ConversationView.tsx` (pass tool info `inputView`; parse at most once per animation frame per call)
- Test: `apps/web/test/timeline.test.ts`, new `apps/web/test/timeline-streaming.test.ts`

**Interfaces:**
- Consumes: Tasks 8, 9, 10, 11; Task 4 `inputView` from `useToolInfo`.
- Produces: streaming `ToolRowData` per draft tool: `id = callId`, `status: "streaming"`, `keyArg` from `keyArgs` as parsed, `progress`, `detail.diff` per §6.4 (`file_write` with base → `liveWriteDiff`, without → `writingLines`; `file_edit` → `liveEditDiff`; `command` → `keyArg` = command, replaced by `description` only when `open !== "description"`; `text` → the field as streaming prose in `detail.output`; generic → formatted partial JSON in `detail.input`).

- [ ] **Step 1: Failing tests:** `"a draft Write becomes a streaming row with its path"`; `"with a base the row carries a live diff and +a −b of the aligned part"`; `"the logged call replaces the streaming row with the same id"` (same `id`, status leaves `streaming`); `"a streamed id the message lacks disappears"`; `"Bash shows the description only once it is complete"`; `"inputTruncated shows the head and the size"`; `"consecutive streaming calls form one group after the draft's prose"`.
- [ ] **Step 2: Run** `pnpm exec vitest run apps/web/test/timeline-streaming.test.ts apps/web/test/timeline.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm check:web-ui`; `pnpm verify --fast`.
- [ ] **Step 5: Commit** `feat(web): streaming tool rows in the conversation timeline`.

### Task 13: Visual acceptance

**Files:**
- Modify: `apps/web/visual/accepted.ts` (add the new states)
- Baselines: through the `visual-update` workflow only

- [ ] **Step 1:** `COMPARE=tool-row,diff-block pnpm --filter @capybara-hq/web compare` in the pinned Linux Playwright image; dispatch a blind image-reviewing subagent with only the PNG paths and the standard instruction (writing-web-ui step 4); fix every severe and moderate difference; repeat.
- [ ] **Step 2:** add to `ACCEPTED`; `pnpm --filter @capybara-hq/web visual fidelity` — PASS.
- [ ] **Step 3:** trigger `visual-update` on the branch; review the diff images; commit `test(web): visual baselines for streaming tool rows`; open core PR 2.

### Task 14: Anthropic provider

**Files:** `plugins/anthropic/src/map-stream.ts` (~line 100–245), its stream tests (`plugins/anthropic/test/`).

- [ ] **Step 1: Failing test** with recorded upstream chunks (a `tool_use` block, `input_json_delta` fragments, text between two tool blocks): events contain `tool_call_start { id: "toolu_…", name }` at `content_block_start` and `tool_call_delta` per fragment; `checkToolStream(events, done)` is `[]`.
- [ ] **Step 2: Run** `pnpm exec vitest run plugins/anthropic` — FAIL.
- [ ] **Step 3: Implement**: yield at the two accumulation points; keep accumulating for `complete()`.
- [ ] **Step 4: Run** the tests, conformance, and the live API test (`CAPYBARA_TEST_ANTHROPIC_*`, keys from `~/.capybara-test.env` loaded inside the command only) — PASS.
- [ ] **Step 5: Commit** `feat(anthropic): stream tool call input`.

### Task 15: OpenAI Responses provider

**Files:** `plugins/openai/src/map-stream.ts` (`streamResponses` ~line 160), its tests.

- [ ] **Step 1: Failing test** with recorded chunks: `response.output_item.added` (`function_call`, `call_id`, `name`, `id` = item id) → `tool_call_start { id: call_id }`; `response.function_call_arguments.delta` (`item_id`) → `tool_call_delta` with that call's `call_id`; `checkToolStream` is `[]` against `toComplete(final)`.
- [ ] **Step 2–5:** run (FAIL), implement an `item_id → call_id` map, run with conformance and the live test, commit `feat(openai): stream tool call input`.

### Task 16: OpenAI-compatible family (openai-compatible, ark, deepseek, bailian)

**Files:** `plugins/openai-compatible/src/map-stream.ts` (~line 97), `plugins/ark/src/map-stream.ts` (~line 121), `plugins/deepseek/src/map-stream.ts` (~line 114), `plugins/bailian/src/map-stream.ts` (~line 228), each plugin's tests.

- [ ] **Step 1: Failing test per plugin** with recorded chunks: the first `tool_calls[i]` chunk with `id` and `function.name` → `tool_call_start`; later `function.arguments` by `index` → `tool_call_delta`; a chunk stream whose upstream omits `id` gets the id the mapper synthesizes, fixed at the start and equal in `message_complete`; `checkToolStream` is `[]`.
- [ ] **Step 2–5:** run (FAIL), implement (where the four mappers share the same shape, keep each change local; no shared package), run with conformance and each live test, commit `feat(providers): stream tool call input in OpenAI-compatible mappers`; open the plugins PR, bumping each plugin and the SDK range.
