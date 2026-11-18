import { isDeepStrictEqual } from "node:util";
import type { ConversationSource, ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import type { ConversationKind } from "../db/kernel-schema.js";
import { reconstructInputs, reconstructRequest } from "../evals/reconstruct.js";
import { type CaseSnapshot, toEvents } from "../evals/snapshot.js";
import type { MediaBytes, MediaInfo } from "../runtime/context/build.js";
import { estimateTokens } from "../runtime/context/tokens.js";
import { assembleModelRequest } from "../runtime/model-call.js";
import { HIDDEN_FORMAT_RE } from "../text.js";
import type { ConversationEvent, EventPayload } from "./events.js";

/**
 * Prompt suggestions (spec 2026-11-19 §1, §2): the pure part of the side request sent after a
 * completed web run. The request is the run's last request rebuilt through the eval zero-drift
 * path, plus the final reply and {@link PROMPT_SUGGESTION_INSTRUCTION}; only the output cap and
 * `purpose` change besides, so the provider's prompt cache serves the prefix.
 */

/** The appended instruction (model-facing, English; spec §1.3). */
export const PROMPT_SUGGESTION_INSTRUCTION =
  "The user has not replied yet. Write the message the user is most likely to send next in this " +
  "conversation, as the user would type it, in the language the user writes in. Keep it short " +
  "(at most 12 words, or about 25 CJK characters) and specific to what just happened: a natural " +
  "follow-up request, a choice between options you offered, or a go-ahead to continue. Do not " +
  "answer it, do not call tools and do not explain. Reply with the message text only, or with " +
  "exactly NONE when no next message is clear.";

/** The side request's output cap ceiling (a cost ceiling, not a target; spec §1.4). */
export const PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS = 2048;
/** Above this many input tokens with no cache activity on the last step, skip (spec §1.5). */
export const PROMPT_SUGGESTION_UNCACHED_INPUT_MAX = 8000;
/** A job that starts later than this after the run finished is stale (spec §1.5). */
export const PROMPT_SUGGESTION_MAX_DELAY_MS = 60_000;
/** The side call's time limit (spec §1.6). */
export const PROMPT_SUGGESTION_TIMEOUT_MS = 60_000;
/** The longest suggestion kept, in characters (code points; spec §1.7). */
export const PROMPT_SUGGESTION_MAX_CHARS = 200;

/** Why no side request is built for a run. */
export type SuggestionSkip =
  | "no_model_call"
  | "no_final_reply"
  | "final_reply_has_tool_call"
  | "drift"
  | "fit"
  | "prefix_mismatch"
  | "too_large"
  | "uncached";

type ModelCallEvent = Extract<ConversationEvent, { type: "model_call" }>;
type AssistantEvent = Extract<ConversationEvent, { type: "assistant_message" }>;
type UsageEvent = Extract<ConversationEvent, { type: "usage" }>;

/** The run's last `model_call` (the highest seq with the run's id), or undefined. */
export function lastModelCallOf(
  events: readonly ConversationEvent[],
  runId: string,
): ModelCallEvent | undefined {
  let last: ModelCallEvent | undefined;
  for (const e of events) {
    if (e.type === "model_call" && e.runId === runId && (last === undefined || e.seq > last.seq)) {
      last = e;
    }
  }
  return last;
}

function lastOfRun<T extends ConversationEvent>(
  events: readonly ConversationEvent[],
  runId: string,
  pick: (e: ConversationEvent) => e is T,
): T | undefined {
  let last: T | undefined;
  for (const e of events) {
    if (e.runId === runId && pick(e) && (last === undefined || e.seq > last.seq)) last = e;
  }
  return last;
}

/**
 * The side request, or why there is none (spec §1). `model` is the current info of the last
 * call's provider and model as the caller resolved it for the org; `mediaInfo` / `media` come from
 * `loadSnapshotMedia` for that call; `reserveTokens` is the org's compaction reserve.
 *
 * Checks, in order: a last `model_call` of the run; no recorded fit plan; a final
 * `assistant_message` after that call with text and no `tool_call`; the run's last step usage
 * shows cache activity or a small input; the baseline reconstruction has no drift; the extension
 * (the same inputs with the events up to the final reply) keeps `system`, `tools`, `toolChoice`,
 * `params` and the messages as a prefix, followed by exactly one assistant message; the estimate
 * plus the cap fits `contextWindow - reserveTokens`.
 */
export function buildSuggestionRequest(input: {
  snapshot: CaseSnapshot;
  model: ModelInfo;
  mediaInfo?: ReadonlyMap<string, MediaInfo>;
  media?: ReadonlyMap<string, MediaBytes | null>;
  reserveTokens: number;
}):
  | {
      request: ModelRequest;
      lastCall: { seq: number; provider: string; model: string };
      finalText: string;
      estimate: number;
    }
  | { skip: SuggestionSkip } {
  const { snapshot, model } = input;
  const runId = snapshot.runId;
  const opts = {
    model,
    ...(input.mediaInfo !== undefined && { mediaInfo: input.mediaInfo }),
    ...(input.media !== undefined && { media: input.media }),
  };
  const events = toEvents(snapshot);
  const call = lastModelCallOf(events, runId);
  if (call === undefined) return { skip: "no_model_call" };
  if (call.payload.request.fit !== undefined) return { skip: "fit" };

  const final = lastOfRun(
    events,
    runId,
    (e): e is AssistantEvent => e.type === "assistant_message",
  );
  if (final === undefined || final.seq < call.seq) return { skip: "no_final_reply" };
  const finalText = final.payload.content
    .flatMap((b) => (b.type === "text" ? [b.text] : []))
    .join("\n")
    .trim();
  if (final.payload.content.some((b) => b.type === "tool_call")) {
    return { skip: "final_reply_has_tool_call" };
  }
  if (finalText === "") return { skip: "no_final_reply" };

  const usage = lastOfRun(
    events,
    runId,
    (e): e is UsageEvent => e.type === "usage" && e.payload.purpose === undefined,
  );
  if (
    usage !== undefined &&
    usage.payload.cacheReadTokens + usage.payload.cacheWriteTokens === 0 &&
    usage.payload.inputTokens > PROMPT_SUGGESTION_UNCACHED_INPUT_MAX
  ) {
    return { skip: "uncached" };
  }

  const ref = reconstructRequest(snapshot, call.seq, opts);
  if (ref.drift.length > 0) return { skip: "drift" };
  const reference = ref.request;

  const { input: assembleInput } = reconstructInputs(snapshot, call.seq, opts);
  const { request, mediaTokens } = assembleModelRequest({
    ...assembleInput,
    events: events.filter((e) => e.seq <= final.seq),
  });
  const n = reference.messages.length;
  if (
    !isDeepStrictEqual(request.system, reference.system) ||
    !isDeepStrictEqual(request.tools, reference.tools) ||
    !isDeepStrictEqual(request.toolChoice, reference.toolChoice) ||
    !isDeepStrictEqual(request.params, reference.params) ||
    request.model !== reference.model ||
    request.messages.length !== n + 1 ||
    request.messages[n]?.role !== "assistant" ||
    !isDeepStrictEqual(request.messages.slice(0, n), reference.messages)
  ) {
    return { skip: "prefix_mismatch" };
  }

  request.messages.push({
    role: "user",
    content: [{ type: "text", text: PROMPT_SUGGESTION_INSTRUCTION }],
  });
  request.maxOutputTokens = Math.min(
    reference.maxOutputTokens,
    PROMPT_SUGGESTION_MAX_OUTPUT_TOKENS,
  );
  request.purpose = "suggestion";
  const estimate = estimateTokens(request.messages, request.system, request.tools, mediaTokens);
  if (estimate + request.maxOutputTokens > model.contextWindow - input.reserveTokens) {
    return { skip: "too_large" };
  }
  return {
    request,
    lastCall: { seq: call.seq, provider: call.payload.provider, model: call.payload.model },
    finalText,
    estimate,
  };
}

/** The run facts eligibility reads (spec §2, the first four rows). */
export interface SuggestionEligibilityInput {
  /** `run_finished.reason`. */
  outcome: EventPayload<"run_finished">["reason"];
  /** `conversations.kind`. */
  kind: ConversationKind;
  /** `conversations.source`. */
  source: ConversationSource;
  /** `run_started.trigger` (absent = a person's message). */
  trigger: EventPayload<"run_started">["trigger"];
}

/**
 * Whether a finished run may get a suggestion by its outcome, conversation and trigger (spec §2):
 * `completed` or `max_steps`, a `chat` conversation from `web`, not a scheduled or compact run.
 * The final reply, freshness and the switches are checked elsewhere.
 */
export function suggestionEligible(i: SuggestionEligibilityInput): boolean {
  return (
    (i.outcome === "completed" || i.outcome === "max_steps") &&
    i.kind === "chat" &&
    i.source === "web" &&
    i.trigger !== "schedule" &&
    i.trigger !== "compact"
  );
}

// C0 and C1 controls (newlines are split on first; a tab becomes a space)
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g;
const LINE_RE = /\r\n|[\n\r\u0085\u2028\u2029]/;
const LABEL_RE = /^(?:user|用户)\s*[:：]\s*/i;
const QUOTES: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["“", "”"],
  ["‘", "’"],
  ["「", "」"],
  ["『", "』"],
  ["«", "»"],
];
const NONE_RE = /^none[.!。！]?$/i;

function unquote(s: string): string {
  let out = s;
  for (;;) {
    const pair = QUOTES.find(
      ([open, close]) => out.length >= 2 && out.startsWith(open) && out.endsWith(close),
    );
    if (pair === undefined) return out;
    out = out.slice(pair[0].length, out.length - pair[1].length).trim();
  }
}

/**
 * The suggestion from the model's reply text (spec §1.7), or null for none: the first non-empty
 * line with control and hidden format characters removed, a leading `User:` / `用户：` label and
 * wrapping quotes stripped, trimmed, cut to {@link PROMPT_SUGGESTION_MAX_CHARS} code points.
 * `NONE` (any case), an empty result or an echo of the final reply (`finalText`) is null.
 */
export function cleanSuggestion(reply: string, finalText: string): string | null {
  const line =
    reply
      .split(LINE_RE)
      .map((l) =>
        l.replace(/\t/g, " ").replace(CONTROL_RE, "").replace(HIDDEN_FORMAT_RE, "").trim(),
      )
      .find((l) => l !== "") ?? "";
  let text = unquote(line.replace(LABEL_RE, "").trim());
  text = unquote(text.replace(LABEL_RE, "").trim());
  text = Array.from(text).slice(0, PROMPT_SUGGESTION_MAX_CHARS).join("").trim();
  if (text === "" || NONE_RE.test(text)) return null;
  if (text === finalText.trim()) return null;
  return text;
}

/** Whether the job is too late (`now - finishedAt > PROMPT_SUGGESTION_MAX_DELAY_MS`). */
export function suggestionStale(finishedAt: number, now: number): boolean {
  return now - finishedAt > PROMPT_SUGGESTION_MAX_DELAY_MS;
}
