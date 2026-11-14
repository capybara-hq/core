import type { ModelRequest } from "@capybara-hq/plugin-sdk";
import { renderBackgroundFinished } from "../../background/render.js";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import type { CompactionSettings } from "../../identity/settings.js";
import { renderSubagentDelivery } from "../subagents/render.js";
import { latestSummary } from "./build.js";
import { scheduleHeader, senderTranscriptLabel } from "./run-context.js";
import { estimateTokens } from "./tokens.js";
import { toolsChangedText } from "./tool-changes.js";

/** 压缩请求的标记：放在 system 中，便于识别（model-fake 据此返回摘要）。 */
export const COMPACTION_MARKER = "CAPYBARA_COMPACTION";

/**
 * The summary request's output cap when the caller gives none: the built-in default of the
 * `compaction.maxOutputTokens` setting (context compaction spec §4.8). The effective setting is
 * what the request uses, capped by the model's own max output.
 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 20_000;

/** The shortest accepted summary: 200 characters or 5% of the transcript, whichever is smaller. */
const MIN_SUMMARY_CHARS = 200;
const MIN_SUMMARY_RATIO = 0.05;

/**
 * The summary instruction (model-facing English): Claude Code's structured template (context
 * compaction spec §4.2.1). The model first writes an `<analysis>` scratchpad, then a `<summary>`
 * with nine sections; only the `<summary>` is stored and sent again in later requests.
 */
const COMPACTION_INSTRUCTION = [
  COMPACTION_MARKER,
  "You are summarizing the earlier part of a conversation between people and an AI agent, so the agent can continue without the full history.",
  "If the transcript starts with an earlier summary, merge it into your summary.",
  "Write in the same language as the conversation.",
  "",
  "Your task is to create a detailed summary of the conversation so far, paying close attention to the users' explicit requests and the agent's previous actions. This summary must be thorough: it is the only record the agent keeps of everything before it.",
  "Before providing your final summary, wrap your analysis in <analysis>...</analysis> tags to organize your thoughts and make sure every point below is covered. In your <analysis> block, go through the conversation chronologically and identify, for each part: the users' explicit requests and intents; the agent's approach to addressing them; key decisions, technical concepts and code patterns; specific details such as file names, full code snippets, function signatures and file edits; errors that came up and how they were fixed; and specific feedback that told the agent to do something differently.",
  "",
  "Then write the summary inside <summary>...</summary> tags, with these sections:",
  "1. Primary Request and Intent: capture every explicit request and intent of the users in detail.",
  "2. Key Technical Concepts: list the important technical concepts, technologies and frameworks discussed.",
  "3. Files and Code Sections: enumerate the files and code sections examined, modified or created. Include full snippets where they matter and say why each file or edit is important.",
  "4. Errors and fixes: list the errors that came up and how they were fixed, including specific feedback that told the agent to do something differently.",
  "5. Problem Solving: document the problems solved and any troubleshooting still open.",
  "6. All user messages: list all user messages (not tool results), since they carry the users' feedback and changing intent.",
  "7. Pending Tasks: outline the tasks the users explicitly asked for that are still open.",
  "8. Current Work: describe in detail exactly what was being worked on immediately before this summary request, with file names and code snippets where applicable, and quote the most recent messages.",
  "9. Optional Next Step: the next step directly in line with the most recent work, quoting the most recent conversation verbatim so the task does not drift. If the last task was concluded, only list a next step the users' requests explicitly call for; do not start tangential work.",
  "",
  'If a section does not apply to the conversation, write "Not applicable" or leave it out.',
  "There may be additional summarization instructions in the transcript; follow them too.",
  "Output the <analysis> block followed by the <summary> block and nothing else.",
].join("\n");

/**
 * The input room a request leaves below the window: the output cap and the safety reserve are never
 * spent on input (context compaction spec §4.1).
 */
export function compactionInputBudget(window: number, maxOutput: number, reserve: number): number {
  return window - maxOutput - reserve;
}

/** The transcript wrapper of a summary request; the overhead counts it with an empty transcript. */
const transcriptWrapper = (text: string): string => `<transcript>\n${text}\n</transcript>`;

/** A margin for estimator drift in the fixed part of a summary request (tokens). */
const COMPACTION_REQUEST_MARGIN = 64;

/**
 * The input tokens every summary request carries regardless of its chunk: the instruction, the
 * transcript wrapper and a small margin. A chunked compaction subtracts it from the chunk size
 * (context compaction spec §4.5), so chunk + overhead stays inside the request budget.
 */
export function compactionRequestOverhead(): number {
  return (
    textTokens(COMPACTION_INSTRUCTION) +
    textTokens(transcriptWrapper("")) +
    COMPACTION_REQUEST_MARGIN
  );
}

/**
 * The chunk size of a chunked compaction (context compaction spec §4.5): one summary call's input
 * budget `B` minus the room the running summary may take in the next call (half the output cap) and
 * the request's fixed overhead.
 */
export function compactionChunkSize(budget: number, maxOutputTokens: number): number {
  return budget - Math.ceil(maxOutputTokens / 2) - compactionRequestOverhead();
}

/**
 * The floor of one summary chunk (context compaction spec §4.5): the running summary can shrink a
 * later chunk below it, and such a chunk fails with a clear reason instead of letting
 * {@link nextTranscriptChunk} clamp to one token and make a call per token. A base chunk below it
 * (a window that leaves no room for a chunked compaction) falls back to one call over the whole
 * transcript.
 */
export const MIN_COMPACTION_CHUNK_TOKENS = 256;

/**
 * Compaction trigger (context compaction spec §4.1): the calibrated estimate reaches the lower of
 * `threshold × window` and the input budget, or it reaches the hard line `estimate + output >
 * window`, which fires even when proactive early compaction is turned off (`enabled: false`).
 * `settings.maxOutputTokens` here carries `O`, the request's output cap (§4.1), not the summary cap (§4.8).
 */
export function shouldCompact(
  estimate: number,
  window: number,
  settings: CompactionSettings,
): boolean {
  const output = settings.maxOutputTokens;
  if (estimate + output > window) return true;
  if (!settings.enabled) return false;
  return (
    estimate >=
    Math.min(
      settings.threshold * window,
      compactionInputBudget(window, output, settings.reserveTokens),
    )
  );
}

/**
 * The compaction plan: keep the most recent `settings.keepRecentTurns` turns verbatim (a maximum,
 * not a rule) and transcribe everything older that the previous summary does not cover yet (that
 * summary goes first, for the new summary to merge).
 *
 * The kept tail shrinks turn by turn, down to the latest user turn, until its estimated tokens fit
 * `budget` — the input room left after the output cap, the reserve, the system prompt and the tool
 * definitions. When the latest user turn alone does not fit (context compaction spec §4.2, revision
 * 2026-11-15), the boundary moves inside it, to tool-pair boundaries oldest first, until the tail
 * fits or only the latest tool pair (the latest assistant message with tool calls, and what follows
 * it) is left; the summary then covers the turn's user message, which request building shows again
 * right after the summary (build.ts). A latest turn without a tool pair is kept whole (the hard fit
 * guard handles the rest). `coversUpToSeq` is the largest seq before the first kept event. Returns
 * null when there is nothing to summarize.
 */
export function compactionPlan(
  events: ConversationEvent[],
  settings: CompactionSettings,
  budget: number,
): { coversUpToSeq: number; transcript: string } | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const prev = latestSummary(sorted);
  const floor = prev ? prev.payload.coversUpToSeq : Number.NEGATIVE_INFINITY;
  const candidate = sorted.filter((e) => e.seq > floor && e.type !== "compaction_summary");

  const userIdx: number[] = [];
  candidate.forEach((e, i) => {
    if (e.type === "user_message") userIdx.push(i);
  });
  const atPair = pairBoundaries(candidate);
  const tail = tailTokens(candidate);
  const keep = settings.keepRecentTurns;
  let boundary: number;
  if (keep <= 0) boundary = candidate.length;
  else if (userIdx.length < keep) boundary = 0;
  else boundary = userIdx[userIdx.length - keep] as number;
  boundary = keepToolPairs(atPair, userIdx, boundary);

  if (boundary < candidate.length && (tail[boundary] as number) > budget) {
    // size-aware tail: drop earlier kept turns until the rest fits the budget
    for (const start of userIdx) {
      if (start <= boundary) continue;
      boundary = keepToolPairs(atPair, userIdx, start);
      if ((tail[boundary] as number) <= budget) break;
    }
    // the latest user turn alone is over the budget: cut inside it at a tool-pair boundary,
    // oldest first, never past the latest tool pair (spec §4.2, revision 2026-11-15)
    if ((tail[boundary] as number) > budget) {
      let limit = -1;
      for (let i = candidate.length - 1; i > boundary && limit < 0; i--) {
        const e = candidate[i] as ConversationEvent;
        if (e.type === "assistant_message" && e.payload.content.some((b) => b.type === "tool_call"))
          limit = i;
      }
      let chosen = boundary;
      for (let j = boundary + 1; j <= limit; j++) {
        if (!atPair[j]) continue;
        chosen = j;
        if ((tail[j] as number) <= budget) break;
      }
      boundary = chosen;
    }
  }

  const lines: string[] = [];
  for (const e of candidate.slice(0, boundary)) {
    const line = transcriptLine(e);
    if (line) lines.push(line);
  }
  if (lines.length === 0) return null;

  const boundarySeq = candidate[boundary]?.seq ?? Number.POSITIVE_INFINITY;
  let coversUpToSeq = floor;
  for (const e of sorted) if (e.seq < boundarySeq && e.seq > coversUpToSeq) coversUpToSeq = e.seq;

  const parts = prev ? [`[Earlier summary]\n${prev.payload.text}`, ...lines] : lines;
  return { coversUpToSeq, transcript: parts.join("\n\n") };
}

/**
 * Estimated input tokens of the kept tail from each index (`out[i]` for the events from `i` on,
 * `out[length]` = 0): the events rendered as the transcript renders them, then estimated with the
 * request estimator.
 */
function tailTokens(candidate: ConversationEvent[]): number[] {
  const out = new Array<number>(candidate.length + 1).fill(0);
  for (let i = candidate.length - 1; i >= 0; i--) {
    const line = transcriptLine(candidate[i] as ConversationEvent);
    const own = line
      ? estimateTokens([{ role: "user", content: [{ type: "text", text: line }] }], [])
      : 0;
    out[i] = (out[i + 1] as number) + own;
  }
  return out;
}

/**
 * The tool-pair boundaries (`out[j]` for a cut before index `j`, `out[length]` = true): no tool
 * call before `j` has its result at or after `j`. A tool that ran during an interjection
 * (user_message) has the message between its call and its result, so that message is no
 * boundary: cutting there would leave the result without its call, and request building drops such
 * a result. Calls whose result was never written do not count (the pairing guard pads them).
 */
function pairBoundaries(candidate: ConversationEvent[]): boolean[] {
  const key = (runId: string | null, callId: string) => `${runId ?? ""}\u0000${callId}`;
  const resultAt = new Map<string, number>();
  candidate.forEach((e, i) => {
    if (e.type !== "tool_result") return;
    const k = key(e.runId, e.payload.callId);
    if (!resultAt.has(k)) resultAt.set(k, i);
  });
  // open[j] > 0: some call before j has its result at or after j (a difference array)
  const open = new Array<number>(candidate.length + 2).fill(0);
  candidate.forEach((e, i) => {
    if (e.type !== "assistant_message") return;
    for (const b of e.payload.content) {
      if (b.type !== "tool_call") continue;
      const at = resultAt.get(key(e.runId, b.id));
      if (at === undefined || at <= i) continue;
      open[i + 1] = (open[i + 1] as number) + 1;
      open[at + 1] = (open[at + 1] as number) - 1;
    }
  });
  const out: boolean[] = [];
  let depth = 0;
  for (let j = 0; j <= candidate.length; j++) {
    depth += open[j] as number;
    out.push(depth === 0);
  }
  return out;
}

/**
 * A turn boundary that would split a tool call from its result moves back to the latest
 * user_message before it that is a tool-pair boundary (none: 0, nothing of this part is
 * summarised).
 */
function keepToolPairs(atPair: boolean[], userIdx: number[], boundary: number): number {
  if (atPair[boundary]) return boundary;
  for (let k = userIdx.length - 1; k >= 0; k--) {
    const u = userIdx[k] as number;
    if (u < boundary && atPair[u]) return u;
  }
  return 0;
}

function transcriptLine(e: ConversationEvent): string | null {
  switch (e.type) {
    case "user_message": {
      const body = renderBlocks(e.payload.content);
      if (!body) return null;
      // scheduled tasks spec §12: the header the request shows, so the summary keeps the origin
      const schedule = e.payload.schedule;
      const text = schedule === undefined ? body : `${scheduleHeader(schedule)} ${body}`;
      // run context spec §5: the sender as logged (older logs have none: unchanged)
      const sender = e.payload.sender;
      return sender !== undefined
        ? `User (${senderTranscriptLabel(sender)}): ${text}`
        : `User: ${text}`;
    }
    case "assistant_message": {
      const text = renderBlocks(e.payload.content);
      return text ? `Assistant: ${text}` : null;
    }
    case "reminder":
      return `System reminder: ${e.payload.text}`;
    // a tool set change is a system message of the request (build.ts); kept in the transcript so
    // the summary does not carry an earlier "I have no such tool" forward as current
    case "tools_changed":
      return `System reminder: ${toolsChangedText(e.payload)}`;
    // a finished background task is a system message of the request (build.ts)
    case "background_task_finished":
      return `System reminder: ${renderBackgroundFinished(e.payload)}`;
    // a sub-agent's delivery is a system message of the request (build.ts)
    case "subagent_delivery":
      return `System reminder: ${renderSubagentDelivery(e.payload)}`;
    // phase D: a forked skill's report is user content of the request (build.ts)
    case "skill_fork_result":
      return `User: ${e.payload.text}`;
    // device_paths is left out too: the latest one follows the summary (build.ts)
    // run_context is left out: its current values follow the summary anyway (build.ts), and
    // stale names should not be summarised as current
    case "tool_result":
      return `Tool result ${e.payload.toolKey}${e.payload.isError ? " (error)" : ""}: ${e.payload.content}`;
    default:
      return null;
  }
}

/**
 * 内容块转纯文本；思考块不进记录，媒体块记为 `[image: "<name>"]` / `[document: "<name>"]`
 * （名字按 JSON.stringify 加引号，与请求里的占位一致）。
 */
function renderBlocks(blocks: EventPayload<"user_message">["content"]): string {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "text":
        if (b.text) out.push(b.text);
        break;
      case "tool_call":
        out.push(`[Tool call ${b.name}: ${JSON.stringify(b.input) ?? ""}]`);
        break;
      case "tool_result":
        out.push(`[Tool result${b.isError ? " (error)" : ""}: ${b.content}]`);
        break;
      case "thinking":
        break;
      case "image":
      case "document":
        out.push(`[${b.type}: ${JSON.stringify(b.name ?? "attachment")}]`);
        break;
    }
  }
  return out.join("\n");
}

/**
 * The text to store as the compaction summary (context compaction spec §4.2.1): the `<summary>`
 * block when the model returned one, since the `<analysis>` scratchpad must never be sent in a
 * later request; otherwise the answer with any `<analysis>` block and any dangling `<summary>` tag
 * removed (a truncated response may have been cut off after the opening tag). Trimmed; an empty
 * result fails the attempt.
 */
export function extractSummary(text: string): string {
  const block = /<summary>([\s\S]*?)<\/summary>/i.exec(text);
  if (block) return (block[1] ?? "").trim();
  return text
    .replace(/<analysis>[\s\S]*?<\/analysis>/gi, "")
    .replace(/<\/?summary>/gi, "")
    .trim();
}

/** The marker a hard-split line carries where it was cut (context compaction spec §4.5). */
const CHUNK_SPLIT_MARKER = "\n[chunk split]\n";

/** Estimated tokens the split marker adds to a chunk. */
const CHUNK_SPLIT_TOKENS = textTokens(CHUNK_SPLIT_MARKER);

/** Estimated tokens a line separator adds to a chunk. */
const NEWLINE_TOKENS = textTokens("\n");

/**
 * The next chunk of a transcript and what is left to summarise (context compaction spec §4.5):
 * whole lines up to `chunkSize` estimated tokens, counting the line separators; a single line over
 * the chunk size (usually a tool result) is hard-split at a character boundary with the split
 * marker, never inside a UTF-16 surrogate pair, and the rest of the line stays for the next call.
 * Null for empty input.
 */
export function nextTranscriptChunk(
  transcript: string,
  chunkSize: number,
): { chunk: string; rest: string } | null {
  if (transcript.length === 0) return null;
  const max = Math.max(1, chunkSize);
  const lines = transcript.split("\n");
  const taken: string[] = [];
  let tokens = 0;
  let ended = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lineTokens = textTokens(line);
    if (lineTokens > max && taken.length === 0) {
      // the loop only breaks on the transcript's first line (every other line is taken or ends a
      // chunk), so the rest is the transcript after the piece: no marker is left in it, or the
      // next split would count the marker as content
      const pieces = splitLine(line, Math.max(1, max - CHUNK_SPLIT_TOKENS));
      const head = pieces[0] as string;
      return { chunk: `${head}${CHUNK_SPLIT_MARKER}`, rest: transcript.slice(head.length) };
    }
    const cost = lineTokens + (taken.length > 0 ? NEWLINE_TOKENS : 0);
    if (taken.length > 0 && tokens + cost > max) break;
    taken.push(line);
    tokens += cost;
    ended = i + 1;
  }
  return { chunk: taken.join("\n"), rest: lines.slice(ended).join("\n") };
}

/**
 * Splits a transcript into chunks of at most `chunkSize` estimated tokens at line boundaries
 * (context compaction spec §4.5). A single line over the chunk size is hard-split at a character
 * boundary rather than failing, its pieces marked with {@link CHUNK_SPLIT_MARKER}. Empty input
 * returns no chunks; input that fits returns itself as the only chunk.
 */
export function chunkTranscript(transcript: string, chunkSize: number): string[] {
  const chunks: string[] = [];
  let rest: string | null = transcript;
  while (rest !== null) {
    const next = nextTranscriptChunk(rest, chunkSize);
    if (next === null) break;
    // an empty piece carries nothing (a transcript of blank lines only)
    if (next.chunk !== "") chunks.push(next.chunk);
    rest = next.rest.length === 0 ? null : next.rest;
  }
  return chunks;
}

/**
 * Cuts a line into pieces of at most `max` estimated tokens, at character boundaries. Iterates
 * code points (not UTF-16 units), so a surrogate pair is never split.
 */
function splitLine(line: string, max: number): string[] {
  const pieces: string[] = [];
  let start = 0;
  let ascii = 0;
  let other = 0;
  let i = 0;
  while (i < line.length) {
    const code = line.codePointAt(i) as number;
    const isAscii = code < 128;
    const nextAscii = ascii + (isAscii ? 1 : 0);
    const nextOther = other + (isAscii ? 0 : 1);
    if (i > start && Math.ceil(nextAscii / 4 + nextOther) > max) {
      pieces.push(line.slice(start, i));
      start = i;
      ascii = isAscii ? 1 : 0;
      other = isAscii ? 0 : 1;
    } else {
      ascii = nextAscii;
      other = nextOther;
    }
    // a surrogate pair is two UTF-16 units, one code point
    i += code > 0xffff ? 2 : 1;
  }
  pieces.push(line.slice(start));
  return pieces;
}

/**
 * The summary request: the marked English instruction as the system prompt and the transcript as
 * the only user message. `maxOutputTokens` is the effective `compaction.maxOutputTokens` setting,
 * which the caller narrows to the model's own cap (context compaction spec §4.8); omitted, it is
 * the built-in default.
 */
export function buildCompactionRequest(
  transcript: string,
  model: string,
  maxOutputTokens: number = COMPACTION_MAX_OUTPUT_TOKENS,
): ModelRequest {
  return {
    model,
    system: [{ text: COMPACTION_INSTRUCTION, cache: false }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: transcriptWrapper(transcript) }],
      },
    ],
    tools: [],
    maxOutputTokens,
    params: {},
  };
}

/** Estimated input tokens of a plain text (a user message carries nothing else). */
function textTokens(text: string): number {
  return estimateTokens([{ role: "user", content: [{ type: "text", text }] }], []);
}

/**
 * What a compaction saved (context compaction spec §4.9): the estimated transcript input minus the
 * stored summary output. Floored at zero — a summary at least as long as the transcript saved no
 * tokens, and `savedTokens` is a non-negative count — so the UI can render it as "saved N".
 */
export function summarySavedTokens(transcript: string, summary: string): number {
  return Math.max(0, textTokens(transcript) - textTokens(summary));
}

/** A summary of at least min(200, 5% of the transcript) characters is accepted; shorter fails. */
export function acceptSummary(text: string, transcript: string): boolean {
  const min = Math.min(MIN_SUMMARY_CHARS, transcript.length * MIN_SUMMARY_RATIO);
  return text.trim().length >= min;
}

/**
 * 压缩失败后的退避：最近一次 `compaction_failed`（attempt = n）之后新增的 user 轮次少于 2^n 时
 * 返回 true（本轮跳过压缩）。之后已有成功摘要、或从未失败，返回 false。
 */
export function compactionBackoff(events: ConversationEvent[]): boolean {
  let failure: { seq: number; attempt: number } | null = null;
  for (const e of events) {
    if (e.type === "compaction_failed" && (!failure || e.seq > failure.seq)) {
      failure = { seq: e.seq, attempt: e.payload.attempt };
    }
  }
  if (!failure) return false;
  let turns = 0;
  for (const e of events) {
    if (e.seq <= failure.seq) continue;
    if (e.type === "compaction_summary") return false;
    if (e.type === "user_message") turns++;
  }
  return turns < 2 ** failure.attempt;
}
