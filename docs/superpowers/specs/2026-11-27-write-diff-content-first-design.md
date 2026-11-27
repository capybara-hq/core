# Live `Write` diff for models that stream `content` before `file_path`

Status: design, for maintainer review (2026-11-27). Issue #929. Builds on the streaming tool input
design (`2026-11-26-streaming-tool-input-design.md`, D7 and §4.1, the "base"); acceptance finding B2.

## 1. Why

A streaming `Write` over an existing file shows a live diff only once the kernel has read the file's
current content (the base). That read starts when the `file_path` string closes in the streamed
arguments (§4.1). A model that streams `content` first closes the path at the very end:

1. The whole call shows the neutral writing form (numbered text, no diff).
2. When the path finally closes, the base read starts, but `message_complete` follows within
   milliseconds, the attempt aborts its base reads (`baseStop`, `writeBaseWatcher.settle`) and the
   read never publishes. The diff appears only with the result.

The `Write` schema already lists `file_path` first. Ark `deepseek-v4-1-flash` still sent `content`
first in 3 of 5 Writes during local acceptance (2026-11-27); Anthropic and OpenAI models send
`file_path` first in practice. We have no numbers beyond that.

## 2. Directions weighed

| Direction | Verdict |
|---|---|
| A. Ask for the order in the `Write` definition | **Yes**, one sentence that states the mechanism (§3). It costs nothing, but it guarantees nothing either. |
| B. Show the diff from a late path anyway (let the read outlive the stream) | **No.** Once the stream ends, `Write` itself runs: it reads the same file on the same device and returns the real diff. A base read let run past the stream would race that read for a few hundred milliseconds of display, and it would break the rule that no admission starts after the step has moved on. |
| C. Guess the target before the path closes, confirm or drop the guess when it arrives | **Yes**, the main change (§4). It is safe because a guess is only drawn when the streamed content clearly matches a file the conversation has already read unchanged, it is labeled as a guess until the path confirms it, and a wrong guess is withdrawn the moment the path arrives. |
| D. Measure how often each provider and model sends `content` first | **Yes**, a log line per streamed `Write` (§5), which also measures how often C's guesses hit. It ships with C; it does not gate C, because the acceptance sample already shows the case is common for one provider. |

## 3. The `Write` definition (A)

Append to the `file_path` property's description:

> Give it before `content`: the user sees the write as a live diff against the current file once
> the path is known.

This states the mechanism and the person's benefit; it does not patch the observed slip with an
imperative ("ALWAYS put …"). Model-visible, but a tool definition: candidates see the current
builtin definitions and step replay pins the recorded ones, so no `DriftReason` (replay-evals
skill). It is a builtin definition change, so the tool fingerprint changes as any description edit
does.

## 4. Guessed base (C)

### 4.1 When a guess is made

The run worker's `writeBaseWatcher` already scans each builtin `Write` call for its path
(`TopLevelStringProperty`). It also scans for the `content` property and notes which comes first:

- **The path closes before `content` starts** (Anthropic, OpenAI): nothing changes from today. No
  guess, no extra read.
- **`content` starts before the path has closed:** the call enters guess mode, once per call id.

### 4.2 Candidates

In guess mode the watcher asks for the conversation's **candidate files**: the newest recorded
file states (`tool_result.view.file`, the same records `assertReadAndUnchanged` and `lastFileState`
use), one per distinct path, newest first, at most `WRITE_BASE_CANDIDATES` (3), each no larger than
`TOOL_VIEW_DIFF_MAX_TEXT_BYTES`. A new `EventLog.recentFileStates(conversationId, limit)` returns
them in one query.

Each candidate is read exactly as a base is read today (`readWriteBase`, §4.1 of the streaming
spec): an absolute path that passes `checkFilePathShape` and `checkToolPath`, a `write_base` kernel
read admitted per path (the run `running`, `stat` / `readFile` of exactly that path, never making,
waking or resuming an instance, no path lease), and bytes whose size and sha256 equal the recorded
state, not binary, valid UTF-8. A candidate that fails any of these is dropped silently. The reads
run concurrently with the stream (the content takes seconds to generate) and stop with the attempt
as base reads do now (`settle`). The texts stay in the attempt's memory only, at most
`WRITE_BASE_CANDIDATES × TOOL_VIEW_DIFF_MAX_TEXT_BYTES`, and are dropped when the attempt ends.

This exposes nothing new: every candidate is a file this conversation has read (or written), still
byte for byte as recorded, and the base itself never reaches the model, the log or a hook. The cost
is at most three more small device reads per content-first `Write`, only while the device is
already running.

### 4.3 Choosing

The watcher also reads the open `content` string as it grows (a prefix-reading variant of the
scanner, decoding escapes incrementally, capped at `GUESS_PREFIX_LINES`). It chooses once, when the
first of these happens: `GUESS_PREFIX_LINES` (8) complete lines have streamed, the `content` string
closes, or the path closes.

Score per candidate: among the prefix's non-blank lines (trimmed), the fraction that occur in the
candidate's line set. The best candidate wins if its score is at least `GUESS_MIN_SCORE` (0.6) and
it leads the runner-up by at least 0.2; otherwise there is no guess and the row keeps the writing
form. An overwrite usually keeps most of its file's head, a new file almost never matches a file
the model just read this closely, and an ambiguous choice is not drawn.

If the path has already closed when the choice would be made, there is no guess: the path decides
(the existing exact base read starts, as today).

### 4.4 Publishing and the verdict

The winner goes out as the existing delta with one more field:

```
{ delta: "tool_base", callId, text, sha256, guess: { path } }
```

and is kept in the step's draft like any base (counted in `DRAFT_TOOL_INPUT_MAX`).

When the path closes, the watcher normalizes it as `readWriteBase` does (synchronous: shape,
`checkToolPath`, `normalizeSandboxPath`) and publishes, before it handles the next fragment:

```
{ delta: "tool_base_verdict", callId, confirmed: boolean }
```

- **Confirmed** (the normalized path equals the guess's path): the base is now the exact base, and
  no second read starts. `Write` still reads the file again when it runs; its guard and its result
  diff are unchanged.
- **Rejected** (another path, a relative path, a path `Write` would refuse): the web drops the base
  at once, and the watcher starts the ordinary exact base read of the real path (which, as today,
  usually loses the race with the stream's end).

The verdict is kept in the draft on the base (`verdict: "confirmed" | "rejected"`); a rejected
guess stays in the draft, marked, so a lagging draft copy never brings it back. One merge rule
(kernel draft and web, the same on both sides): the first base is kept; an exact base replaces a
guess that is not confirmed (it is only read after a rejection, so a copy still showing the guess
missed the verdict, as after a reconnect between the two); the same guess takes a verdict it lacks.
A verdict applies only to a guess without one. If the stream fails before the path closes, there
is no verdict and the guess disappears with the draft.

### 4.5 Web

- `DraftTool.base` gains `guess?: { path }` and `verdict?: "confirmed" | "rejected"`
  (`lib/run-drafts.ts`, merged by the rule of §4.4 in `lib/stream.ts` and `lib/live-drafts.ts`). A
  rejected base is never drawn.
- While a base is a guess (no verdict yet), `streaming-tool-view.ts` draws the same live diff as for
  an exact base, with two differences: the key argument shows the guessed path marked as a guess
  (「推测：src/a.ts」 / "Guess: src/a.ts") until the real path parses and the verdict arrives, and the
  row meta shows only the line count, never `+a −b`, so no number is presented as fact before the
  path confirms it.
- The logged row uses a base for its running state only when it was exact or confirmed (`loggedLiveView`, the
  existing hand-over from the streaming row).

### 4.6 Design package

`ToolRow` gets a tentative key argument (the 「推测」 prefix in the meta tone), with its state in
design spec §6.16.9, a reference block and a catalog entry, then compare and `ACCEPTED` as usual.
`DiffBlock` is unchanged.

## 5. Measurement (D)

At the end of each stream attempt, for each builtin `Write` call it saw, the watcher logs one
`info` line, `write input order`, with `{ conversationId, provider, model, order: "path_first" |
"content_first", guess: "none" | "no_candidates" | "no_match" | "confirmed" | "rejected" |
"path_first_won" }`. No paths or content. It answers how often each provider and model sends
`content` first and how often a guess is right, from the deployment's logs (`grep 'write input
order'`). There is no metrics backend in the kernel today; a log line is enough to decide later
whether a provider plugin should do more (for example reorder in its request), and it can be
removed once the numbers are in.

## 6. Constraints kept

- Display only, never executed early (D1 of the streaming spec). Nothing reaches the model, the
  log or a hook; `Write`, its lease and its read-before-write guard are untouched.
- Every read keeps the base rules: the running run's claim, one path inside its scope per
  admission, never wakes a device, no path lease, only content the log vouches for.
- Only the builtin `Write` triggers reads (ruling R7); extension tools declaring `file_write` never
  do.
- Multi-replica: candidate texts live only in the attempt that reads them; base, guess and verdict
  reach other replicas' viewers through the draft in Redis (TTL) and the bus hint, as today.
- Replay: the definition text of §3 is the only model-visible change; no `DriftReason`.

## 7. Tests

- Kernel unit (`write-base.test.ts`): the order detection (path first: no candidates read;
  content first: one guess flow per call id); the prefix scanner on escaped content cut at every
  offset; the score and the margin rule; a confirmed verdict starts no second read; a rejected one
  starts the exact read; no verdict and no emit after the attempt aborts; candidates failing the
  state check are dropped; the log line's outcomes.
- Kernel integration (model-fake streaming a content-first `Write` over a file read earlier in the
  conversation): the SSE carries `tool_base` with `guess` then `tool_base_verdict confirmed`; a
  content-first `Write` to a new file gets no guess; a reconnect mid-call gets both in the draft
  frame; the logged message and the executed call are unchanged; zero-drift fixtures unchanged
  apart from the definition text.
- `EventLog.recentFileStates`: distinct paths, newest first, the limit.
- Web unit: `reduceChat` with a guessed base and both verdicts (also out of order with a gap and a
  draft refetch); `streaming-tool-view` hides `+a −b` and marks the path while guessed.
- Design: the `ToolRow` tentative key argument (jsdom) and the reference compare.

## 8. Not in scope

- Reordering the arguments in a provider plugin (a provider cannot reorder what the model generates).
- Guessing for `Edit` (its live diff needs no base) or for extension tools.
- A metrics backend; the log line of §5 stands in for one.

## 9. Rollout

One core PR: the definition sentence, the kernel watcher and `recentFileStates`, the web state and
view, the design state with its reference compare. No SDK or plugin change: `tool_base` and
`tool_base_verdict` are kernel-to-web conversation deltas, not part of `model-provider@2`. A kernel
changeset (and the web's) for the release.

## AGENTS.md rules touched

- **Sandboxes:** more display-only reads before `Write` runs (up to three candidate files the
  conversation already read unchanged, under the existing `write_base` admission); no command
  review (reads pass none), never wakes a device, no write (§4.2).
- **Runtime and replay:** a builtin tool definition sentence changes; definitions are not drift and
  need no `DriftReason`; the log is untouched (§3, §6).
- **Multi-replica discipline:** nothing new in process memory beyond the attempt's own reads; the
  draft stays in Redis with a TTL (§6).
- **Web UI:** the tentative key argument goes through the design package and its spec, no styles in
  `apps/web` (§4.6).
