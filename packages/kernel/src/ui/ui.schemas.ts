import { UI_LIMITS, UI_SLOT_IDS } from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import type { RouteSchemas } from "../platform/route-schemas.js";
import { SkillFilePathSchema } from "../skills/skills.schemas.js";

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

/** The UTF-8 bytes of a value serialized as JSON (the measure of every UI payload limit). */
export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "", "utf8");

/**
 * An action's body. `payload` is capped here at the component limit
 * (`UI_LIMITS.componentActionPayloadBytes`); a view's action keeps `UI_LIMITS.payloadBytes`, which
 * `UiViews.act` checks once it knows the contribution's kind.
 */
export const ActionBody = z.object({
  actionId: z.string().min(1).max(200),
  payload: z
    .unknown()
    .optional()
    .refine((v) => v === undefined || jsonBytes(v) <= UI_LIMITS.componentActionPayloadBytes, {
      message: `payload must be at most ${UI_LIMITS.componentActionPayloadBytes} bytes as JSON`,
    }),
  answer: FormAnswerSchema.optional(),
  conversationId: z.string().min(1).max(100).optional(),
  /** Only an agent view (`agent.detail.section`). */
  agentId: z.uuid().optional(),
  locale: Locale,
});

/**
 * `POST query/:plugin/:id`: a component's named query. `params` is any JSON (default `null`), at
 * most `UI_LIMITS.componentQueryParamsBytes` as JSON (checked by the service: 413
 * `ui.query_params_too_large`); the context ids are those of the component's slot, as for an action.
 */
export const QueryBody = z.object({
  query: z.string().min(1).max(200),
  params: z.unknown().optional(),
  conversationId: z.string().min(1).max(100).optional(),
  /** Only a component of `agent.detail.section`. */
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
    /**
     * Only a `file.preview` embed of a skill file (with `path`, without a conversation): the skill;
     * `version` defaults to its current one.
     */
    skillId: z.string().min(1).max(100).optional(),
    version: z.number().int().min(1).max(2_147_483_647).optional(),
    path: SkillFilePathSchema.optional(),
  })
  .default({});

/** `GET /api/v1/admin/ui/views/:plugin/:id?locale=`: a platform page takes no context id. */
export const PlatformViewQuery = z.object({ locale: Locale });

/** `POST /api/v1/admin/ui/actions/:plugin/:id`: an action of a platform page (no context id). */
export const PlatformActionBody = ActionBody.omit({ conversationId: true, agentId: true });

/** The slot catalog route the Platform operation `ui.slots` mirrors (`check:platform-ops` key). */
export const UI_ROUTES: readonly RouteSchemas[] = [{ route: "GET /api/v1/ui/slots" }];
