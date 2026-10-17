import type { ContentBlock, ModelInfo } from "@capybara-hq/plugin-sdk";
import type { AgentDefinition } from "../../../src/agents/definition.js";
import type {
  ConversationEvent,
  ConversationEventBody,
} from "../../../src/conversations/events.js";

export const MODEL: ModelInfo = {
  id: "fake-1",
  displayName: "Fake 1",
  contextWindow: 10_000,
  maxOutputTokens: 1_000,
  capabilities: {
    tools: true,
    vision: false,
    reasoning: true,
    caching: true,
    midConversationSystem: true,
    effort: true,
  },
};

export const AGENT: AgentDefinition = {
  name: "Helper",
  avatarUrl: null,
  instructions: "You help with accounting questions.",
  model: { provider: "model-fake", model: "fake-1" },
  fallback: null,
  effort: null,
  tools: [],
};

/** 按顺序构造事件：seq 从给定值递增，createdAt 固定。 */
export class Log {
  readonly events: ConversationEvent[] = [];
  constructor(
    readonly conversationId = "conv-1",
    private nextSeq = 1,
  ) {}

  add(body: ConversationEventBody, runId: string | null = "run-1"): ConversationEvent {
    const e = {
      ...body,
      conversationId: this.conversationId,
      seq: this.nextSeq++,
      runId,
      createdAt: new Date(0),
    } as ConversationEvent;
    this.events.push(e);
    return e;
  }

  user(text: string): ConversationEvent {
    return this.add(
      {
        type: "user_message",
        payload: { content: [{ type: "text", text }], authorAccountId: "acc-1" },
      },
      null,
    );
  }

  assistant(
    content: ContentBlock[] | string,
    stopReason: "end_turn" | "aborted" | "tool_use" = "end_turn",
    step = 0,
  ): ConversationEvent {
    const blocks: ContentBlock[] =
      typeof content === "string" ? [{ type: "text", text: content }] : content;
    return this.add({ type: "assistant_message", payload: { step, content: blocks, stopReason } });
  }

  reminder(text: string, step = 0): ConversationEvent {
    return this.add({ type: "reminder", payload: { step, text } });
  }

  summary(coversUpToSeq: number, text: string): ConversationEvent {
    return this.add({ type: "compaction_summary", payload: { coversUpToSeq, text } });
  }

  compactionFailed(attempt: number): ConversationEvent {
    return this.add({ type: "compaction_failed", payload: { attempt, reason: "too short" } });
  }

  runStarted(): ConversationEvent {
    return this.add({
      type: "run_started",
      payload: {
        agentVersion: 1,
        model: { provider: "model-fake", model: "fake-1" },
        triggerAccountId: "acc-1",
      },
    });
  }

  /** 一次模型调用记录；`absorbedUpToSeq` 省略时模拟没有该字段的旧事件。 */
  modelCall(absorbedUpToSeq?: number, step = 1): ConversationEvent {
    return this.add({
      type: "model_call",
      payload: {
        step,
        attempt: 1,
        provider: "model-fake",
        model: "fake-1",
        fallback: false,
        request: {
          fromSeq: 1,
          toSeq: 1,
          summarySeq: null,
          systemHash: "x",
          reminderSeqs: [],
          ...(absorbedUpToSeq !== undefined && { absorbedUpToSeq }),
        },
      },
    });
  }

  /** 一轮：user + assistant。 */
  turn(n: number): void {
    this.user(`question ${n}`);
    this.assistant(`answer ${n}`);
  }
}
