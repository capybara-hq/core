# Streaming tool input: show a tool call while the model writes it

Status: design, for maintainer review (2026-11-26). Builds on the live drafts design
(`2026-11-07-run-input-and-live-drafts-design.md` §3.2) and the tool rows of UI refresh B
(`2026-10-22-ui-refresh-design.md`, design spec §6.16.9–§6.16.10).

## 1. Why

A person watching a conversation sees nothing while the model writes a tool call's arguments. For
a `Write` of a 150-line file that is tens of seconds of a bare working line; then the row appears,
already running, and finishes in milliseconds. The wait is the model generating the input, not the
tool. Claude Code and similar tools show the call as it is written.

Where the input is lost today:

1. **Providers swallow it.** Every provider plugin hands the arguments over only in
   `message_complete`: Anthropic accumulates `input_json_delta`
   (`plugins/anthropic/src/map-stream.ts`), openai-compatible, ark, deepseek and bailian accumulate
   `function.arguments`, and OpenAI Responses ignores `response.function_call_arguments.delta` and
   reads the calls from `response.completed`.
2. **The contract has no event for it.** `ModelStreamEvent` is `text_delta`, `thinking_delta` and
   `message_complete` (`packages/plugin-sdk/src/model.ts`); the kernel's `StreamSink` carries text
   and thinking only.

A latent bug follows from (1): `consumeModelStream` re-arms its idle watchdog only on an event the
provider yields. Arguments generated with no text around them yield nothing, so a tool call whose
input takes longer than `streamIdleMs` (default 60 s; a long `Write` on a slow model) fails as a
`timeout` although the provider is streaming the whole time.

## 2. Decisions

| # | Decision |
|---|---|
| D1 | Show, never execute early. Input deltas are a display hint, like text deltas. Execution, the command review, policy hooks and approvals still start from the complete `tool_call` in the logged `assistant_message`. |
| D2 | Two new stream events in `model-provider@2`: `tool_call_start { id, name }` and `tool_call_delta { id, input }` (input = the next fragment of the JSON text). Optional for a provider; one that emits them guarantees the ids and the concatenated input match `message_complete` (conformance-tested). No contract version bump: an additive event a kernel ignores is harmless, and pre-0.1.0 we change in place. |
| D3 | Every event re-arms the idle watchdog (fixes the latent timeout of §1). |
| D4 | The kernel forwards fragments raw (offset per call, like text) on the conversation topic and keeps them in the step's live draft, so a reload or another replica's viewer sees the call so far. Nothing goes into the event log. |
| D5 | The web parses the partial JSON itself (a tolerant parser, at most once per animation frame per call) and draws a streaming row. |
| D6 | What a streaming row shows is declared by the tool (`ToolSpec.inputView`), exposed through tool info like `keyArgs`; the web never branches on tool keys. Tools without it get the generic form (key arguments as they arrive, a size counter, the formatted partial JSON). |
| D7 | `Write` over an existing file streams as a live diff against the file's current content, which the kernel reads as soon as the path parses (the "base", §4.1). This exposes nothing new: the read-before-write guard already requires this conversation to have read the file unchanged, so the base is only read when the log records a state for the path and the bytes read match it; otherwise (a new file, a file not read, a file changed since) the row streams as neutral numbered text (the "writing" form). Reads pass no command review, as `Read` does not. The real diff replaces either form when the result arrives. `Edit` streams as a live diff (`old_string` removed, `new_string` added) without line numbers, which only the kernel knows; the result's diff replaces it. |
| D8 | A streaming row becomes the logged row in place: the same call id is the same React key, so an expanded row stays expanded and nothing remounts or jumps. |

## 3. SDK (`@capybara-hq/plugin-sdk`)

```ts
export type ModelStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  /** A tool call begins; `id` and `name` are the ones `message_complete` will carry. */
  | { type: "tool_call_start"; id: string; name: string }
  /** The next fragment of the call's input as JSON text (fragments concatenate). */
  | { type: "tool_call_delta"; id: string; input: string }
  | { type: "message_complete"; /* unchanged */ };
```

Rules (doc comments and the conformance suite):

- A `tool_call_delta` follows the `tool_call_start` of its id. Calls may interleave (parallel tool
  calls); text and thinking deltas may come between them.
- The concatenated fragments of an id, once complete, parse to the input that `message_complete`
  carries for that id (parsed equality, not byte equality: a provider that normalizes may skip the
  deltas instead). A `tool_call_start` without a final call of that id is allowed (the stream
  failed or the provider dropped it) and is simply never confirmed.
- A provider whose upstream sends no ids until the end, or sends argument snapshots instead of
  appends, either synthesizes the id at the start and reuses it in `message_complete`, or emits no
  tool events. Emitting nothing stays valid.

`ToolSpec.inputView` (display only, checked by `checkToolDisplay` like `keyArgs`: every named
property is a string property of `inputSchema`):

```ts
inputView?:
  | { kind: "file_write"; path: string; content: string }  // Write
  | { kind: "file_edit"; path: string; old: string; new: string }  // Edit
  | { kind: "command"; command: string; description?: string }  // Bash
  | { kind: "text"; field: string }  // Agent prompt, SendMessage, image prompt
```

Both are public API changes: `pnpm gen:sdk-api` and a changeset bumping the SDK.

## 4. Kernel

- **`consumeModelStream`** passes the two events to `onDelta`; the watchdog already re-arms on every
  event (D3). Eval step replay and the judge ignore them.
- **`StreamSink`** gains `tool_start { callId, name }` and `tool_input { callId, text }`.
  `streamSink` publishes them on `conv.<id>` as `{ kind: "delta", delta: "tool_start" | "tool_input",
  runId, step, callId, name?, text?, offset? }`, `offset` counted per call.
- **Live drafts** (`RunDrafts`): the step's draft JSON becomes `{ text, thinking, tools: [{ id,
  name, input }] }`, written on the same flush schedule (`DRAFT_FLUSH_MS`, TTL `DRAFT_TTL_SECONDS`).
  A draft holds at most `DRAFT_TOOL_INPUT_MAX` (512 KiB) of tool input per step; past it a call
  keeps `inputTruncated: true` and later fragments are only published, so a reconnecting viewer
  shows the call's head and its size (the result replaces it anyway). `stream_end`, `step_end` and
  `step_reset` handle tools exactly as text.
- **The `event: draft` frame** carries `tools`. The stream controller, the draft route and
  `step_reset` keep their semantics.
- **Tool info** returns `inputView` beside `keyArgs`. Builtins declare it: `Write`, `Edit`, `Bash`,
  `Agent`, `SendMessage`, image generation. Connector tools have none (the generic form).
- **Sub-agent runs** use the same sink, so their panels stream too. Channels (IM) are unchanged: they
  render only logged messages.

### 4.1 The `Write` base

The run worker's sink watches each streaming call whose tool declares `inputView.kind:
"file_write"`. When the `path` property's string closes (not before: a half path is not a path),
it starts one read, asynchronous and never blocking the stream:

1. Resolve the path as `Write` does (the device and project of the run, `checkFilePathShape`,
   `checkToolWritable`, `normalizeSandboxPath`). A path `Write` would refuse gets no base, and so
   does a relative path (resolving it needs the working root of a tool call; the row keeps the
   writing form). Only the builtin `Write` triggers a read: an extension tool declaring
   `file_write` never makes the kernel read a device for it.
2. Find the latest recorded state of that path in this conversation's log (the same lookup as
   `assertReadAndUnchanged`). None: no base (a new file, or a call the guard will refuse).
3. Read it as a kernel read (permission activation L2: `SandboxService.withKernelRead`,
   admitted and claimed per call by `SandboxOperationIntents`) with a second purpose beside
   `project_root`: `write_base { path }`. Its admission differs from a run start's: the run's
   current claim with the run `running` (not `queued`); the scope is exactly that one path, the
   methods `stat` and `readFile` only; and the use never makes, wakes or resumes an instance (a
   device that is not running gets no base). It holds no path lease. Read at most
   `TOOL_VIEW_DIFF_MAX_BYTES`; a size or sha256 different from the recorded state, a binary file,
   a refused admission or a read error: no base.
4. Publish `{ delta: "tool_base", callId, text, sha256 }` on the conversation topic and keep it
   in the step's draft (counted in `DRAFT_TOOL_INPUT_MAX`; a base above
   `TOOL_VIEW_DIFF_MAX_TEXT_BYTES` is not sent).

The base is display only: it never reaches the model, the log or a hook, and `Write` itself reads
the file again when it runs (its lease, its guard check and its result diff are unchanged). At most
one base read per call; a step reset or the step's end cancels a pending read (`ctx.signal` of the
step). The web diffs the new prefix against the base (Myers, the kernel's limits, at most once per
animation frame).

Multi-replica: nothing new in process memory beyond the run worker's held draft, which already
exists (the pending base read lives and dies with the step it serves); the draft is in Redis with a TTL, the bus publish is a hint whose loss the next draft frame
repairs. Replay: nothing model-visible changes, the log is untouched, no `DriftReason`.

## 5. Provider plugins (`capybara-hq/plugins`)

Each provider's stream mapper emits the events where it accumulates today, with its existing id:

| Plugin | Source of start / delta |
|---|---|
| anthropic | `content_block_start` (`tool_use`: id, name) / `input_json_delta` |
| openai | `response.output_item.added` (`function_call`: call_id, name) / `response.function_call_arguments.delta` (by `item_id` → call_id) |
| openai-compatible, ark, deepseek, bailian | the first `tool_calls[i]` chunk with `id` and `function.name` / later `function.arguments` (by `index` → id; when the upstream omits the id, the id the mapper synthesizes for `message_complete` is fixed at the start) |

`plugins/model-fake` (core) gets a script form that streams a tool call's input in chunks with
pauses, for kernel and web tests. Each plugin runs the conformance suite and its live API tests.

## 6. Web

### 6.1 State (`lib/stream.ts`)

`StreamDelta.delta` adds `tool_start` / `tool_input`; `Draft` adds `tools: DraftTool[]`
(`{ id, name, input, inputTruncated? }`), merged by offset as text is (a gap asks for the draft,
as today). `finalized` and `closedRuns` drop tool deltas exactly as text deltas.

### 6.2 Timeline (`lib/timeline.ts`)

A draft's tools become tool rows after the draft's prose, grouped by the existing rules
(consecutive calls form one group). Status `streaming`. When the step's `assistant_message`
arrives, the logged calls take over by id (D8); a streaming row whose id the message does not
carry disappears with the draft.

### 6.3 Partial JSON (`lib/partial-json.ts`)

A pure tolerant parser: closes open strings, arrays and objects, drops a dangling key or escape,
and reports which string property is still open (the one receiving text). Parsed at most once per
animation frame per call; rows above a few hundred KB parse only the fields `inputView` and
`keyArgs` name. Unit-tested against every cut of recorded inputs (each prefix parses, and the
final parse equals `JSON.parse`).

### 6.4 What each tool shows

| Tool | While streaming | When the result arrives |
|---|---|---|
| `Write` (`file_write`) | Row 「生成中 · 86 行」; path in the key argument as soon as it parses. With a base: a live diff of the new prefix against the base, with real line numbers; base lines past the last aligned line are not removals yet but one collapsed line 「后面 N 行待对齐」 (only the final result decides what is removed), and the row's `+a −b` counts only the aligned part. Without a base (until it arrives, a new file, no base): numbered neutral text. Both carry a caret on the last line and follow the tail | The real diff (`+118 −30`, or all added for a new file) |
| `Edit` (`file_edit`) | Live diff: `old` as removed lines, `new` growing as added lines, gutter blank | The real diff with line numbers and context |
| `Bash` (`command`) | Command text grows in the key argument; `description` replaces it once its string is complete (never a half description) | Running with its timer, then output (unchanged) |
| `Read`, `Grep`, `Glob`, `WebFetch`, `WebSearch` | Row appears at `tool_call_start`; key argument fills in (inputs are short) | Unchanged |
| `AskUserQuestion` | The question row with the first question's text; the card is still created only by the wait, after the call runs | Unchanged |
| `Agent` (`text`) | Description on the row; the prompt streams in the expanded area | The sub-agent group (unchanged) |
| Connector and extension tools (generic) | Name and key arguments; 「生成参数中 · 1.2 KB」; expanded: the formatted partial JSON | Unchanged |

A streaming row is never actionable: no approve, no answer, no stop (stopping the run stops it).
It has `aria-busy`, and its growing text is not a live region.

### 6.5 Design package (spec §10 process)

- `ToolRow` status `streaming`: the word 生成中 / Writing, a progress meta (lines for text
  views, size otherwise) instead of the timer, a calm pulse instead of the spinner.
- `DiffBlock` `live`: a caret on the last line, tail-follow while the reader is at the bottom
  (scrolling up stops it), `gutter="pending"` for the edit form, and the writing form (only
  `ctx` lines numbered from 1, no signs). Large text keeps the last `TOOL_VIEW_DIFF_MAX_LINES`
  lines with 「前面 N 行」.
- Design spec §6.16.9 / §6.16.10: the state lists and size tables, reference blocks per state,
  catalog entries, then compare and `ACCEPTED` as usual.

The offline prototype used for this review (real design components and CSS, scripted streams):
attached to the PR, not committed.

## 7. Tests

- SDK conformance (`packages/testing/src/model-conformance.ts`): ids and parsed input of streamed
  calls equal `message_complete`; interleaved calls; a provider emitting no tool events passes.
- Kernel unit: `streamSink` offsets per call, `step_reset` clears tools; `RunDrafts` tools and the
  512 KiB cap; `consumeModelStream` does not time out while tool deltas keep arriving and still
  times out when they stop.
- Kernel integration (model-fake streaming a `Write`): the SSE carries `tool_start` / `tool_input`;
  a reconnect mid-call gets a draft frame with `tools`; the logged `assistant_message` and the
  executed call are unchanged; zero-drift fixture tests unchanged.
- Web unit: `partial-json` (every prefix of recorded inputs), `reduceChat` with tool deltas and
  gaps, `timeline` (a streaming row replaced in place by the logged one; a vanished id).
- Design: `ToolRow` streaming and `DiffBlock` live states (jsdom), reference compare.
- Providers: each plugin's stream mapper tests with recorded upstream chunks, conformance, live
  API tests (`CAPYBARA_TEST_*`).

## 8. Not in scope

- Executing while the input streams, or reviewing a partial command (D1).
- A base for `Edit` (its live diff has no line numbers until the result). The same read could
  place `old_string` in the file; left for later, the result arrives milliseconds after the input.
- Streaming tool input to channels (IM) or to hooks.
- Streaming a tool's output (command stdout already has its own path).

## 9. Rollout

1. SDK events and `inputView`, kernel sink / drafts / watchdog, model-fake, tool info (core PR 1).
2. Design states and web streaming rows (core PR 2, with the reference compare).
3. Provider plugins (plugins PR; can land after PR 1, independently of PR 2). Until a provider
   emits the events, nothing changes for its models.

## AGENTS.md rules touched

- **Runtime and replay:** no change to the log or to what the model sees; deltas stay hints like
  text deltas (§4).
- **Model providers:** a new optional stream event in `model-provider@2`; still no retries inside
  the extension (§3, §5).
- **Multi-replica discipline:** draft state lives in Redis with a TTL, nothing new in process
  memory (§4).
- **Sandboxes:** a display-only read of a file the conversation already read unchanged, before
  `Write` runs (§4.1); no command review (reads pass none), never wakes a device, no write.
- **Public API reports:** SDK API changes with `gen:sdk-api` and a changeset (§3).
- **Web UI:** new states go through the design package and its spec, no styles in `apps/web`
  (§6.5).
