import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  CONVERSATION_ARTIFACTS,
  CONVERSATION_OUTPUTS,
  CONVERSATION_SANDBOX,
  CONVERSATIONS,
} from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { MAX_ATTACHMENTS } from "../tools/connector-content.js";
import {
  ARTIFACT_DOWNLOAD_CACHE_SECONDS,
  type ArtifactPreview,
  type ConversationArtifacts,
} from "./artifacts.js";
import type {
  ConversationGroup,
  ConversationsService,
  ConversationView,
} from "./conversations.service.js";
import type { ConversationEvent } from "./events.js";
import {
  type ConversationOutputs,
  OUTPUT_PAGE_MAX_CHARS,
  type OutputPage,
} from "./outputs-read.js";
import type { ConversationSandboxStatus, SandboxStatusView } from "./sandbox-status.js";

const CreateBody = z.object({ agentId: z.string().min(1).max(100) }).strict();

const ListQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  /** Only this agent's conversations (the sidebar's per-group "More"). */
  agentId: z.string().min(1).max(100).optional(),
});

const GroupsQuery = z.object({
  perGroup: z.coerce.number().int().min(1).max(20).default(5),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** The last group's agent id from the previous page (`next`). */
  after: z.string().min(1).max(100).optional(),
});

const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

const OutputQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(OUTPUT_PAGE_MAX_CHARS).default(OUTPUT_PAGE_MAX_CHARS),
});

/** `inline=1`：要求以 inline 打开（只对位图生效，见 ConversationArtifacts）。 */
const DownloadQuery = z.object({ inline: z.enum(["0", "1"]).optional() });

const MessageBody = z
  .object({
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
  })
  .strict()
  // `@` 资源的正文按 `content[i + 1]` 对应，`content[0]` 必须是用户文本：带 `@` 资源时文本不能为空
  .refine((b) => b.text.length > 0 || ((b.files?.length ?? 0) > 0 && !b.attachments?.length), {
    message: "Text is required unless the message carries files (and no @ resources)",
    path: ["text"],
  });

/**
 * 会话（`/api/v1/orgs/:orgId/conversations`）：`agents.use`（访客以上），只接受人类用户；
 * 服务令牌 → 403 `forbidden`。只有会话所有者可见，其他人一律 `conversation.not_found`。
 */
@Controller("api/v1/orgs/:orgId/conversations")
export class ConversationsController {
  constructor(
    @Inject(CONVERSATIONS) private readonly conversations: ConversationsService,
    @Inject(CONVERSATION_OUTPUTS) private readonly outputs: ConversationOutputs,
    @Inject(CONVERSATION_ARTIFACTS) private readonly artifacts: ConversationArtifacts,
    @Inject(CONVERSATION_SANDBOX) private readonly sandboxStatus: ConversationSandboxStatus,
  ) {}

  @Post()
  @OrgAction("agents.use")
  async create(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Body(new ZodPipe(CreateBody)) body: z.infer<typeof CreateBody>,
  ): Promise<{ conversation: ConversationView }> {
    const p = requireUser(principal);
    return { conversation: await this.conversations.create(org.orgId, p.account.id, body.agentId) };
  }

  /** 我的会话，最近更新的在前：`next` 为下一页游标（作为 `after` 传回），没有更多时为 null。 */
  @Get()
  @OrgAction("agents.use")
  async list(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Query(new ZodPipe(ListQuery)) q: z.infer<typeof ListQuery>,
  ): Promise<{ conversations: ConversationView[]; next: string | null }> {
    const p = requireUser(principal);
    const rows = await this.conversations.listMine(org.orgId, p.account.id, {
      limit: q.limit + 1,
      ...(q.after !== undefined && { after: q.after }),
      ...(q.agentId !== undefined && { agentId: q.agentId }),
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
    @Query(new ZodPipe(GroupsQuery)) q: z.infer<typeof GroupsQuery>,
  ): Promise<{ groups: ConversationGroup[]; next: string | null }> {
    const p = requireUser(principal);
    return this.conversations.listGroups(org.orgId, p.account.id, {
      perGroup: q.perGroup,
      limit: q.limit,
      ...(q.after !== undefined && { after: q.after }),
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

  /** `after` 之后的事件（seq 升序，最多 `limit` 条）；客户端以最后一条的 seq 作为下一次的 `after`。 */
  @Get(":id/events")
  @OrgAction("agents.use")
  async events(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Query(new ZodPipe(EventsQuery)) q: z.infer<typeof EventsQuery>,
  ): Promise<{ events: ConversationEvent[] }> {
    const p = requireUser(principal);
    return {
      events: await this.conversations.listEvents(org.orgId, id, p.account.id, q.after, q.limit),
    };
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
    @Query(new ZodPipe(OutputQuery)) q: z.infer<typeof OutputQuery>,
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
    @Query(new ZodPipe(DownloadQuery)) q: z.infer<typeof DownloadQuery>,
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
   * 对话沙箱的状态。响应体**不套外层键**，直接是 `{ status: "running" | "suspended", lastUsedAt }`
   * （不同于 `{ preview }`、`{ conversation }` 等；网页 `getSandboxStatus` 按此解析）；
   * 没有可用的沙箱（未创建、已销毁）→ 404 `sandbox.not_found`。可见性与会话流相同。
   */
  @Get(":id/sandbox")
  @Header("cache-control", "private, no-store")
  @OrgAction("agents.use")
  async sandbox(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
  ): Promise<SandboxStatusView> {
    const p = requireUser(principal);
    return this.sandboxStatus.get(org.orgId, id, p.account.id);
  }

  @Post(":id/messages")
  @HttpCode(202)
  @OrgAction("agents.use")
  async postMessage(
    @CurrentPrincipal() principal: Principal,
    @CurrentOrg() org: OrgContext,
    @Param("id") id: string,
    @Body(new ZodPipe(MessageBody)) body: z.infer<typeof MessageBody>,
  ): Promise<{ event: ConversationEvent }> {
    const p = requireUser(principal);
    return {
      event: await this.conversations.postUserMessage(org.orgId, id, p.account.id, {
        text: body.text,
        ...(body.clientMessageId !== undefined && { clientMessageId: body.clientMessageId }),
        ...(body.attachments !== undefined && { attachments: body.attachments }),
        ...(body.files !== undefined && { files: body.files }),
      }),
    };
  }

  /** 中止当前运行（会话所有者）：202 `{ runId }`；没有活跃运行 → 409 `run.not_active`。 */
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
