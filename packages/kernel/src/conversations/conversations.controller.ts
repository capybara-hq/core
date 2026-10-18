import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import { z } from "zod";
import { CONVERSATIONS } from "../http/tokens.js";
import { ZodPipe } from "../http/zod.pipe.js";
import { CurrentPrincipal, type Principal, requireUser } from "../identity/principal.js";
import { CurrentOrg, OrgAction, type OrgContext } from "../orgs/org.guard.js";
import { MAX_ATTACHMENTS } from "../tools/app-content.js";
import type { ConversationsService, ConversationView } from "./conversations.service.js";
import type { ConversationEvent } from "./events.js";

const CreateBody = z.object({ agentId: z.string().min(1).max(100) }).strict();

const ListQuery = z.object({
  after: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const EventsQuery = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(500),
});

const MessageBody = z
  .object({
    text: z.string().min(1).max(100_000),
    clientMessageId: z.string().min(1).max(200).optional(),
    /** `@` 资源引用：内核以发送者的凭据读取并作为附加文本块写入（见 ConversationsService.postUserMessage）。 */
    attachments: z
      .array(z.object({ appId: z.uuid(), uri: z.string().min(1).max(2000) }).strict())
      .max(MAX_ATTACHMENTS)
      .optional(),
  })
  .strict();

/**
 * 会话（`/api/v1/orgs/:orgId/conversations`）：`agents.use`（访客以上），只接受人类用户；
 * 服务令牌 → 403 `forbidden`。只有会话所有者可见，其他人一律 `conversation.not_found`。
 */
@Controller("api/v1/orgs/:orgId/conversations")
export class ConversationsController {
  constructor(@Inject(CONVERSATIONS) private readonly conversations: ConversationsService) {}

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
    });
    const conversations = rows.slice(0, q.limit);
    const next = rows.length > q.limit ? (conversations.at(-1)?.id ?? null) : null;
    return { conversations, next };
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
