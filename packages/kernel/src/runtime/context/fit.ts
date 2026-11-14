import type { ContentBlock, ModelInfo, ModelMessage, ModelRequest } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent } from "../../conversations/events.js";
import { estimateTokens } from "./tokens.js";

/**
 * The hard fit guard (context compaction spec §4.3): a request whose input is over the fit target is
 * trimmed with a deterministic plan, recorded in `model_call.request.fit`, and replayed by applying
 * the same plan to the rebuilt request (byte-for-byte).
 *
 * A plan names **indexes into the assembled request's message list**: `droppedMessageIndexes` are
 * message positions, and a `truncated` entry is the block index inside that message. Indexes keep
 * `applyFit` a pure function of the request alone; the builder and the replay path assemble the same
 * messages from the same log, so the same plan applies to both. A message is never split from its
 * tool call/result partner.
 */
export interface FitPlan {
  /** Indexes into the assembled request's messages, in the order they were chosen. */
  droppedMessageIndexes: number[];
  /** Text / tool_result blocks of the kept tail replaced by the note. */
  truncated: { messageIndex: number; block: number; note: string }[];
}

/** The note an oversized block carries once truncated (model-visible, English; spec §4.3). */
export const FIT_TRUNCATION_NOTE = "[content truncated to fit the model's context window]";

/**
 * The output cap actually sent (`O'`, spec §4.3 point 2): the configured cap, lowered so the
 * provider-visible total (`input + O'`) fits the window. At least one output token is always left.
 * When the window is smaller than the requested cap this is what keeps the plan's target reachable.
 */
export function clampOutput(
  contextWindow: number,
  maxOutputTokens: number,
  estimate: number,
): number {
  return Math.max(1, Math.min(maxOutputTokens, Math.max(1, contextWindow - estimate)));
}

/**
 * The reserve actually kept (`R_eff`, spec §4.3 point 2): the configured reserve, reduced to what
 * the clamped output leaves below the window. A reserve larger than the window is sacrificed
 * (the hard bound is what must hold), so the target keeps at least one token of room.
 */
export function effectiveReserve(
  contextWindow: number,
  clampedOutput: number,
  reserveTokens: number,
): number {
  return Math.min(reserveTokens, Math.max(0, contextWindow - clampedOutput - 1));
}

/** The input room left below the window: `W - O' - R_eff` with the clamped output and reserve. */
export function fitTarget(
  contextWindow: number,
  clampedOutput: number,
  reserveTokens: number,
): number {
  return contextWindow - clampedOutput - reserveTokens;
}

export interface PlanFitInput {
  /** The log the request was built from (documentation: the plan replays from it). */
  events: ConversationEvent[];
  /** The assembled request (after the pairing guard and the output-cap computation). */
  request: ModelRequest;
  /** The model the request is for: its context window is the hard bound. */
  model: ModelInfo;
  /** `O`: the requested output cap (`ModelRequest.maxOutputTokens`, before the clamp). */
  maxOutputTokens: number;
  /** `R`: the safety reserve in effect for the run's organization, before the clamp. */
  reserveTokens: number;
  /** The request's input-token estimate (uncalibrated, as recorded). */
  estimate: number;
}

const SUMMARY_OPEN = "<conversation_summary>";
const NOTE_TOKENS = estimateTokens(
  [{ role: "user", content: [{ type: "text", text: FIT_TRUNCATION_NOTE }] }],
  [],
);

/** A typed user turn (a person's message), not a tool-result carrier and not the summary. */
const isTypedUser = (m: ModelMessage): boolean =>
  m.role === "user" && m.content.some((b) => b.type !== "tool_result");

/** A message that carries only tool results (the answer to a tool call). */
const isResults = (m: ModelMessage): boolean =>
  m.role === "user" && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");

const hasToolCall = (m: ModelMessage): boolean =>
  m.role === "assistant" && m.content.some((b) => b.type === "tool_call");

/** The conversation summary message (never dropped or truncated: it is the retained history). */
const isSummary = (m: ModelMessage): boolean =>
  m.role === "user" && m.content.some((b) => b.type === "text" && b.text.startsWith(SUMMARY_OPEN));

const messageTokens = (m: ModelMessage): number => estimateTokens([m], [], []);

const blockTokens = (b: ContentBlock): number =>
  estimateTokens([{ role: "user", content: [b] }], [], []);

const truncatable = (b: ContentBlock): boolean =>
  (b.type === "text" && b.text !== FIT_TRUNCATION_NOTE) ||
  (b.type === "tool_result" && b.content !== FIT_TRUNCATION_NOTE);

/**
 * The deterministic fit plan for a request over `W - O' - R_eff` (the output cap and reserve first
 * clamped to the window, {@link clampOutput} / {@link effectiveReserve}), or null when it already
 * fits. A plan that cannot reach the target even after dropping every droppable message and
 * truncating every kept text / `tool_result` block is still returned: the caller raises
 * `run.context_too_large` before any provider call.
 *
 * Drops, in this order, every droppable message before the latest user turn until the estimate is
 * at or below the target: complete tool pairs first (a tool call with the results message that
 * follows it), then assistant text, then complete older user turns. Never a pair's half, never the
 * summary. If that is not enough, it truncates the kept tail's largest text / `tool_result` blocks
 * (replacing the content with {@link FIT_TRUNCATION_NOTE}).
 */
export function planFit(input: PlanFitInput): FitPlan | null {
  const { request, model, maxOutputTokens, reserveTokens, estimate } = input;
  const output = clampOutput(model.contextWindow, maxOutputTokens, estimate);
  const reserve = effectiveReserve(model.contextWindow, output, reserveTokens);
  const target = fitTarget(model.contextWindow, output, reserve);
  if (target <= 0 || estimate <= target) return null;

  const messages = request.messages;
  // the latest user turn and everything after it are kept (the turn being answered); older
  // messages may go
  const lastTyped = messages.findLastIndex(isTypedUser);
  const keepFrom = lastTyped < 0 ? messages.length : lastTyped;
  const droppable = (i: number): boolean => {
    const m = messages[i];
    return i < keepFrom && m !== undefined && m.role !== "system" && !isSummary(m);
  };

  const plan: FitPlan = { droppedMessageIndexes: [], truncated: [] };
  const dropped = new Set<number>();
  let current = estimate;
  const drop = (indexes: readonly number[]): void => {
    for (const i of indexes) {
      if (dropped.has(i)) continue;
      const m = messages[i];
      if (m === undefined) continue;
      dropped.add(i);
      plan.droppedMessageIndexes.push(i);
      current -= messageTokens(m);
    }
  };

  // complete tool pairs, oldest first: an assistant message with at least one tool call and the
  // results message that follows it stay together (its half would orphan the other)
  for (let i = 0; i < keepFrom && current > target; i++) {
    if (!droppable(i)) continue;
    const m = messages[i] as ModelMessage;
    if (!hasToolCall(m)) continue;
    const next = messages[i + 1];
    if (next === undefined || i + 1 >= keepFrom || !isResults(next)) continue;
    drop([i, i + 1]);
    i++;
  }
  // assistant text, oldest first
  for (let i = 0; i < keepFrom && current > target; i++) {
    if (!droppable(i) || dropped.has(i)) continue;
    const m = messages[i] as ModelMessage;
    if (m.role !== "assistant" || hasToolCall(m)) continue;
    drop([i]);
  }
  // complete older user turns, oldest first (their replies are already gone)
  for (let i = 0; i < keepFrom && current > target; i++) {
    if (!droppable(i) || dropped.has(i)) continue;
    if (!isTypedUser(messages[i] as ModelMessage)) continue;
    drop([i]);
  }
  if (current <= target) return plan;

  // the latest turn alone is too large: replace its largest text / tool_result blocks (and those of
  // the kept tail) with the note, largest first, ties by position
  const candidates: { messageIndex: number; block: number; tokens: number }[] = [];
  for (let i = keepFrom; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined || m.role === "system" || isSummary(m)) continue;
    m.content.forEach((b, block) => {
      if (!truncatable(b)) return;
      const tokens = blockTokens(b);
      if (tokens > NOTE_TOKENS) candidates.push({ messageIndex: i, block, tokens });
    });
  }
  candidates.sort(
    (a, b) => b.tokens - a.tokens || a.messageIndex - b.messageIndex || a.block - b.block,
  );
  for (const c of candidates) {
    if (current <= target) break;
    current -= c.tokens - NOTE_TOKENS;
    plan.truncated.push({
      messageIndex: c.messageIndex,
      block: c.block,
      note: FIT_TRUNCATION_NOTE,
    });
  }
  return plan;
}

/**
 * Applies a plan to an assembled request (pure): drops the named messages and replaces the named
 * blocks' content with their note. Message and block indexes refer to the request as given, so the
 * runtime and the replay path (rebuilding the same messages from the log) produce the same request.
 */
export function applyFit(request: ModelRequest, plan: FitPlan): ModelRequest {
  const dropped = new Set(plan.droppedMessageIndexes);
  const truncated = new Map<number, Map<number, string>>();
  for (const t of plan.truncated) {
    const byBlock = truncated.get(t.messageIndex) ?? new Map<number, string>();
    byBlock.set(t.block, t.note);
    truncated.set(t.messageIndex, byBlock);
  }
  const messages: ModelMessage[] = [];
  request.messages.forEach((m, i) => {
    if (dropped.has(i)) return;
    const notes = truncated.get(i);
    if (notes === undefined || m.role === "system") {
      messages.push(m);
      return;
    }
    messages.push({
      ...m,
      content: m.content.map((b, block): ContentBlock => {
        const note = notes.get(block);
        if (note === undefined) return b;
        if (b.type === "text") return { type: "text", text: note };
        if (b.type === "tool_result") return { ...b, content: note };
        return b;
      }),
    });
  });
  return { ...request, messages };
}

/**
 * The request's estimate after `plan` is applied: the given estimate minus the dropped messages and
 * the truncated blocks' savings. Same arithmetic as {@link planFit} used to stop, so a plan that
 * reached the target is known to have done so without re-estimating the whole request.
 */
export function estimateAfterFit(request: ModelRequest, estimate: number, plan: FitPlan): number {
  let out = estimate;
  for (const i of plan.droppedMessageIndexes) {
    const m = request.messages[i];
    if (m !== undefined) out -= messageTokens(m);
  }
  for (const t of plan.truncated) {
    const m = request.messages[t.messageIndex];
    if (m === undefined || m.role === "system") continue;
    const b = m.content[t.block];
    if (b === undefined) continue;
    out -= blockTokens(b) - NOTE_TOKENS;
  }
  return out;
}
