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
 * The planning bounds of a window (context compaction spec §4.1, revision 2026-11-15): every plan
 * (the trigger, the compaction tail, the fit guard, the reactive trim) uses `O_p = min(O, ⌊W/2⌋)`
 * (at least 1) and `R_p = min(R, ⌊W/8⌋)` in place of the output cap and the reserve, so the input
 * target `W - O_p - R_p` is at least `3W/8` on any model. Without them a model whose output cap is
 * about its window, or whose window is smaller than the reserve, had a target of about one token.
 * Common models are unchanged (W 200k, O 32k, R 8k: `O_p = O`, `R_p = R`).
 */
export function planningBounds(
  contextWindow: number,
  maxOutputTokens: number,
  reserveTokens: number,
): { output: number; reserve: number; target: number } {
  const output = Math.max(1, Math.min(maxOutputTokens, Math.floor(contextWindow / 2)));
  const reserve = Math.max(0, Math.min(reserveTokens, Math.floor(contextWindow / 8)));
  return { output, reserve, target: contextWindow - output - reserve };
}

/**
 * The output cap actually sent (`O'`, spec §4.1 / §4.3 point 4): `clamp(O, 1, W - input - R_p)`,
 * from the input actually sent (after the fit plan). The configured cap whenever it fits beside the
 * input and the reserve; otherwise what is left, the reserve kept. Every path (ordinary, squeezed,
 * reactive) clamps with it.
 */
export function sentOutputCap(
  contextWindow: number,
  maxOutputTokens: number,
  inputSent: number,
  reserveTokens: number,
): number {
  const { reserve } = planningBounds(contextWindow, maxOutputTokens, reserveTokens);
  return Math.max(1, Math.min(maxOutputTokens, contextWindow - inputSent - reserve));
}

export interface PlanFitInput {
  /** The log the request was built from (documentation: the plan replays from it). */
  events: ConversationEvent[];
  /** The assembled request (after the pairing guard and the output-cap computation). */
  request: ModelRequest;
  /** The model the request is for: its context window is the hard bound. */
  model: ModelInfo;
  /** `O`: the requested output cap (`ModelRequest.maxOutputTokens`, unclamped; bounded here). */
  maxOutputTokens: number;
  /** `R`: the safety reserve in effect for the run's organization (unreduced; bounded here). */
  reserveTokens: number;
  /** The request's input-token estimate (uncalibrated, as recorded). */
  estimate: number;
}

const SUMMARY_OPEN = "<conversation_summary>";
const NOTE_TOKENS = estimateTokens(
  [{ role: "user", content: [{ type: "text", text: FIT_TRUNCATION_NOTE }] }],
  [],
);

/** The summary text block (never truncated: it is the retained history). */
const isSummaryText = (b: ContentBlock): boolean =>
  b.type === "text" && b.text.startsWith(SUMMARY_OPEN);

/**
 * The conversation summary message (never dropped; its summary text is never truncated, the
 * re-rendered opening user message after it may be: spec §4.3 point 5).
 */
const isSummary = (m: ModelMessage): boolean => m.role === "user" && m.content.some(isSummaryText);

/**
 * A typed user turn (a person's message): not a tool-result carrier and not the summary, which may
 * cover the latest typed message (spec §4.2, revision 2026-11-15).
 */
const isTypedUser = (m: ModelMessage): boolean =>
  m.role === "user" && m.content.some((b) => b.type !== "tool_result") && !isSummary(m);

/** A message that carries only tool results (the answer to a tool call). */
const isResults = (m: ModelMessage): boolean =>
  m.role === "user" && m.content.length > 0 && m.content.every((b) => b.type === "tool_result");

const hasToolCall = (m: ModelMessage): boolean =>
  m.role === "assistant" && m.content.some((b) => b.type === "tool_call");

const messageTokens = (m: ModelMessage): number => estimateTokens([m], [], []);

const blockTokens = (b: ContentBlock): number =>
  estimateTokens([{ role: "user", content: [b] }], [], []);

const truncatable = (b: ContentBlock): boolean =>
  (b.type === "text" && b.text !== FIT_TRUNCATION_NOTE) ||
  (b.type === "tool_result" && b.content !== FIT_TRUNCATION_NOTE);

/**
 * The deterministic fit plan for a request over the planning target `W - O_p - R_p`
 * ({@link planningBounds}), or null when it already fits. A plan that cannot reach the target even after dropping every droppable
 * message and truncating every kept text / `tool_result` block is still returned: the caller decides
 * (the ordinary guard fails before any provider call).
 *
 * Drops, in this order, until the estimate is at or below the target: before the latest user turn,
 * complete tool pairs first (a tool call with the results message that follows it), then assistant
 * text, then complete older user turns; then the complete tool pairs inside the latest user turn,
 * oldest first, stopping before the latest complete pair (spec §4.3, revision 2026-11-15). The
 * latest typed message stays (when the summary covers it, the turn starts after the summary). Never
 * a pair's half, never the summary or a system message. If that is not enough, it truncates the kept
 * messages' largest text / `tool_result` blocks (replacing the content with
 * {@link FIT_TRUNCATION_NOTE}); in the summary message only the blocks after the summary text (the
 * re-rendered opening user message) are candidates.
 */
export function planFit(input: PlanFitInput): FitPlan | null {
  const { model, maxOutputTokens, reserveTokens } = input;
  return planFitTo(
    input,
    planningBounds(model.contextWindow, maxOutputTokens, reserveTokens).target,
  );
}

/** {@link planFit} against an explicit input target (the squeezed fit, the reactive trim). */
function planFitTo(input: PlanFitInput, target: number): FitPlan | null {
  const { request, estimate } = input;
  if (target <= 0 || estimate <= target) return null;

  const messages = request.messages;
  // the latest user turn starts at the latest typed message, or (when the summary covers it) at the
  // start: older messages may go whole, the turn itself only as complete tool pairs
  const lastTyped = messages.findLastIndex(isTypedUser);
  const keepFrom = lastTyped < 0 ? 0 : lastTyped;
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
  // complete tool pairs inside the latest user turn, oldest first, keeping the latest complete pair
  // (the one the next step answers)
  const isPairAt = (i: number): boolean => {
    const m = messages[i];
    const next = messages[i + 1];
    return m !== undefined && hasToolCall(m) && next !== undefined && isResults(next);
  };
  let latestPair = -1;
  for (let i = messages.length - 2; i >= keepFrom; i--) {
    if (isPairAt(i)) {
      latestPair = i;
      break;
    }
  }
  for (let i = keepFrom; i < latestPair && current > target; i++) {
    if (!isPairAt(i)) continue;
    drop([i, i + 1]);
    i++;
  }
  if (current <= target) return plan;

  // still too large: replace the kept messages' largest text / tool_result blocks with the note,
  // largest first, ties by position. In the summary message only the summary text is protected:
  // the turn's opening message re-rendered after it (spec §4.2) is a kept block like any other
  const candidates: { messageIndex: number; block: number; tokens: number }[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m === undefined || dropped.has(i) || m.role === "system") continue;
    if (i < keepFrom && !isSummary(m)) continue;
    m.content.forEach((b, block) => {
      if (!truncatable(b) || isSummaryText(b)) return;
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
 * The fallback when {@link planFit} cannot reach its target, even after one forced compaction
 * (spec §4.3 point 5): plan against `W - 1 - R_p`, giving the output whatever the input leaves
 * while the reserve stays. The caller sends the cap {@link sentOutputCap} gives from the post-fit
 * estimate. A plan that cannot reach this target either means the system prompt, tools, summary and
 * latest pair are too large (`run.context_too_large`).
 */
export function planSqueezedFit(input: PlanFitInput): { plan: FitPlan | null; target: number } {
  const { model, maxOutputTokens, reserveTokens } = input;
  const { reserve } = planningBounds(model.contextWindow, maxOutputTokens, reserveTokens);
  const target = model.contextWindow - 1 - reserve;
  return { plan: planFitTo(input, target), target };
}

/** The reactive trim's fractions of the fit target, most aggressive first (spec §4.3 point 6). */
export const REACTIVE_TRIM_FACTORS = [0.7, 0.8, 0.9] as const;

/**
 * The deterministic plan for a reactive trim (spec §4.3 point 6 / §4.4): the provider rejected a
 * request the estimate thought fit, so the retry is trimmed against 70%, 80% or 90% of the fit
 * target `W - O_p - R_p`, the most aggressive one the plan actually reaches (its estimate after the
 * plan at or below it). Null when none is reached (a plan that cannot reach even 90% would replace
 * every kept block with notes) or when the request already fits 70% (nothing to trim, the same
 * request would be rejected again): no trim retry, the step surfaces `model.context_overflow`. The
 * plan is ordinary and replays byte-for-byte like any other.
 */
export function planReactiveTrim(input: PlanFitInput): FitPlan | null {
  const { request, model, maxOutputTokens, reserveTokens, estimate } = input;
  const { target } = planningBounds(model.contextWindow, maxOutputTokens, reserveTokens);
  for (const factor of REACTIVE_TRIM_FACTORS) {
    const t = Math.floor(factor * target);
    const plan = planFitTo(input, t);
    if (plan === null) return null;
    if (estimateAfterFit(request, estimate, plan) <= t) return plan;
  }
  return null;
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
