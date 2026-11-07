import {
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { ModelRef } from "../agents/definition.js";
import type { EnvironmentView } from "../environments/environments.service.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { createZodDto } from "../infra/validation/create-zod-dto.js";
import { ZBody, ZParam, ZQuery } from "../infra/validation/zod-params.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { CONTROL_OR_HIDDEN_RE } from "../text.js";
import { MAX_ATTACHMENTS } from "../tools/connector-content.js";
import {
  ConversationToolInfo,
  TOOL_INFO_KEY_MAX,
  TOOL_INFO_MAX_KEYS,
  type ToolInfo,
} from "../tools/info.js";
import type { AgentTreeNode } from "./agent-tree.js";
import {
  ARTIFACT_DOWNLOAD_CACHE_SECONDS,
  type ArtifactPreview,
  ConversationArtifacts,
} from "./artifacts.js";
import {
  CONVERSATION_TITLE_MAX_CHARS,
  type ConversationGroup,
  ConversationsService,
  type ConversationView,
  type SubagentView,
  type UsageTotals,
} from "./conversations.service.js";
import { ConversationEnvironmentStatus } from "./environment-status.js";
import type { ConversationEvent } from "./events.js";
import {
  ConversationFiles,
  FILE_CONTENT_MAX_BYTES,
  FILES_PAGE_MAX,
  type FileOutput,
} from "./files.js";
import { ConversationOutputs, OUTPUT_PAGE_MAX_CHARS, type OutputPage } from "./outputs-read.js";
import type { QueueItem, QueuePauseReason } from "./queue.js";
import { ConversationQueue } from "./queue.service.js";

/** Shared by the list and groups queries: title search, run activity and the archived list. */
const searchFields = {
  q: z.string().min(1).max(100).optional(),
  state: z.enum(["running", "waiting"]).optional(),
  archived: z.enum(["1"]).optional(),
};

const ListQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only this agent's conversations (the sidebar's per-group "More"). */
  agentId: z.string().min(1).max(100).optional(),
  ...searchFields,
});

const GroupsQuery = z.object({
  perGroup: z.coerce.number().int().min(1).max(20).default(5),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The last group's agent id from the previous page (`next`). */
  after: z.string().min(1).max(100).optional(),
  ...searchFields,
});

const SubagentsQuery = z.object({
  /** The previous page's last sub-agent id (`next`). */
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const EventsQuery = z
  .object({
    after: z.coerce.number().int().min(0).optional(),
    /** The page before this seq, or the log's last page (`end`); exclusive with `after`. */
    before: z.union([z.literal("end"), z.coerce.number().int().min(1)]).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .refine((q) => q.after === undefined || q.before === undefined, {
    message: "after and before are exclusive",
    path: ["before"],
  });

/** `?keys=a,b`: 1–100 comma-separated tool keys of 1–200 characters each. */
const ToolsQuery = z.object({
  keys: z
    .string()
    .max(TOOL_INFO_MAX_KEYS * (TOOL_INFO_KEY_MAX + 1))
    .transform((s) => s.split(","))
    .pipe(z.array(z.string().min(1).max(TOOL_INFO_KEY_MAX)).min(1).max(TOOL_INFO_MAX_KEYS)),
});

const OutputQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(OUTPUT_PAGE_MAX_CHARS).default(OUTPUT_PAGE_MAX_CHARS),
});

const FilesQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(FILES_PAGE_MAX).default(50),
});

const FileContentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(FILE_CONTENT_MAX_BYTES).default(FILE_CONTENT_MAX_BYTES),
});

/** `inline=1`：要求以 inline 打开（只对位图生效，见 ConversationArtifacts）。 */
const DownloadQuery = z.object({ inline: z.enum(["0", "1"]).optional() });

const MessageFields = z.object({
  /** 用户输入的文本；只有带 `files` 且不带 `attachments` 时可以为空（只发图片 / 文件）。 */
  text: z.string().max(100_000),
  clientMessageId: z.string().min(1).max(200).optional(),
  /** `@` 资源引用：内核以发送者的凭据读取并作为附加文本块写入（见 ConversationsService.postUserMessage）。 */
  attachments: z
    .array(z.object({ connectorId: z.uuid(), uri: z.string().min(1).max(2000) }).strict())
    .max(MAX_ATTACHMENTS)
    .optional(),
  /**
   * 上传的附件 id（已 finalize，见 AttachmentsController）；条数上限由 `attachments.maxPerMessage` 决定，
   * 这里的 100 只是硬上限。
   */
  files: z.array(z.uuid()).max(100).optional(),
  /** Switch the conversation's model from the next run (UI refresh B); the agent's own = back. */
  model: ModelRef.strict().optional(),
  /** Switch the effort: one of the (selected) model's declared `effort` values. */
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  /** A retry after a failed run: the seq of the message it repeats (display only, decision 6). */
  retryOf: z.number().int().positive().optional(),
  /**
   * Invoke a skill of the agent (phase D, `/name args`): `text` is the arguments (may be empty);
   * `name` is the skill's name or `<plugin>:<name>`.
   */
  skill: z
    .object({
      name: z
        .string()
        .min(1)
        .max(130)
        .regex(/^[a-z0-9-]+(?::[a-z0-9-]+)?$/, "name must be a skill name or <plugin>:<name>"),
    })
    .strict()
    .optional(),
});

// The body of `@` resource i is `content[i + 1]`, so `content[0]` must be the user's text: with
// `@` resources the text must not be empty. A skill invocation's `content[0]` is the rendered
// skill, so its text (the arguments) may be empty.
const textRule: [
  (b: {
    text: string;
    files?: string[] | undefined;
    attachments?: unknown[] | undefined;
    skill?: unknown;
  }) => boolean,
  { message: string; path: string[] },
] = [
  (b) =>
    b.text.length > 0 ||
    b.skill !== undefined ||
    ((b.files?.length ?? 0) > 0 && !b.attachments?.length),
  {
    message:
      "Text is required unless the message invokes a skill or carries files (and no @ resources)",
    path: ["text"],
  },
];

const MessageBody = MessageFields.strict().refine(...textRule);

/**
 * `POST /conversations`: `message` creates the conversation with its first message (create on
 * first send; `clientMessageId` is required and makes a retry return the same conversation).
 * Without it the conversation is created empty (API clients; the web never does).
 * `environmentId` binds it to one of the caller's environments; without it the caller's default
 * environment (environments spec §4.1 item 1).
 */
const CreateBody = z
  .object({
    agentId: z.string().min(1).max(100),
    environmentId: z.string().min(1).max(100).optional(),
    message: MessageFields.omit({ retryOf: true })
      .extend({ clientMessageId: z.string().min(1).max(200) })
      .strict()
      .refine(...textRule)
      .optional(),
  })
  .strict();

/**
 * `POST …/queue` (deprecated, behaves as `POST …/messages`): the message fields (no retry).
 */
const QueueBody = MessageFields.omit({ retryOf: true })
  .extend({ clientMessageId: z.string().min(1).max(200) })
  .strict()
  .refine(...textRule);

/** `PATCH …/queue/:itemId`: only the text changes (the text rule is checked against the item). */
const QueueEditBody = z.object({ text: z.string().max(100_000) }).strict();

/**
 * A rename: 1–120 characters counted in code points after trimming, with no control or format
 * (bidi, zero-width) characters, the same rule generated and tool titles follow.
 */
const PatchBody = z
  .object({
    title: z
      .string()
      .max(CONVERSATION_TITLE_MAX_CHARS * 2 + 100)
      .trim()
      .refine((t) => t.length > 0, "title must not be empty")
      .refine(
        (t) => Array.from(t).length <= CONVERSATION_TITLE_MAX_CHARS,
        `title must be at most ${CONVERSATION_TITLE_MAX_CHARS} characters`,
      )
      .refine(
        (t) => !CONTROL_OR_HIDDEN_RE.test(t),
        "title must not contain control or format characters",
      )
      .optional(),
    /** true archives (hidden from the default lists), false unarchives. */
    archived: z.boolean().optional(),
  })
  .strict()
  .refine(
    (b) => b.title !== undefined || b.archived !== undefined,
    "title or archived is required",
  );

const IdParams = z.object({ id: z.string().min(1).max(100) });

class ConversationCreateBodyDto extends createZodDto(CreateBody, "ConversationCreateBody") {}
class ConversationPatchBodyDto extends createZodDto(PatchBody, "ConversationPatchBody") {}
class ConversationIdParamsDto extends createZodDto(IdParams, "ConversationIdParams") {}
class ConversationListQueryDto extends createZodDto(ListQuery, "ConversationListQuery") {}
class ConversationGroupsQueryDto extends createZodDto(GroupsQuery, "ConversationGroupsQuery") {}
class ConversationEventsQueryDto extends createZodDto(EventsQuery, "ConversationEventsQuery") {}
class ConversationSubagentsQueryDto extends createZodDto(
  SubagentsQuery,
  "ConversationSubagentsQuery",
) {}
class ConversationOutputQueryDto extends createZodDto(OutputQuery, "ConversationOutputQuery") {}
class ConversationDownloadQueryDto extends createZodDto(
  DownloadQuery,
  "ConversationDownloadQuery",
) {}
class ConversationFilesQueryDto extends createZodDto(FilesQuery, "ConversationFilesQuery") {}
class ConversationFileContentQueryDto extends createZodDto(
  FileContentQuery,
  "ConversationFileContentQuery",
) {}
class ConversationToolsQueryDto extends createZodDto(ToolsQuery, "ConversationToolsQuery") {}
class ConversationMessageBodyDto extends createZodDto(MessageBody, "ConversationMessageBody") {}
class ConversationQueueBodyDto extends createZodDto(QueueBody, "ConversationQueueBody") {}
class ConversationQueueEditBodyDto extends createZodDto(
  QueueEditBody,
  "ConversationQueueEditBody",
) {}

/**
 * 会话（`/api/v1/orgs/:orgId/conversations`）：`agents.use`（访客以上），只接受人类用户；
 * 服务令牌 → 403 `forbidden`。只有会话所有者可见，其他人一律 `conversation.not_found`。
 */
@Controller("api/v1/orgs/:orgId/conversations")
export class ConversationsController {
  constructor(
    @Inject(ConversationsService) private readonly conversations: ConversationsService,
    @Inject(ConversationOutputs) private readonly outputs: ConversationOutputs,
    @Inject(ConversationArtifacts) private readonly artifacts: ConversationArtifacts,
    @Inject(ConversationEnvironmentStatus)
    private readonly environmentStatus: ConversationEnvironmentStatus,
    @Inject(ConversationToolInfo) private readonly toolInfo: ConversationToolInfo,
    @Inject(ConversationQueue) private readonly queue: ConversationQueue,
    @Inject(ConversationFiles) private readonly files: ConversationFiles,
  ) {}

  /**
   * 201 when created; 200 when `message.clientMessageId` repeats an earlier first send. With a
   * message the answer has `event` (the `user_message`) and `events`: every event the first send
   * wrote, in seq order from seq 1 (a `model_switched` first when it switched).
   */
  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZBody(ConversationCreateBodyDto) body: z.infer<typeof CreateBody>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{
    conversation: ConversationView;
    event?: ConversationEvent;
    events?: ConversationEvent[];
  }> {
    const p = requireUser(principal);
    const pick = body.environmentId === undefined ? {} : { environmentId: body.environmentId };
    if (body.message === undefined) {
      return {
        conversation: await this.conversations.create(org.orgId, p.account.id, body.agentId, pick),
      };
    }
    const m = body.message;
    const out = await this.conversations.createWithMessage(
      org.orgId,
      p.account.id,
      body.agentId,
      {
        text: m.text,
        clientMessageId: m.clientMessageId,
        ...(m.attachments !== undefined && { attachments: m.attachments }),
        ...(m.files !== undefined && { files: m.files }),
        ...(m.model !== undefined && { model: m.model }),
        ...(m.effort !== undefined && { effort: m.effort }),
        ...(m.skill !== undefined && { skill: m.skill }),
      },
      pick,
    );
    reply.status(out.created ? 201 : 200);
    return { conversation: out.conversation, event: out.event, events: out.events };
  }

  /**
   * Rename and / or archive (owner only). A rename makes `titleSource` `manual`, so the title is
   * never regenerated; `archived` archives or unarchives. Returns the final view.
   */
  @Patch(":id")
  @OrgAction("agents.use")
  async patch(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZBody(ConversationPatchBodyDto) body: z.infer<typeof PatchBody>,
  ): Promise<{ conversation: ConversationView }> {
    const p = requireUser(principal);
    const renamed =
      body.title === undefined
        ? undefined
        : await this.conversations.rename(org.orgId, id, p.account.id, body.title);
    if (body.archived === undefined) {
      // The refine guarantees a title when there is no `archived`
      return {
        conversation: renamed ?? (await this.conversations.get(org.orgId, id, p.account.id)),
      };
    }
    return {
      conversation: await this.conversations.setArchived(
        org.orgId,
        id,
        p.account.id,
        body.archived,
      ),
    };
  }

  /** Soft delete (owner only): stops an active run and hides the conversation everywhere. */
  @Delete(":id")
  @HttpCode(204)
  @OrgAction("agents.use")
  async remove(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ConversationIdParamsDto) { id }: z.infer<typeof IdParams>,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.conversations.remove(org.orgId, id, p.account.id);
  }

  /** 我的会话，最近更新的在前：`next` 为下一页游标（作为 `after` 传回），没有更多时为 null。 */
  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(ConversationListQueryDto) q: z.infer<typeof ListQuery>,
  ): Promise<{ conversations: ConversationView[]; next: string | null }> {
    const p = requireUser(principal);
    const rows = await this.conversations.listMine(org.orgId, p.account.id, {
      limit: q.limit + 1,
      ...(q.after !== undefined && { after: q.after }),
      ...(q.agentId !== undefined && { agentId: q.agentId }),
      ...(q.q !== undefined && { q: q.q }),
      ...(q.state !== undefined && { state: q.state }),
      ...(q.archived !== undefined && { archived: true }),
    });
    const conversations = rows.slice(0, q.limit);
    const next = rows.length > q.limit ? (conversations.at(-1)?.id ?? null) : null;
    return { conversations, next };
  }

  /**
   * My conversations grouped by agent, for the sidebar: groups by latest activity, `perGroup`
   * newest conversations each with `more`; `next` is the last group's agent id (passed back as
   * `after`), null when there are no more groups. Declared before `:id` so it is not captured.
   */
  @Get("groups")
  @OrgAction("agents.use")
  async groups(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZQuery(ConversationGroupsQueryDto) q: z.infer<typeof GroupsQuery>,
  ): Promise<{ groups: ConversationGroup[]; next: string | null; archivedCount: number }> {
    const p = requireUser(principal);
    return this.conversations.listGroups(org.orgId, p.account.id, {
      perGroup: q.perGroup,
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
      ...(q.q !== undefined && { q: q.q }),
      ...(q.state !== undefined && { state: q.state }),
      ...(q.archived !== undefined && { archived: true }),
    });
  }

  @Get(":id")
  @OrgAction("agents.use")
  async get(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ conversation: ConversationView }> {
    const p = requireUser(principal);
    return { conversation: await this.conversations.get(org.orgId, id, p.account.id) };
  }

  /**
   * Events in ascending seq. `after`: those after it (at most `limit`; the client passes the last
   * seq back as the next `after`). `before` (a seq, or `end` for the log's last page): the
   * turn-aligned page before it, `{ events, turnsBefore }` (history paging spec §2).
   */
  @Get(":id/events")
  @OrgAction("agents.use")
  async events(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(ConversationEventsQueryDto) q: z.infer<typeof EventsQuery>,
  ): Promise<{ events: ConversationEvent[]; turnsBefore?: number }> {
    const p = requireUser(principal);
    if (q.before !== undefined) {
      const before = q.before === "end" ? null : q.before;
      return this.conversations.listEventsBefore(org.orgId, id, p.account.id, before, q.limit);
    }
    return {
      events: await this.conversations.listEvents(
        org.orgId,
        id,
        p.account.id,
        q.after ?? 0,
        q.limit,
      ),
    };
  }

  /**
   * The conversation's sub-agents, newest first (sub-agents spec §14.3): `{ subagents, next }`,
   * `next` the cursor passed back as `after` (null when there are no more). Owner only, as the
   * conversation itself (`conversation.not_found`).
   */
  @Get(":id/subagents")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async subagents(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(ConversationSubagentsQueryDto) q: z.infer<typeof SubagentsQuery>,
  ): Promise<{ subagents: SubagentView[]; next: string | null }> {
    const p = requireUser(principal);
    return this.conversations.listSubagents(org.orgId, id, p.account.id, {
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
    });
  }

  /**
   * The agent tree of a root conversation (agent map spec §8, §9.2): `{ root }`, each node with its
   * status, model, time, tokens, tool calls and children. Owner only; a sub-agent's id is
   * `conversation.not_found`.
   */
  @Get(":id/agent-tree")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async agentTree(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @ZParam(ConversationIdParamsDto) { id }: z.infer<typeof IdParams>,
  ): Promise<{ root: AgentTreeNode }> {
    const p = requireUser(principal);
    return this.conversations.agentTree(org.orgId, id, p.account.id);
  }

  /**
   * The conversation's token usage, its sub-agents' included (sub-agents spec §8.3):
   * `{ usage: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } }`. Owner only.
   */
  @Get(":id/usage")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async usage(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ usage: UsageTotals }> {
    const p = requireUser(principal);
    return { usage: await this.conversations.usage(org.orgId, id, p.account.id) };
  }

  /**
   * 工具输出存档（内核截断并转存的大结果）的全文，按字符分页（`offset` / `limit`，`next` 为下一页起点）。
   * 会话可见性与会话流相同，不可见 → `conversation.not_found`；存档不属于该会话或已过期 → `conversation.output_not_found`。
   */
  @Get(":id/outputs/:outputId")
  @OrgAction("agents.use")
  async output(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("outputId") outputId: string,
    @ZQuery(ConversationOutputQueryDto) q: z.infer<typeof OutputQuery>,
  ): Promise<{ output: OutputPage }> {
    const p = requireUser(principal);
    return { output: await this.outputs.read(org.orgId, id, p.account.id, outputId, q) };
  }

  /**
   * 下载 agent 交付的产物（`artifact_created`）：302 到预签名地址（一律 `attachment`，带文件名）。
   * 会话可见性与会话流相同，不可见 → `conversation.not_found`；不是该会话的产物 → `conversation.artifact_not_found`。
   */
  @Get(":id/artifacts/:artifactId/download")
  @OrgAction("agents.use")
  async downloadArtifact(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("artifactId") artifactId: string,
    @ZQuery(ConversationDownloadQueryDto) q: z.infer<typeof DownloadQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const { url } = await this.artifacts.downloadUrl(org.orgId, id, p.account.id, artifactId, {
      inline: q.inline === "1",
    });
    await reply
      .header("cache-control", `private, max-age=${ARTIFACT_DOWNLOAD_CACHE_SECONDS}`)
      .redirect(url, 302);
  }

  /**
   * 文本产物的开头若干行（`{ preview: { text, truncated } }`，网页按纯文本显示）。
   * 不是文本类、或开头有 NUL 字节 → `conversation.artifact_not_previewable`；可见性与下载相同。
   */
  @Get(":id/artifacts/:artifactId/preview")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async previewArtifact(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("artifactId") artifactId: string,
  ): Promise<{ preview: ArtifactPreview }> {
    const p = requireUser(principal);
    return { preview: await this.artifacts.preview(org.orgId, id, p.account.id, artifactId) };
  }

  /**
   * The conversation's file outputs, newest first, grouped by source path into versions (UI
   * refresh B). `next` is the last file's id (passed back as `after`), null at the end.
   */
  @Get(":id/files")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async listFiles(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(ConversationFilesQueryDto) q: z.infer<typeof FilesQuery>,
  ): Promise<{ files: FileOutput[]; next: string | null }> {
    const p = requireUser(principal);
    return this.files.list(org.orgId, id, p.account.id, {
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
    });
  }

  /**
   * The first `limit` bytes (≤ 1 MiB) of a text file version, always as `text/plain; charset=utf-8`
   * with the stored type in `X-Content-Original-Type` (sandboxed, never sniffed);
   * `X-Content-Truncated: true` when cut. Not text → 400 `conversation.artifact_not_previewable`;
   * object gone → 410 `conversation.artifact_removed`.
   */
  @Get(":id/files/:fileId/content")
  @OrgAction("agents.use")
  async fileContent(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("fileId") fileId: string,
    @ZQuery(ConversationFileContentQueryDto) q: z.infer<typeof FileContentQuery>,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const p = requireUser(principal);
    const c = await this.files.content(org.orgId, id, p.account.id, fileId, q.limit);
    reply
      .header("content-type", c.contentType)
      .header("x-content-original-type", c.originalType)
      .header("cache-control", "private, no-store")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "sandbox; default-src 'none'");
    if (c.truncated) reply.header("x-content-truncated", "true");
    await reply.send(c.body);
  }

  /**
   * The environment the conversation works in (a sub-agent: its root's), as its owner sees it,
   * with its instance state; `null` while unbound, or when the environment was deleted. Same
   * visibility as the event stream.
   */
  @Get(":id/environment")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async environment(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ environment: EnvironmentView | null }> {
    const p = requireUser(principal);
    return { environment: await this.environmentStatus.get(org.orgId, id, p.account.id) };
  }

  /**
   * Display metadata (title, kind, key arguments, source) of the tools a conversation's calls name,
   * for the tool rows (UI refresh B). Same visibility as the event stream; never model-visible.
   */
  @Get(":id/tools")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async tools(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZQuery(ConversationToolsQueryDto) q: z.infer<typeof ToolsQuery>,
  ): Promise<{ tools: ToolInfo[] }> {
    const p = requireUser(principal);
    return { tools: await this.toolInfo.get(org.orgId, id, p.account.id, q.keys) };
  }

  @Post(":id/messages")
  @HttpCode(202)
  @OrgAction("agents.use")
  async postMessage(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZBody(ConversationMessageBodyDto) body: z.infer<typeof MessageBody>,
  ): Promise<{ event: ConversationEvent }> {
    const p = requireUser(principal);
    return {
      event: await this.conversations.postUserMessage(org.orgId, id, p.account.id, {
        text: body.text,
        ...(body.clientMessageId !== undefined && { clientMessageId: body.clientMessageId }),
        ...(body.attachments !== undefined && { attachments: body.attachments }),
        ...(body.files !== undefined && { files: body.files }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.effort !== undefined && { effort: body.effort }),
        ...(body.retryOf !== undefined && { retryOf: body.retryOf }),
        ...(body.skill !== undefined && { skill: body.skill }),
      }),
    };
  }

  /**
   * Queued messages (owner only): `paused` after a run failed or was stopped with items queued, or
   * the head item could not be sent; `pauseReason` says which (absent when not recorded).
   */
  @Get(":id/queue")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async listQueue(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ items: QueueItem[]; paused: boolean; pauseReason?: QueuePauseReason }> {
    const p = requireUser(principal);
    return this.queue.list(org.orgId, id, p.account.id);
  }

  /**
   * Deprecated: behaves as `POST …/messages` (202 `{ event }`): an interjection while a run is
   * active, a new run otherwise; nothing is queued any more. Kept for older clients for one release;
   * the leftover-item routes below keep working until the queue table is dropped (contract step).
   */
  @Post(":id/queue")
  @HttpCode(202)
  @OrgAction("agents.use")
  async enqueue(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @ZBody(ConversationQueueBodyDto) body: z.infer<typeof QueueBody>,
  ): Promise<{ event: ConversationEvent }> {
    const p = requireUser(principal);
    return {
      event: await this.conversations.postUserMessage(org.orgId, id, p.account.id, {
        text: body.text,
        clientMessageId: body.clientMessageId,
        ...(body.attachments !== undefined && { attachments: body.attachments }),
        ...(body.files !== undefined && { files: body.files }),
        ...(body.model !== undefined && { model: body.model }),
        ...(body.effort !== undefined && { effort: body.effort }),
        ...(body.skill !== undefined && { skill: body.skill }),
      }),
    };
  }

  /** "Continue sending" after a pause (202). Declared before `:itemId` routes. */
  @Post(":id/queue/resume")
  @HttpCode(202)
  @OrgAction("agents.use")
  async resumeQueue(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<Record<string, never>> {
    const p = requireUser(principal);
    await this.queue.resume(org.orgId, id, p.account.id);
    return {};
  }

  @Patch(":id/queue/:itemId")
  @OrgAction("agents.use")
  async editQueued(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
    @ZBody(ConversationQueueEditBodyDto) body: z.infer<typeof QueueEditBody>,
  ): Promise<{ item: QueueItem }> {
    const p = requireUser(principal);
    return { item: await this.queue.edit(org.orgId, id, p.account.id, itemId, body.text) };
  }

  @Delete(":id/queue/:itemId")
  @HttpCode(204)
  @OrgAction("agents.use")
  async deleteQueued(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ): Promise<void> {
    const p = requireUser(principal);
    await this.queue.remove(org.orgId, id, p.account.id, itemId);
  }

  /** Sends a queued message now, as an interjection when a run is active (202 `{ event }`). */
  @Post(":id/queue/:itemId/send")
  @HttpCode(202)
  @OrgAction("agents.use")
  async sendQueued(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Param("itemId") itemId: string,
  ): Promise<{ event: ConversationEvent }> {
    const p = requireUser(principal);
    return { event: await this.queue.sendNow(org.orgId, id, p.account.id, itemId) };
  }

  /**
   * Stops the current run (the conversation's owner): 202 `{ runId }`; nothing active → 409
   * `run.not_active`. On a root conversation `runId` is the stopped run, and its background
   * sub-agents keep working. On a sub-agent's conversation (the root's owner, at any depth) the
   * sub-agent stops with every sub-agent below it, and `runId` is the sub-agent's latest run,
   * which may already be finished when only its descendants were working (agent map spec §6).
   */
  @Post(":id/abort")
  @HttpCode(202)
  @OrgAction("agents.use")
  async abort(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<{ runId: string }> {
    const p = requireUser(principal);
    return { runId: await this.conversations.abort(org.orgId, id, p.account.id) };
  }
}
