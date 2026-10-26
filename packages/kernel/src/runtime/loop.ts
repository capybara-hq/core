import type { AgentDefinition } from "../agents/definition.js";
import type { ConversationEvent } from "../conversations/events.js";
import type { StreamSink } from "./model-call.js";

/** 一次运行交给 loop 的上下文（spec 4.4）。 */
export interface LoopContext {
  /** 会话所属组织。 */
  orgId: string;
  conversationId: string;
  runId: string;
  /** 会话的 agent（工具调用上下文、策略判定用）。 */
  agentId: string;
  /** 发起本次运行的人（对话发起人）：工具调用用其个人凭据，审计记为 actor。 */
  triggerAccountId: string;
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
  /**
   * Kind of the conversation: plugin hooks fire only for `chat` (F10, P-18). Eval replays pass `eval`;
   * when absent, hooks do not fire.
   */
  conversationKind?: "chat" | "eval";
  /**
   * Set for a sub-agent's run (phase C): the dispatch this run serves. Its tools use the parent
   * conversation's sandbox (spec §10.1), and it never dispatches sub-agents itself (depth 1).
   */
  parent?: SubagentParent;
}

/** Where a sub-agent's run was dispatched from (its `subagent_dispatches` row). */
export interface SubagentParent {
  conversationId: string;
  runId: string;
  callId: string;
}

/**
 * 运行在等什么人处理：审批（`approvals` 行）或输入请求（`questions` 行，统一承载 `ask_user`、
 * 插件工具的 `input_required` 与 MCP elicitation）。`expiresAt` 为 ISO 时间。
 * `subagents` (phase C, spec §7.2): sub-agents dispatched in a step are still running; the id is
 * `sa-<runId>-<step>` (no `:`, it is part of BullMQ job ids).
 */
export interface WaitingFor {
  kind: "approval" | "input" | "subagents";
  id: string;
  expiresAt: string;
}

export type LoopOutcome =
  /** `budget`: a sub-agent run stopped at its parent run's token cap (phase C). */
  | { kind: "completed" | "max_steps" | "max_duration" | "budget"; consumedUpToSeq: number }
  | { kind: "aborted" }
  /** 停机：已在步骤边界保存好进度，任务需要回到队列。 */
  | { kind: "interrupted" }
  /** 等待人处理：checkpoint 停在 tools 节点之前，处理后从这里续跑。 */
  | { kind: "suspended"; waitingFor: WaitingFor };

export interface AgentLoop {
  run(ctx: LoopContext): Promise<LoopOutcome>;
}
