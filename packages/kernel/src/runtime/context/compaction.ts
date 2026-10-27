import type { ModelInfo, ModelRequest } from "@capybara-hq/plugin-sdk";
import type { ConversationEvent, EventPayload } from "../../conversations/events.js";
import { latestSummary } from "./build.js";

/** 压缩请求的标记：放在 system 中，便于识别（model-fake 据此返回摘要）。 */
export const COMPACTION_MARKER = "CAPYBARA_COMPACTION";

/** 压缩请求的输出上限。 */
export const COMPACTION_MAX_OUTPUT_TOKENS = 4096;

/** 摘要的最短长度：200 字符或原文的 5%，取较小者。 */
const MIN_SUMMARY_CHARS = 200;
const MIN_SUMMARY_RATIO = 0.05;

/** 摘要指令（模型可见，英文）。 */
const COMPACTION_INSTRUCTION = [
  COMPACTION_MARKER,
  "You are summarizing the earlier part of a conversation between people and an AI agent, so the agent can continue without the full history.",
  "Write a concise but complete summary that preserves: the users' goals and requests, decisions made, facts and data established (names, numbers, identifiers, file names, links), work completed and its results, and open questions or pending tasks.",
  "If the transcript starts with an earlier summary, merge it into your summary.",
  "Write in the same language as the conversation. Output only the summary text.",
].join("\n");

/** 估算 token 数达到上下文窗口的 `threshold`（如 0.8）时压缩。 */
export function shouldCompact(
  estimatedTokens: number,
  model: ModelInfo,
  threshold: number,
): boolean {
  return estimatedTokens >= model.contextWindow * threshold;
}

/**
 * 压缩计划：保留最近 `keepRecentTurns` 个「以 user_message 开头的轮次」原文，把更早、且尚未被
 * 上一条摘要覆盖的内容转成纯文本对话记录（上一条摘要放在记录开头，由新摘要合并）。
 * `coversUpToSeq` 为第一条保留的 user_message 之前的最大 seq。可压缩的内容为空时返回 null。
 */
export function compactionPlan(
  events: ConversationEvent[],
  keepRecentTurns: number,
): { coversUpToSeq: number; transcript: string } | null {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const prev = latestSummary(sorted);
  const floor = prev ? prev.payload.coversUpToSeq : Number.NEGATIVE_INFINITY;
  const candidate = sorted.filter((e) => e.seq > floor && e.type !== "compaction_summary");

  const userIdx: number[] = [];
  candidate.forEach((e, i) => {
    if (e.type === "user_message") userIdx.push(i);
  });
  let boundary: number;
  if (keepRecentTurns <= 0) boundary = candidate.length;
  else if (userIdx.length < keepRecentTurns) boundary = 0;
  else boundary = userIdx[userIdx.length - keepRecentTurns] as number;
  boundary = keepToolPairs(candidate, userIdx, boundary);

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
 * 边界不得切开工具调用与其结果：工具运行期间到达的插话（user_message）记在 assistant 的 tool_call 与
 * tool_result 之间，若它成了边界，assistant 进摘要而结果留在原文，构建请求时结果因找不到调用被丢弃。
 * 做法：边界之前仍「未结束」（结果在边界之后）的调用存在时，把边界退到最早那条未结束 assistant 之前的
 * 最近一个 user_message（没有则 0，即不压缩这段），重复直到没有被切开的调用。结果从未写入的调用不算
 * （它们由配对守卫补 unknown，与边界无关）。
 */
function keepToolPairs(
  candidate: ConversationEvent[],
  userIdx: number[],
  boundary: number,
): number {
  const key = (runId: string | null, callId: string) => `${runId ?? ""}\u0000${callId}`;
  const resultAt = new Map<string, number>();
  candidate.forEach((e, i) => {
    if (e.type !== "tool_result") return;
    const k = key(e.runId, e.payload.callId);
    if (!resultAt.has(k)) resultAt.set(k, i);
  });
  for (;;) {
    let earliestOpen = -1;
    for (let i = 0; i < boundary && earliestOpen < 0; i++) {
      const e = candidate[i] as ConversationEvent;
      if (e.type !== "assistant_message") continue;
      for (const b of e.payload.content) {
        if (b.type !== "tool_call") continue;
        const at = resultAt.get(key(e.runId, b.id));
        if (at !== undefined && at >= boundary) {
          earliestOpen = i;
          break;
        }
      }
    }
    if (earliestOpen < 0) return boundary;
    let next = 0;
    for (const u of userIdx) if (u < earliestOpen) next = u;
    boundary = next;
  }
}

function transcriptLine(e: ConversationEvent): string | null {
  switch (e.type) {
    case "user_message": {
      const text = renderBlocks(e.payload.content);
      return text ? `User: ${text}` : null;
    }
    case "assistant_message": {
      const text = renderBlocks(e.payload.content);
      return text ? `Assistant: ${text}` : null;
    }
    case "reminder":
      return `System reminder: ${e.payload.text}`;
    // phase D: a forked skill's report is user content of the request (build.ts)
    case "skill_fork_result":
      return `User: ${e.payload.text}`;
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

/** 摘要请求：system 为带标记的英文摘要指令，对话记录作为唯一一条 user 消息。 */
export function buildCompactionRequest(transcript: string, model: string): ModelRequest {
  return {
    model,
    system: [{ text: COMPACTION_INSTRUCTION, cache: false }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: `<transcript>\n${transcript}\n</transcript>` }],
      },
    ],
    tools: [],
    maxOutputTokens: COMPACTION_MAX_OUTPUT_TOKENS,
    params: {},
  };
}

/** 摘要（去掉首尾空白）至少 min(200, 原文 5%) 个字符才接受；过短视为失败（可靠性清单 A）。 */
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
