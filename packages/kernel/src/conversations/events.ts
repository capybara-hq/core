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
void _blocks;
void _stop;
void _usage;
