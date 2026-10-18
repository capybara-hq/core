import type { ContentBlock, ModelUsage, StopReason } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { ModelRef } from "../agents/definition.js";

/** 供应商私有数据（`ProviderOpaque`）：原样保存、只回放给同一供应商。 */
const ProviderOpaqueSchema = z.object({
  provider: z.string(),
  model: z.string(),
  data: z.unknown(),
});

/** 内容块（plugin-sdk 的 `ContentBlock`）。 */
export const ContentBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), opaque: ProviderOpaqueSchema.optional() }),
  z.object({
    type: z.literal("thinking"),
    text: z.string(),
    opaque: ProviderOpaqueSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_call"),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
    opaque: ProviderOpaqueSchema.optional(),
  }),
  z.object({
    type: z.literal("tool_result"),
    callId: z.string(),
    content: z.string(),
    isError: z.boolean(),
  }),
]);

const STOP_REASONS = ["end_turn", "tool_use", "max_tokens", "refusal", "other"] as const;

const seqNo = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

const ModelUsageShape = {
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
};

/** 双语或纯文本（plugin-sdk `InputForm` 的文案字段）。 */
const FormTextSchema = z.union([z.string(), z.object({ zh: z.string(), en: z.string() })]);

/** 交互表单（plugin-sdk 的 `InputForm`；字段 schema 已由 `validateInputForm` 校验过，这里只记形状）。 */
const InputFormSchema = z.object({
  title: FormTextSchema,
  fields: z.array(
    z.object({
      key: z.string(),
      label: FormTextSchema,
      description: FormTextSchema.optional(),
      schema: z.record(z.string(), z.unknown()),
      multiSelect: z.boolean().optional(),
      allowOther: z.boolean().optional(),
      required: z.boolean().optional(),
    }),
  ),
});

/** 表单答案（plugin-sdk 的 `FormAnswer`）。 */
const FormAnswerSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
);

const ev = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });

/**
 * 会话事件（`type` + `payload`）的判别联合。事件日志只追加，写入前用它校验 payload；
 * 读出时按写入时的形状原样返回。
 */
export const ConversationEventSchema = z.discriminatedUnion("type", [
  ev(
    "user_message",
    z.object({
      content: z.array(ContentBlockSchema),
      authorAccountId: z.string(),
      clientMessageId: z.string().optional(),
    }),
  ),
  ev(
    "run_started",
    z.object({
      agentVersion: z.number().int().positive(),
      model: ModelRef,
      triggerAccountId: z.string(),
    }),
  ),
  ev(
    "model_call",
    z.object({
      step: count,
      attempt: count,
      provider: z.string(),
      model: z.string(),
      fallback: z.boolean(),
      request: z.object({
        fromSeq: seqNo,
        toSeq: seqNo,
        summarySeq: seqNo.nullable(),
        systemHash: z.string(),
        reminderSeqs: z.array(seqNo),
        /** 本次请求的输出上限（`min(模型上限, maxOutputTokens 旋钮 ?? runtime.maxOutputTokens)`）。较早的事件可能没有。 */
        maxOutputTokens: count.optional(),
        /**
         * 本次请求的模型参数（`ModelRequest.params`）：agent 保存的参数按该模型声明 sanitize 后的结果
         * （已补默认值）。主模型尝试来自 `modelParams`，兜底尝试来自 `fallbackParams`。较早的事件可能没有。
         */
        params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        /** sanitize 时丢弃的参数键（未声明或值不再合法，如插件升级后）；没有丢弃时不写。 */
        droppedParams: z.array(z.string()).optional(),
        /**
         * 发出请求时的输入 token 估算（未校正）。与随后 `usage.inputTokens` 一起供下一次
         * `calibrate` 使用。较早的事件可能没有。
         */
        estimatedInputTokens: count.optional(),
        /**
         * 发出请求时 loop 已吸收到的 user_message seq（R31）：seq 更大的 user_message 不进本次请求
         * （由后续步骤吸收或触发下一轮）。还原请求时据此放置 / 排除用户消息。较早的事件可能没有。
         */
        absorbedUpToSeq: seqNo.optional(),
        /**
         * 本次请求带给模型的工具（按发送顺序：未启用 tool_search 时按 key 排序；启用时为内置工具按 key 排序，
         * 其后是已加载工具按首次加载顺序）及其定义指纹（`ResolvedTool.specHash`）。
         * 模型不支持工具时为空数组。较早的事件可能没有。
         */
        tools: z.array(z.object({ key: z.string(), specHash: z.string() })).optional(),
        /**
         * 启用 tool_search 时 system 第二块目录里的工具（按 key 排序）及定义指纹；定义同样存在
         * `capybara.tool_specs`，目录文本可由它们还原。未启用时不写。
         */
        catalog: z.array(z.object({ key: z.string(), specHash: z.string() })).optional(),
        /**
         * 本次请求的 `toolChoice`：收尾调用为 `"none"`（照常带工具，但不得调用）；普通步骤不写（由模型决定）。
         * 定义本身按 specHash 存在 `capybara.tool_specs`。
         */
        toolChoice: z.enum(["auto", "none"]).optional(),
      }),
    }),
  ),
  ev(
    "assistant_message",
    z.object({
      step: count,
      content: z.array(ContentBlockSchema),
      stopReason: z.enum([...STOP_REASONS, "aborted"]),
    }),
  ),
  ev(
    "usage",
    z.object({ step: count, provider: z.string(), model: z.string(), ...ModelUsageShape }),
  ),
  ev("reminder", z.object({ step: count, text: z.string() })),
  /** 工具调用开始执行之前写入（续跑时「有开始无结果」的调用记为结果未知，不再执行）。 */
  ev(
    "tool_call_started",
    z.object({ step: count, callId: z.string(), toolKey: z.string(), specHash: z.string() }),
  ),
  /**
   * 工具调用的结果（模型看到的文本）。构建请求时还原为紧随该步 assistant 消息的 user 消息中的
   * `tool_result` 块。`outputId`：超长结果转存后的存档 id；`contentTypes`：结果里出现的内容类型。
   */
  ev(
    "tool_result",
    z.object({
      step: count,
      callId: z.string(),
      toolKey: z.string(),
      content: z.string(),
      isError: z.boolean(),
      outputId: z.string().optional(),
      contentTypes: z.array(z.string()).optional(),
      /**
       * `tool_search` 本次加载的工具 key（没有匹配时不写）。已加载集合 = 会话中全部 tool_result 的
       * `loadedTools` 并集（含已被摘要覆盖的部分），构建请求时由日志还原，不放进程内存。
       */
      loadedTools: z.array(z.string()).optional(),
    }),
  ),
  /**
   * 工具调用时发现发起人尚未连接个人凭据的应用：界面据此显示连接卡片（不进模型请求；模型看到的是
   * 同一调用的 tool_result 错误说明）。组织凭据缺失不写此事件。
   */
  ev(
    "connection_required",
    z.object({ step: count, callId: z.string(), appId: z.string(), appName: z.string() }),
  ),
  /**
   * 工具调用需要人审批（策略为 `ask`）：审批记录已建，run 暂停等待处理。界面据此显示审批卡片
   * （不进模型请求；该调用的结果在审批处理后写入）。
   */
  ev(
    "approval_requested",
    z.object({
      step: count,
      callId: z.string(),
      approvalId: z.string(),
      toolKey: z.string(),
      expiresAt: z.string(),
    }),
  ),
  /** 审批已处理（批准 / 拒绝 / 超时 / 取消）；`scope` 只在批准时出现，`byAccountId` 为处理人（超时 / 取消为 null）。 */
  ev(
    "approval_decided",
    z.object({
      approvalId: z.string(),
      callId: z.string(),
      decision: z.enum(["approved", "denied", "expired", "cancelled"]),
      scope: z.enum(["once", "session", "always"]).optional(),
      byAccountId: z.string().nullable(),
    }),
  ),
  /**
   * 工具调用需要用户输入（`ask_user`、插件工具的 `input_required`、MCP elicitation）：输入请求已建，
   * run 暂停等待回答。界面据此显示表单卡片（不进模型请求）。
   */
  ev(
    "question_asked",
    z.object({
      step: count,
      callId: z.string(),
      questionId: z.string(),
      form: InputFormSchema,
      expiresAt: z.string(),
    }),
  ),
  /** 输入请求已结束：回答 / 超时 / 取消（后两者 `answer` 与 `byAccountId` 为 null）。 */
  ev(
    "question_answered",
    z.object({
      questionId: z.string(),
      callId: z.string(),
      answer: FormAnswerSchema.nullable(),
      byAccountId: z.string().nullable(),
      outcome: z.enum(["answered", "expired", "cancelled"]),
    }),
  ),
  ev("compaction_summary", z.object({ coversUpToSeq: seqNo, text: z.string() })),
  ev("compaction_failed", z.object({ attempt: count, reason: z.string() })),
  ev(
    "run_finished",
    z.object({
      reason: z.enum(["completed", "max_steps", "max_duration"]),
      consumedUpToSeq: seqNo,
    }),
  ),
  ev("run_failed", z.object({ error: z.object({ code: z.string(), message: z.string() }) })),
  ev(
    "run_aborted",
    z.object({
      byAccountId: z.string().nullable(),
      reason: z.enum(["user", "shutdown_exhausted"]),
    }),
  ),
]);

/** 事件体：`{ type, payload }` 的判别联合。 */
export type ConversationEventBody = z.infer<typeof ConversationEventSchema>;
export type ConversationEventType = ConversationEventBody["type"];

/** 已写入日志的事件。 */
export type ConversationEvent = ConversationEventBody & {
  conversationId: string;
  seq: number;
  runId: string | null;
  createdAt: Date;
};

/** 某类事件的 payload。 */
export type EventPayload<T extends ConversationEventType> = Extract<
  ConversationEventBody,
  { type: T }
>["payload"];

// 编译期核对：zod 形状与 plugin-sdk 的类型一致（任一方改动而另一方未跟上则 typecheck 失败）。
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type StripOpt<T> = T extends unknown ? { [K in keyof T]: Exclude<T[K], undefined> } : never;
const _blocks: Same<StripOpt<z.infer<typeof ContentBlockSchema>>, StripOpt<ContentBlock>> = true;
const _stop: Same<(typeof STOP_REASONS)[number], StopReason> = true;
const _usage: Same<z.infer<z.ZodObject<typeof ModelUsageShape>>, ModelUsage> = true;
// tool_result 事件与内容块中的 tool_result 共享 callId / content / isError 的形状。
type ToolResultBlock = Extract<ContentBlock, { type: "tool_result" }>;
const _toolResult: Same<
  Pick<EventPayload<"tool_result">, "callId" | "content" | "isError">,
  Omit<ToolResultBlock, "type">
> = true;
void _toolResult;
void _blocks;
void _stop;
void _usage;
