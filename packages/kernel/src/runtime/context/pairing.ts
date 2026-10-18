import type { ContentBlock, ModelMessage } from "@capybara-hq/plugin-sdk";

/** 补给缺失结果的 tool_call 的结果文案（模型可见，英文）。 */
export const UNKNOWN_RESULT_TEXT =
  "Result unknown: the call was interrupted before a result was recorded. Verify the outcome before retrying.";

type ToolResult = Extract<ContentBlock, { type: "tool_result" }>;

/**
 * tool_call / tool_result 配对守卫（spec 6.2 的独立管线阶段）：
 * - assistant 消息里的 tool_call，若在下一条 assistant 消息之前没有对应的 tool_result，
 *   紧跟该 assistant 消息补一条 user 消息，内含 `isError: true` 的 unknown 结果；
 * - 找不到对应 call（或出现在下一条 assistant 之后）的孤立 tool_result 删除，删空的消息一并去掉。
 * 不修改入参。
 */
export function guardToolPairs(messages: ModelMessage[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  let i = 0;
  while (i < messages.length) {
    const m = messages[i] as ModelMessage;
    i++;
    if (m.role !== "assistant") {
      // 不在任何 assistant 之后窗口内的结果都是孤立的。
      pushFiltered(out, m, new Set());
      continue;
    }
    out.push(m);
    const callIds = m.content.flatMap((b) => (b.type === "tool_call" ? [b.id] : []));
    if (callIds.length === 0) continue;

    // 收集到下一条 assistant 之前的消息，并统计其中已有的结果。
    const window: ModelMessage[] = [];
    while (i < messages.length && (messages[i] as ModelMessage).role !== "assistant") {
      window.push(messages[i] as ModelMessage);
      i++;
    }
    const answered = new Set<string>();
    for (const w of window) {
      if (w.role === "system") continue;
      for (const b of w.content) if (b.type === "tool_result") answered.add(b.callId);
    }
    const missing = callIds.filter((id) => !answered.has(id));
    if (missing.length > 0) {
      out.push({
        role: "user",
        content: missing.map(
          (callId): ToolResult => ({
            type: "tool_result",
            callId,
            content: UNKNOWN_RESULT_TEXT,
            isError: true,
          }),
        ),
      });
    }
    const valid = new Set(callIds);
    // 同一 call 只保留第一个结果。
    for (const w of window) pushFiltered(out, w, valid);
  }
  return out;
}

/** 只保留 callId 在 `valid` 中（且尚未用过）的 tool_result；消息删空则丢弃。 */
function pushFiltered(out: ModelMessage[], m: ModelMessage, valid: Set<string>): void {
  if (m.role === "system") {
    out.push(m);
    return;
  }
  if (!m.content.some((b) => b.type === "tool_result")) {
    out.push(m);
    return;
  }
  const content = m.content.filter((b) => {
    if (b.type !== "tool_result") return true;
    if (!valid.has(b.callId)) return false;
    valid.delete(b.callId);
    return true;
  });
  if (content.length === m.content.length) {
    out.push(m);
  } else if (content.length > 0) {
    out.push({ ...m, content });
  }
}
