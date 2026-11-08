import { UI_LIMITS, UI_SLOT_IDS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";

/** The DTO schemas of the org UI routes (`views.controller.ts`). */

const Locale = z.enum(["zh", "en"]).default("en");
const Id = z.string().min(1).max(100);

/** The contribution named in a view / action / embed path (`:plugin/:id`). */
export const ContributionParams = z.object({ plugin: Id, id: Id });

/** `GET contributions?slot=`: one catalog slot, or every org-reachable slot when omitted. */
export const ContributionsQuery = z.object({ slot: z.enum(UI_SLOT_IDS).optional() });

export const ViewQuery = z
  .object({
    conversationId: z.string().min(1).max(100).optional(),
    /** Only an agent view (`agent.detail.section`). */
    agentId: z.uuid().optional(),
    locale: Locale,
    /** A panel opened from an open target: the item to scroll to. */
    item: z.string().min(1).max(200).optional(),
    /** An inline card: the tool call it hangs off, and its `ToolResult.card.key`. */
    callId: z.string().min(1).max(200).optional(),
    key: z.string().min(1).max(200).optional(),
  })
  .refine((q) => q.key === undefined || q.callId !== undefined, {
    message: "key needs callId",
  });

/**
 * 表单答案（plugin-sdk 的 `FormAnswer`）。SDK 的 InputForm 没有单独的字段数 / 选项数上限，
 * 这里沿用视图的上限：键数与多选数组长度 ≤ `UI_LIMITS.tableRows`，单个文本 ≤ `UI_LIMITS.textChars`。
 */
const AnswerText = z.string().max(UI_LIMITS.textChars);
const FormAnswerSchema = z
  .record(
    z.string().max(100),
    z.union([AnswerText, z.number(), z.boolean(), z.array(AnswerText).max(UI_LIMITS.tableRows)]),
  )
  .refine((a) => Object.keys(a).length <= UI_LIMITS.tableRows, {
    message: `answer must have at most ${UI_LIMITS.tableRows} fields`,
  });

/** 按钮 payload 的 JSON 序列化后 UTF-8 字节数（与 `validateUiView` 对按钮 payload 的上限一致）。 */
const payloadBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

export const ActionBody = z.object({
  actionId: z.string().min(1).max(200),
  payload: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || payloadBytes(v) <= UI_LIMITS.payloadBytes, {
      message: `payload must be at most ${UI_LIMITS.payloadBytes} bytes as JSON`,
    }),
  answer: FormAnswerSchema.optional(),
  conversationId: z.string().min(1).max(100).optional(),
  /** Only an agent view (`agent.detail.section`). */
  agentId: z.uuid().optional(),
  locale: Locale,
});

export const EmbedTokenBody = z
  .object({
    conversationId: z.string().min(1).max(100).optional(),
    /** Only an agent embed (`agent.detail.section`). */
    agentId: z.uuid().optional(),
    /** Only a `file.preview` embed: the file version it previews. */
    fileId: z.uuid().optional(),
  })
  .default({});
