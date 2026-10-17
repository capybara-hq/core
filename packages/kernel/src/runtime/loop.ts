import type { AgentDefinition } from "../agents/definition.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { StreamSink } from "./model-call.js";

/** 一次运行交给 loop 的上下文（spec 4.4）。 */
export interface LoopContext {
  conversationId: string;
  runId: string;
  agent: AgentDefinition;
  agentVersion: number;
  /** 用户中止或到达 deadline 时触发：进行中的模型调用立即停下。 */
  signal: AbortSignal;
  /**
   * 停机信号（与用户中止不同）：loop 在下一个步骤边界返回 `interrupted`，不打断进行中的步骤。
   */
  shutdown: AbortSignal;
  sink: StreamSink;
  /**
   * 下一个步骤间隙要吸收的插话：返回 seq > afterSeq 的 user_message（且只含本轮开始时尚未被消费的，
   * 即 seq 也大于会话的 `consumed_seq`），按 seq 升序。loop 记录吸收到的最大 seq 作为 `consumedUpToSeq`。
   */
  pendingUserMessages(afterSeq: number): Promise<ConversationEvent[]>;
  limits: { maxSteps: number; deadline: number };
}

export type LoopOutcome =
  | { kind: "completed" | "max_steps" | "max_duration"; consumedUpToSeq: number }
  | { kind: "aborted" }
  /** 停机：已在步骤边界保存好进度，任务需要回到队列。 */
  | { kind: "interrupted" };

export interface AgentLoop {
  run(ctx: LoopContext): Promise<LoopOutcome>;
}
