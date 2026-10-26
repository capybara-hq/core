import {
  type ContentBlock,
  DOCUMENT_MEDIA_TYPES,
  hasControlChars,
  IMAGE_MEDIA_TYPES,
  isAttachmentId,
  isSkillName,
  MEDIA_NAME_MAX_CHARS,
  type MediaSource,
  type ModelUsage,
  type StopReason,
} from "@capybara-hq/plugin-sdk";
import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import {
  TOOL_VIEW_DIFF_MAX_LINES,
  TOOL_VIEW_LINE_MAX_CHARS,
  TOOL_VIEW_PATH_MAX_CHARS,
} from "../tools/view.js";

/** 供应商私有数据（`ProviderOpaque`）：原样保存、只回放给同一供应商。 */
const ProviderOpaqueSchema = z.object({
  provider: z.string(),
  model: z.string(),
  data: z.unknown(),
});

/**
 * 日志里的媒体来源：只有附件引用。字节（`base64`）绝不进事件日志——日志是事实源、字节不是；
 * 构建模型请求时内核按 `attachmentId` 取字节换成 `base64`（见 {@link LogContentBlock}）。
 */
const AttachmentIdSchema = z.string().refine(isAttachmentId, "attachmentId must be a UUID");

const RefMediaSourceSchema = z.object({
  kind: z.literal("ref"),
  attachmentId: AttachmentIdSchema,
});

/** The longest deny reason (characters): the decision route's limit and `approval_decided.reason`'s. */
export const APPROVAL_DENY_REASON_MAX_CHARS = 500;
/** 一条 `media_excluded` 事件最多的附件数。 */
export const MEDIA_EXCLUDED_MAX_IDS = 50;
/** 一份 `skills_catalog` 快照最多的技能数（组织技能引用上限 100，余量给 agent 自己的技能）。 */
export const SKILLS_CATALOG_MAX = 1000;
/** The longest pinned skill body in a `skills_catalog` snapshot (the pinned total is ≤ 32768 bytes). */
export const PINNED_BODY_MAX_CHARS = 32768;

/** 媒体块的名字：与 plugin-sdk `validateMediaBlock` 同规则（≤255 字符、不含控制字符）。 */
const MediaNameSchema = z
  .string()
  .max(MEDIA_NAME_MAX_CHARS)
  .refine((s) => !hasControlChars(s), "name must not contain control characters");

const ArtifactNameSchema = MediaNameSchema.min(1);

/** 产物名（`artifact_created.name`）是否合法：与日志 schema 同一规则（非空、≤255、不含控制字符）。 */
export const isValidArtifactName = (name: string): boolean =>
  ArtifactNameSchema.safeParse(name).success;

/**
 * 日志里的内容块：plugin-sdk 的 `ContentBlock`，但 image / document 的 `source` 只能是 `ref`
 * （写入时用这个 schema 校验，带 `base64` 的块被拒绝）。
 */
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
  z.object({
    type: z.literal("image"),
    mediaType: z.enum(IMAGE_MEDIA_TYPES),
    source: RefMediaSourceSchema,
    name: MediaNameSchema.optional(),
  }),
  z.object({
    type: z.literal("document"),
    mediaType: z.enum(DOCUMENT_MEDIA_TYPES),
    source: RefMediaSourceSchema,
    name: MediaNameSchema.optional(),
  }),
]);

type MediaBlock = Extract<ContentBlock, { type: "image" | "document" }>;
/**
 * 日志形状的内容块：与 plugin-sdk 的 `ContentBlock` 相同，只是媒体块的 `source` 收窄为 `ref`。
 * 它是 `ContentBlock` 的子类型，所以从日志读出的块可直接当 `ContentBlock` 用（请求构建时再解析 ref）。
 */
export type LogContentBlock =
  | Exclude<ContentBlock, MediaBlock>
  | (MediaBlock extends infer B
      ? B extends MediaBlock
        ? Omit<B, "source"> & { source: Extract<MediaSource, { kind: "ref" }> }
        : never
      : never);

const STOP_REASONS = ["end_turn", "tool_use", "max_tokens", "refusal", "other"] as const;

const seqNo = z.number().int().nonnegative();
const count = z.number().int().nonnegative();

/**
 * Structured view of a builtin tool's result (UI refresh B, spec §5.5 / §5.9): display only, like
 * `display`. `command`: `sandbox_bash` (the model's `description`, the exit code, null when the
 * command was stopped, and whether it timed out; the web shows "Failed" for a non-zero exit even
 * though `isError` stays false); `edit`: `sandbox_edit` / `sandbox_write` (a capped line diff);
 * `read`: `sandbox_read` (the line range shown).
 */
export const ToolViewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("command"),
    description: z.string().max(120).optional(),
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
  }),
  z.object({
    kind: z.literal("edit"),
    path: z.string().max(TOOL_VIEW_PATH_MAX_CHARS),
    created: z.boolean(),
    added: count,
    removed: count,
    truncated: z.boolean(),
    hunks: z
      .array(
        z.object({
          oldStart: count,
          newStart: count,
          lines: z
            .array(
              z.object({
                kind: z.enum(["ctx", "add", "del"]),
                text: z.string().max(TOOL_VIEW_LINE_MAX_CHARS),
              }),
            )
            .max(TOOL_VIEW_DIFF_MAX_LINES),
        }),
      )
      .max(TOOL_VIEW_DIFF_MAX_LINES),
  }),
  z.object({
    kind: z.literal("read"),
    path: z.string().max(TOOL_VIEW_PATH_MAX_CHARS),
    fromLine: count.optional(),
    toLine: count.optional(),
  }),
]);
export type ToolView = z.infer<typeof ToolViewSchema>;

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
  /** 需要用户在浏览器里打开的外部页面（MCP URL 模式的 elicitation）。较早的事件没有。 */
  url: z.string().optional(),
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
      /**
       * `@` 资源引用的附件元数据：第 i 个附件的正文是 `content[i + 1]`（`content[0]` 是用户输入的文本）。
       * 界面据此把附件显示为条目而不是正文。较早的事件没有。`appId` / `appName` 是连接器的 id 与名称：
       * 「应用」改名「连接器」后字段名不变（D17 / C27：日志确定性）。
       */
      attachments: z
        .array(
          z.object({ appId: z.string(), appName: z.string(), uri: z.string(), name: z.string() }),
        )
        .optional(),
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
        /**
         * 请求里每个附件的处理结果（Ruling M8，按首次出现，同一附件一条）：发了字节（`bytes`，带 finalize 时的
         * etag）、内联文本、模型不支持的占位、因请求媒体预算省略（`omitted`）、图片太多（`too_many_images`）、
         * 单个超过供应商上限（`too_large`）、不再可用、PDF 页数太多、
         * 被 `media_excluded` 排除。没有媒体时不写；较早的事件没有。
         */
        media: z
          .array(
            z.object({
              attachmentId: AttachmentIdSchema,
              outcome: z.enum([
                "bytes",
                "inline",
                "placeholder_unsupported",
                "omitted",
                "too_many_images",
                "too_large",
                "unavailable",
                "too_many_pages",
                "excluded",
              ]),
              etag: z.string().max(1024).optional(),
            }),
          )
          .optional(),
        /**
         * 本次请求的媒体字节预算（`attachments.requestMediaBytes`，见 planMedia）：请求里有媒体时才写，
         * 还原时用它重现同样的省略结果。较早的事件没有。
         */
        mediaBudgetBytes: count.optional(),
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
  /**
   * Usage of one model call. Absent `purpose` = the step's call (written with its
   * `assistant_message`); `compaction` = the compaction call before the step (I-1: billed and
   * reported, but no step consumer may pair it with the step's `model_call`).
   */
  ev(
    "usage",
    z.object({
      step: count,
      provider: z.string(),
      model: z.string(),
      ...ModelUsageShape,
      purpose: z.literal("compaction").optional(),
    }),
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
      /**
       * 工具给的一句话说明（`ToolResult.display`，中英文），只给界面显示：不进模型请求（重建请求只用
       * callId / content / isError），也不进压缩记录。插件 / 内置工具给出且通过 `validateToolDisplay` 时才写。
       */
      display: z.object({ summary: z.object({ zh: z.string(), en: z.string() }) }).optional(),
      /** Structured view ({@link ToolViewSchema}); builtins only, display only, not in compaction. */
      view: ToolViewSchema.optional(),
    }),
  ),
  /**
   * 工具调用时发现发起人尚未连接个人凭据的连接器：界面据此显示连接卡片（不进模型请求；模型看到的是
   * 同一调用的 tool_result 错误说明）。组织凭据缺失不写此事件。`appId` / `appName` 是连接器的 id 与名称，
   * 改名后字段名不变（D17 / C27）。
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
      /** Which rule asked (UI refresh B; display only, absent in older logs). */
      policy: z.enum(["agent", "connector", "default", "role", "org", "fixed"]).optional(),
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
      /**
       * The reason given with a denial (UI refresh B; display only here: the model sees it in the
       * denied call's `tool_result`).
       */
      reason: z.string().max(APPROVAL_DENY_REASON_MAX_CHARS).optional(),
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
  /**
   * 带媒体的模型请求被供应商以不可重试的 `invalid_request` / `context_overflow` 拒绝（Ruling M8）：这些附件
   * （该请求里发了字节的）此后一律换成「被供应商拒绝」的占位，会话不会因同一个附件永久卡住。不进模型请求
   * 本身，只影响之后的请求构建（可由日志推出）。
   */
  ev(
    "media_excluded",
    z.object({
      attachmentIds: z.array(AttachmentIdSchema).min(1).max(MEDIA_EXCLUDED_MAX_IDS),
      reason: z.enum(["provider_rejected"]),
    }),
  ),
  /**
   * agent 经 `sandbox_deliver` 把沙箱里的文件交付给用户（M5 T8，C3）：字节在对象存储
   * `kernel/<orgId>/<objectKey>`（`objectKey` = `artifacts/<conversationId>/<artifactId>`，相对内核前缀），
   * 这里只有元数据。网页从日志重建产物列表；不进模型请求（模型看到的是同一调用的 tool_result 确认）。
   */
  ev(
    "artifact_created",
    z.object({
      artifactId: z.uuid(),
      name: ArtifactNameSchema,
      contentType: z.string().min(1).max(200),
      size: z.number().int().nonnegative(),
      objectKey: z.string().min(1),
      sourcePath: z.string().min(1),
      callId: z.string(),
    }),
  ),
  /**
   * 本对话此刻生效的技能（M5 T14，Ruling M17）：运行开始时内核解析生效的技能集合（agent 版本选中的组织技能 +
   * agent 自己的技能，未删除，取 current_version），与日志里上一份快照不同才写。模型看到的技能目录只来自这里：
   * 第一份（在任何 `model_call` 之前）进 system 缓存段，之后的在所在位置渲染为英文变更提醒；`skill_load` 按最新一份
   * 把名字解析为 id 与版本。按 name 排序。
   */
  ev(
    "skills_catalog",
    z.object({
      skills: z
        .array(
          z.object({
            id: z.string().min(1).max(100),
            name: z.string().refine(isSkillName, "invalid skill name"),
            description: z.string().max(4096),
            version: z.number().int().positive(),
            /**
             * 内容来源（对象前缀，T15）：已生成的版本为 `skill_versions.object_prefix`，试用中的草稿为申请的
             * `object_prefix`。同号的草稿与正式版本靠它区分；`skill_load` 只按它解析。
             */
            source: z.string().min(1).max(512),
            /**
             * The catalog item (plugin) name the skill came from (phase B); absent for the org's
             * own and the agent's skills, and in snapshots written before phase B. `skill_load`
             * resolves `<plugin>:<name>` with it; it is not model-visible otherwise.
             */
            plugin: z.string().min(1).max(64).optional(),
          }),
        )
        .max(SKILLS_CATALOG_MAX),
      /**
       * Pinned skills (phase B, spec §9.1) in the agent's order: each a skill of `skills` (same
       * id, version and source) with its SKILL.md body as read at run start or written by
       * skill_write. Absent means none (every snapshot before phase B).
       */
      pinned: z
        .array(
          z.object({
            id: z.string().min(1).max(100),
            version: z.number().int().positive(),
            name: z.string().refine(isSkillName, "invalid skill name"),
            source: z.string().min(1).max(512),
            body: z.string().max(PINNED_BODY_MAX_CHARS),
          }),
        )
        .max(3)
        .optional(),
      /**
       * The Claude Code tool-name map text (`CLAUDE_CODE_TOOL_MAP`), present iff a skill in
       * `skills` came from a Claude Code plugin.
       */
      toolMap: z.string().max(4000).optional(),
    }),
  ),
  /**
   * A plugin policy hook denied a model request or a tool call (E6). Not model-visible: request building
   * skips it; the model sees only `reason`, inside the tool error of a denied tool call (and nothing for a
   * denied model request, whose run fails with `run.hook_denied`). No raw hook error here (Ruling R12):
   * the events API reaches conversation participants, so the raw text lives in the `hook.denied` audit
   * row only.
   */
  ev(
    "hook_denied",
    z.object({
      mount: z.enum(["model.request", "tool.preExecute"]),
      plugin: z.string(),
      reason: z.string().max(500),
      cause: z.enum(["deny", "hook_error", "timeout"]),
      step: count,
      attempt: count.optional(),
      callId: z.string().optional(),
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
      /** `eval_stopped`：评测整轮回放被评测运行停下（只出现在 `kind = 'eval'` 的对话里），原因见 `detail`。 */
      reason: z.enum(["user", "shutdown_exhausted", "eval_stopped"]),
      detail: z
        .enum(["cancelled", "capped", "too_many_errors", "claim_lost", "shutdown"])
        .optional(),
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
// 日志 schema 对的是收窄后的 LogContentBlock（媒体块只认 ref）；再核对它确是 ContentBlock 的子类型。
const _blocks: Same<StripOpt<z.infer<typeof ContentBlockSchema>>, StripOpt<LogContentBlock>> = true;
const _logIsBlock: [LogContentBlock] extends [ContentBlock] ? true : false = true;
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
void _logIsBlock;
void _stop;
void _usage;
